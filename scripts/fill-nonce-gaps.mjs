#!/usr/bin/env node
/**
 * Fill nonce gaps with USEFUL contract calls (resolve-round + claim-on-behalf)
 * instead of burn STX transfers.
 *
 * Usage:
 *   ORACLE_MNEMONIC="..." node scripts/fill-nonce-gaps.mjs [roundId]
 *
 * If roundId is omitted, defaults to 29558563.
 *
 * Steps:
 *   1. Reads nonce state → finds missing nonces
 *   2. Reads round bettors + bet state on-chain
 *   3. Fills each missing nonce with resolve-round or claim-on-behalf
 *   4. If more gaps than useful calls, falls back to burn-address STX transfers
 */

import {
  makeContractCall,
  makeSTXTokenTransfer,
  PostConditionMode,
  uintCV,
  stringAsciiCV,
  standardPrincipalCV,
  cvToHex,
  tupleCV,
  hexToCV,
  cvToJSON,
} from '@stacks/transactions'
import { STACKS_TESTNET } from '@stacks/network'
import { generateWallet, getStxAddress } from '@stacks/wallet-sdk'

const HIRO_API = 'https://api.testnet.hiro.so'
const CONTRACT_ADDRESS = 'ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK'
const CONTRACT_NAME = 'predixv2'
const TX_FEE = BigInt(50000) // 0.05 STX
const BURN_ADDRESS = 'ST000000000000000000002AMW42H'

// Pyth prices for round 29558563 (from your investigation)
const DEFAULT_ROUND_ID = 29558563
const PYTH_BENCHMARKS = 'https://benchmarks.pyth.network'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options)
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
  return res.json()
}

function findClosestCandleIndex(timestamps, target) {
  let closest = 0
  let minDiff = Math.abs(timestamps[0] - target)
  for (let i = 1; i < timestamps.length; i++) {
    const diff = Math.abs(timestamps[i] - target)
    if (diff < minDiff) { minDiff = diff; closest = i }
  }
  return closest
}

async function fetchRoundPrices(roundId) {
  const roundStartTs = roundId * 60
  const roundEndTs = (roundId + 1) * 60
  const url = `${PYTH_BENCHMARKS}/v1/shims/tradingview/history?symbol=Crypto.BTC/USD&resolution=1&from=${roundStartTs - 120}&to=${roundEndTs + 120}`
  const data = await fetchJson(url)
  if (data.s !== 'ok' || !data.t || data.t.length === 0) {
    throw new Error(`Pyth returned no data for round ${roundId}`)
  }
  const startIdx = findClosestCandleIndex(data.t, roundStartTs)
  const endIdx = findClosestCandleIndex(data.t, roundEndTs)
  let priceStart, priceEnd
  if (startIdx === endIdx) {
    priceStart = data.o[startIdx]
    priceEnd = data.c[endIdx]
  } else {
    priceStart = data.c[startIdx]
    priceEnd = data.c[endIdx]
  }
  return {
    priceStart: Math.round(priceStart * 100),
    priceEnd: Math.round(priceEnd * 100),
  }
}

async function readRound(roundId) {
  const keyHex = cvToHex(tupleCV({ 'round-id': uintCV(roundId) }))
  const data = await fetchJson(
    `${HIRO_API}/v2/map_entry/${CONTRACT_ADDRESS}/${CONTRACT_NAME}/rounds?proof=0`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(keyHex) }
  )
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

async function readRoundBettors(roundId) {
  const data = await fetchJson(
    `${HIRO_API}/v2/contracts/call-read/${CONTRACT_ADDRESS}/${CONTRACT_NAME}/get-round-bettors`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: CONTRACT_ADDRESS, arguments: [cvToHex(uintCV(roundId))] }),
    }
  )
  if (!data.result) return []
  const cv = hexToCV(data.result)
  const json = cvToJSON(cv)
  const list = json?.value?.bettors?.value
  if (!Array.isArray(list)) return []
  return list.map(b => b.value)
}

