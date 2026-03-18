#!/usr/bin/env node
/**
 * One-shot recovery script: scan on-chain for unresolved rounds with bets,
 * then re-add them to KV `rounds-with-bets` so the cron can settle them.
 *
 * Usage: node scripts/recover-rounds.mjs [hoursBack]
 *   hoursBack defaults to 3
 *
 * Reads .env.local for HIRO_API_KEY, UPSTASH credentials, and contract config.
 */

import 'dotenv/config'
import { Redis } from '@upstash/redis'

const CONTRACT_ADDRESS = 'ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK'
const CONTRACT_NAME = 'predixv8'
const HIRO_API = 'https://api.testnet.hiro.so'
const HIRO_KEY = process.env.HIRO_API_KEY || ''

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

function headers() {
  const h = { 'Content-Type': 'application/json' }
  if (HIRO_KEY) h['x-hiro-api-key'] = HIRO_KEY
  return h
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

async function readRound(roundId) {
  // Build Clarity tuple key hex
  const { cvToHex, tupleCV, uintCV, hexToCV, cvToJSON } = await import('@stacks/transactions')
  const keyHex = cvToHex(tupleCV({ 'round-id': uintCV(roundId) }))

  const res = await fetch(
    `${HIRO_API}/v2/map_entry/${CONTRACT_ADDRESS}/${CONTRACT_NAME}/rounds?proof=0`,
    { method: 'POST', headers: headers(), body: JSON.stringify(keyHex) }
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  if (!data.data) return null

  const cv = hexToCV(data.data)
  const json = cvToJSON(cv)
  const v = json?.value?.value
  if (!v) return null

  return {
    totalUp: Number(v['total-up']?.value ?? 0),
    totalDown: Number(v['total-down']?.value ?? 0),
    priceStart: Number(v['price-start']?.value ?? 0),
    priceEnd: Number(v['price-end']?.value ?? 0),
    resolved: v.resolved?.value === true || String(v.resolved?.value) === 'true',
  }
}

async function main() {
  const hoursBack = parseInt(process.argv[2] || '3', 10)
  const currentRoundId = Math.floor(Date.now() / 60000)
  const startRound = currentRoundId - hoursBack * 60
  const totalRounds = currentRoundId - startRound

  console.log(`Scanning ${totalRounds} rounds (${hoursBack}h back): ${startRound} -> ${currentRoundId}`)
  console.log()

  const pending = []
  const BATCH = 10 // parallel batch size

  for (let i = 0; i < totalRounds; i += BATCH) {
    const batch = []
    for (let j = 0; j < BATCH && (i + j) < totalRounds; j++) {
      batch.push(startRound + i + j)
    }

    const results = await Promise.all(
      batch.map(id => readRound(id).then(r => ({ id, round: r })).catch(e => {
        console.warn(`  R${id}: error ${e.message}`)
        return { id, round: null }
      }))
    )

    for (const { id, round } of results) {
      if (!round) continue
      if (round.totalUp + round.totalDown === 0) continue

      const vol = ((round.totalUp + round.totalDown) / 1e6).toFixed(2)
      if (round.resolved) {
        // Already resolved, skip
      } else {
        console.log(`  R${id}: PENDING  UP=$${(round.totalUp/1e6).toFixed(2)} DOWN=$${(round.totalDown/1e6).toFixed(2)} vol=$${vol}`)
        pending.push(id)
      }
    }

    // Throttle: 200ms between batches to stay under rate limits
    if (i + BATCH < totalRounds) await sleep(200)

    // Progress
    const pct = Math.min(100, Math.round((i + BATCH) / totalRounds * 100))
    process.stdout.write(`\r  Scanned ${Math.min(i + BATCH, totalRounds)}/${totalRounds} (${pct}%)`)
  }

  console.log('\n')

  if (pending.length === 0) {
    console.log('No pending rounds found. All settled!')
    return
  }

  console.log(`Found ${pending.length} pending round(s): [${pending.join(', ')}]`)
  console.log('Re-adding to KV rounds-with-bets...')

  for (const id of pending) {
    await redis.zadd('rounds-with-bets', { score: id, member: String(id) })
    console.log(`  Added R${id}`)
  }

  console.log('\nDone! Cron will pick them up on the next run.')
}

main().catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})