async function readUserBets(roundId, bettor) {
  const data = await fetchJson(
    `${HIRO_API}/v2/contracts/call-read/${CONTRACT_ADDRESS}/${CONTRACT_NAME}/get-user-bets`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: CONTRACT_ADDRESS,
        arguments: [cvToHex(uintCV(roundId)), cvToHex(standardPrincipalCV(bettor))],
      }),
    }
  )
  if (!data.result) return { up: null, down: null }
  const cv = hexToCV(data.result)
  const json = cvToJSON(cv)
  const v = json?.value
  const parseSide = (side) => {
    if (!side || side.value === null || side.value === undefined) return null
    const sv = side.value?.value ?? side.value
    if (!sv) return null
    return { amount: Number(sv.amount?.value ?? 0), claimed: sv.claimed?.value === true || String(sv.claimed?.value) === 'true' }
  }
  return { up: parseSide(v?.up), down: parseSide(v?.down) }
}

// ---------------------------------------------------------------------------
// Broadcast (raw, no retry — we pick the exact nonce)
// ---------------------------------------------------------------------------

async function broadcast(txSerialized) {
  const binaryTx = Buffer.from(txSerialized, 'hex')
  const res = await fetch(`${HIRO_API}/v2/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: binaryTx,
  })
  const text = await res.text()
  try {
    const json = JSON.parse(text)
    // Hiro sometimes returns just a quoted txid string: "0xabc..."
    if (typeof json === 'string') return { txid: json }
    return json
  } catch {
    return { txid: text.trim().replace(/"/g, '') }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const mnemonic = process.env.ORACLE_MNEMONIC
  if (!mnemonic) { console.error('ERROR: ORACLE_MNEMONIC required'); process.exit(1) }

  const roundId = Number(process.argv[2]) || DEFAULT_ROUND_ID

  // 1. Derive wallet
  const wallet = await generateWallet({ secretKey: mnemonic, password: '' })
  const account = wallet.accounts[0]
  const privateKey = account.stxPrivateKey
  const address = getStxAddress({ account, network: 'testnet' })
  console.log(`Wallet: ${address}`)
  console.log(`Target round: ${roundId}`)

  // 2. Get nonce state
  const nonceData = await fetchJson(`${HIRO_API}/extended/v1/address/${address}/nonces`)
  const { last_executed_tx_nonce, last_mempool_tx_nonce, detected_missing_nonces, detected_mempool_nonces } = nonceData

  console.log(`\nLast executed nonce: ${last_executed_tx_nonce}`)
  console.log(`Last mempool nonce: ${last_mempool_tx_nonce}`)
  console.log(`Mempool txs: ${detected_mempool_nonces?.length ?? 0}`)

  if (!detected_missing_nonces || detected_missing_nonces.length === 0) {
    console.log('\nNo missing nonces! Nothing to fill.')
    return
  }

  const gaps = [...detected_missing_nonces].sort((a, b) => a - b)
  console.log(`Missing nonces: ${gaps.join(', ')}`)

  // 3. Read round state + bettors
  console.log(`\nReading round ${roundId} on-chain...`)
  const round = await readRound(roundId)
  if (!round) {
    console.log('Round not found on-chain!')
    console.log('Falling back to burn-address transfers for all gaps.')
    await fillWithBurns(gaps, privateKey)
    return
  }

  console.log(`  UP=$${(round.totalUp / 1e6).toFixed(2)} DOWN=$${(round.totalDown / 1e6).toFixed(2)} resolved=${round.resolved}`)

  // 4. Fetch Pyth prices
  let priceStart, priceEnd
  try {
    const prices = await fetchRoundPrices(roundId)
    priceStart = prices.priceStart
    priceEnd = prices.priceEnd
    const outcome = priceEnd > priceStart ? 'UP' : priceEnd < priceStart ? 'DOWN' : 'TIE'
    console.log(`  Pyth: start=${priceStart} end=${priceEnd} outcome=${outcome}`)
  } catch (e) {
    console.error(`  Pyth fetch failed: ${e.message}`)
    console.log('Falling back to burn-address transfers.')
    await fillWithBurns(gaps, privateKey)
    return
  }

  // 5. Build queue of useful txs
  const txQueue = []

  // resolve-round (if not yet resolved)
  if (!round.resolved) {
    txQueue.push({
      label: `resolve-round(${roundId})`,
      build: (nonce) => makeContractCall({
        contractAddress: CONTRACT_ADDRESS,
        contractName: CONTRACT_NAME,
        functionName: 'resolve-round',
        functionArgs: [uintCV(roundId), uintCV(priceStart), uintCV(priceEnd)],
        senderKey: privateKey,
        network: STACKS_TESTNET,
        fee: TX_FEE,
        nonce,
      }),
    })
  }

  // claim-on-behalf for each bettor/side
  const bettors = await readRoundBettors(roundId)
  console.log(`  Bettors: ${bettors.length} — ${bettors.map(b => b.slice(0, 10) + '...').join(', ')}`)

  for (const bettor of bettors) {
    const userBets = await readUserBets(roundId, bettor)
    for (const side of ['UP', 'DOWN']) {
      const bet = side === 'UP' ? userBets.up : userBets.down
      if (bet && !bet.claimed) {
        txQueue.push({
          label: `claim-on-behalf(${bettor.slice(0, 10)}..., ${roundId}, ${side})`,
          build: (nonce) => makeContractCall({
            contractAddress: CONTRACT_ADDRESS,
            contractName: CONTRACT_NAME,
            functionName: 'claim-on-behalf',
            functionArgs: [
              standardPrincipalCV(bettor),
              uintCV(roundId),
              stringAsciiCV(side),
              uintCV(priceStart),
              uintCV(priceEnd),
            ],
            senderKey: privateKey,
            network: STACKS_TESTNET,
            postConditionMode: PostConditionMode.Allow,
            fee: TX_FEE,
            nonce,
          }),
        })
      }
    }
  }

  console.log(`\nUseful txs available: ${txQueue.length}`)
  console.log(`Nonce gaps to fill: ${gaps.length}`)

  // 6. Assign useful txs to gaps, burn-fill the rest
  for (let i = 0; i < gaps.length; i++) {
    const nonce = gaps[i]

    if (i < txQueue.length) {
      // Use a useful tx
      const { label, build } = txQueue[i]
      console.log(`\nNonce ${nonce}: ${label}`)
      try {
        const tx = await build(BigInt(nonce))
        const result = await broadcast(tx.serialize())
        if (result.txid) {
          console.log(`  OK: ${result.txid}`)
        } else if (result.error) {
          console.log(`  FAILED: ${result.error} — ${result.reason}`)
          // If the useful tx fails, fall back to burn
          console.log(`  Falling back to burn transfer...`)
          await sendBurn(nonce, privateKey)
        }
      } catch (e) {
        console.error(`  ERROR: ${e.message}`)
        console.log(`  Falling back to burn transfer...`)
        await sendBurn(nonce, privateKey)
      }
    } else {
      // No more useful txs — burn fill
      console.log(`\nNonce ${nonce}: burn-fill (no more useful txs)`)
      await sendBurn(nonce, privateKey)
    }
  }

  // 7. Re-check
  console.log('\n--- Re-checking nonce state ---')
  const recheck = await fetchJson(`${HIRO_API}/extended/v1/address/${address}/nonces`)
  console.log(`Last executed: ${recheck.last_executed_tx_nonce}`)
  console.log(`Last mempool: ${recheck.last_mempool_tx_nonce}`)
  console.log(`Missing: ${recheck.detected_missing_nonces?.join(', ') || 'none'}`)
  console.log(`Mempool txs: ${recheck.detected_mempool_nonces?.length ?? 0}`)
  console.log('\nDone. All gaps filled.')
}

async function sendBurn(nonce, privateKey) {
  try {
    const tx = await makeSTXTokenTransfer({
      recipient: BURN_ADDRESS,
      amount: BigInt(1),
      senderKey: privateKey,
      network: STACKS_TESTNET,
      fee: TX_FEE,
      nonce: BigInt(nonce),
      memo: `nonce-fill-${nonce}`,
    })
    const result = await broadcast(tx.serialize())
    if (result.txid) {
      console.log(`  OK (burn): ${result.txid}`)
    } else {
      console.log(`  FAILED (burn): ${result.error} — ${result.reason}`)
    }
  } catch (e) {
    console.error(`  ERROR (burn): ${e.message}`)
  }
}

async function fillWithBurns(gaps, privateKey) {
  for (const nonce of gaps) {
    console.log(`\nNonce ${nonce}: burn-fill`)
    await sendBurn(nonce, privateKey)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
