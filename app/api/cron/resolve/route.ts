import { NextResponse } from 'next/server'
import {
  makeContractCall,
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
import {
  getSponsorNonce,
  setSponsorNonce,
  clearSponsorNonce,
  acquireSponsorLock,
  releaseSponsorLock,
} from '@/lib/pool-store'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

const CONTRACT_ADDRESS = 'ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK'
const CONTRACT_NAME = 'predixv2'
import { HIRO_API, hiroHeaders } from '@/lib/hiro'
const PYTH_BENCHMARKS = 'https://benchmarks.pyth.network'
const TX_FEE = BigInt(50000) // 0.05 STX

interface RoundData {
  totalUp: number
  totalDown: number
  priceStart: number
  priceEnd: number
  resolved: boolean
}

interface BetData {
  amount: number
  claimed: boolean
}

interface LogEntry {
  action: string
  detail: string
  txId?: string
  error?: string
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

async function fetchJson(url: string, options: RequestInit = {}): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    ...options,
    headers: { ...hiroHeaders(), ...(options.headers as Record<string, string>) },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
  return res.json() as Promise<Record<string, unknown>>
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// WALLET
// ---------------------------------------------------------------------------

async function initWallet() {
  const mnemonic = process.env.ORACLE_MNEMONIC
  if (!mnemonic) throw new Error('ORACLE_MNEMONIC not configured')

  const wallet = await generateWallet({ secretKey: mnemonic, password: '' })
  const account = wallet.accounts[0]
  const privateKey = account.stxPrivateKey
  const address = getStxAddress({ account, network: 'testnet' })

  return { privateKey, address }
}

async function getNonce(address: string): Promise<number> {
  const data = await fetchJson(`${HIRO_API}/extended/v1/address/${address}/nonces`)
  return (data as { possible_next_nonce: number }).possible_next_nonce
}

// ---------------------------------------------------------------------------
// BROADCAST
// ---------------------------------------------------------------------------

/**
 * Broadcast with automatic nonce retry — handles ghost txs in node mempool.
 * Returns { txId, nonce } where nonce is the next available nonce after broadcast.
 */
async function broadcastWithRetry(
  buildTx: (nonce: bigint) => Promise<{ serialize: () => string; txid: () => string }>,
  startNonce: number,
  maxRetries = 3
): Promise<{ txId: string; nextNonce: number }> {
  let nonce = startNonce

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const tx = await buildTx(BigInt(nonce))
    const hexTx = tx.serialize()
    const binaryTx = Buffer.from(hexTx, 'hex')

    const res = await fetch(`${HIRO_API}/v2/transactions`, {
      method: 'POST',
      headers: hiroHeaders({ 'Content-Type': 'application/octet-stream' }),
      body: binaryTx,
    })
    const text = await res.text()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any
    try { data = JSON.parse(text) } catch { data = { txid: text.trim().replace(/"/g, '') } }

    if (data.error) {
      const reason = data.reason as string
      const reasonData = data.reason_data as { expected?: number } | undefined

      if ((reason === 'BadNonce' || reason === 'ConflictingNonceInMempool') && attempt < maxRetries) {
        if (reasonData?.expected != null) {
          nonce = reasonData.expected
          console.log(`[cron] Nonce error (${reason}), retrying with nonce=${nonce}`)
          continue
        }
        nonce++
        console.log(`[cron] Nonce conflict, retrying with nonce=${nonce}`)
        continue
      }

      throw new Error(`Broadcast failed: ${data.error} — ${reason}`)
    }

    const txId = data.txid || data || tx.txid()
    return { txId, nextNonce: nonce + 1 }
  }

  throw new Error('Exhausted nonce retries')
}

async function waitForMempool(txId: string, maxWaitMs = 5000): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    try {
      const data = await fetchJson(`${HIRO_API}/extended/v1/tx/${txId}`)
      if ((data as { tx_status?: string }).tx_status) {
        return (data as { tx_status: string }).tx_status
      }
    } catch { /* not found yet */ }
    await sleep(1500)
  }
  return 'pending'
}

// ---------------------------------------------------------------------------
// ON-CHAIN READS
// ---------------------------------------------------------------------------

async function readRound(roundId: number): Promise<RoundData | null> {
  const keyHex = cvToHex(tupleCV({ 'round-id': uintCV(roundId) }))
  try {
    const data = await fetchJson(
      `${HIRO_API}/v2/map_entry/${CONTRACT_ADDRESS}/${CONTRACT_NAME}/rounds?proof=0`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(keyHex),
      }
    )
    if (!data.data) return null
    const cv = hexToCV(data.data as string)
    const json = cvToJSON(cv)
    // cvToJSON wraps map entries as optional(tuple(...)) — need .value.value to unwrap both
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = (json as any).value?.value
    if (v === null || v === undefined) return null
    return {
      totalUp: Number(v['total-up']?.value ?? 0),
      totalDown: Number(v['total-down']?.value ?? 0),
      priceStart: Number(v['price-start']?.value ?? 0),
      priceEnd: Number(v['price-end']?.value ?? 0),
      resolved: v.resolved?.value === true || String(v.resolved?.value) === 'true',
    }
  } catch {
    return null
  }
}

async function readRoundBettors(roundId: number): Promise<string[]> {
  try {
    const data = await fetchJson(
      `${HIRO_API}/v2/contracts/call-read/${CONTRACT_ADDRESS}/${CONTRACT_NAME}/get-round-bettors`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: CONTRACT_ADDRESS,
          arguments: [cvToHex(uintCV(roundId))],
        }),
      }
    )
    if (!data.result) return []
    const cv = hexToCV(data.result as string)
    const json = cvToJSON(cv)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bettorsList = (json as any).value?.bettors?.value
    if (!Array.isArray(bettorsList)) return []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return bettorsList.map((b: any) => b.value)
  } catch {
    return []
  }
}

async function readUserBets(roundId: number, bettor: string): Promise<{ up: BetData | null; down: BetData | null }> {
  try {
    const data = await fetchJson(
      `${HIRO_API}/v2/contracts/call-read/${CONTRACT_ADDRESS}/${CONTRACT_NAME}/get-user-bets`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: CONTRACT_ADDRESS,
          arguments: [
            cvToHex(uintCV(roundId)),
            cvToHex(standardPrincipalCV(bettor)),
          ],
        }),
      }
    )
    if (!data.result) return { up: null, down: null }
    const cv = hexToCV(data.result as string)
    const json = cvToJSON(cv)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = (json as any).value

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parseSide = (side: any): BetData | null => {
      if (!side || side.value === null || side.value === undefined) return null
      // Optional(tuple) needs .value.value to unwrap both layers
      const sv = side.value?.value ?? side.value
      if (!sv) return null
      return {
        amount: Number(sv.amount?.value ?? 0),
        claimed: sv.claimed?.value === true || String(sv.claimed?.value) === 'true',
      }
    }

    return {
      up: parseSide(v?.up),
      down: parseSide(v?.down),
    }
  } catch {
    return { up: null, down: null }
  }
}

// ---------------------------------------------------------------------------
// PYTH PRICES
// ---------------------------------------------------------------------------

function findClosestCandleIndex(timestamps: number[], target: number): number {
  let closest = 0
  let minDiff = Math.abs(timestamps[0] - target)
  for (let i = 1; i < timestamps.length; i++) {
    const diff = Math.abs(timestamps[i] - target)
    if (diff < minDiff) {
      minDiff = diff
      closest = i
    }
  }
  return closest
}

async function fetchRoundPrices(roundId: number): Promise<{ priceStart: number; priceEnd: number }> {
  const roundStartTs = roundId * 60
  const roundEndTs = (roundId + 1) * 60

  const url = `${PYTH_BENCHMARKS}/v1/shims/tradingview/history?symbol=Crypto.BTC/USD&resolution=1&from=${roundStartTs - 120}&to=${roundEndTs + 120}`
  const data = await fetchJson(url) as { s: string; t?: number[]; o?: number[]; c?: number[] }

  if (data.s !== 'ok' || !data.t || data.t.length === 0) {
    throw new Error(`Pyth returned no data for round ${roundId}`)
  }

  const startIdx = findClosestCandleIndex(data.t, roundStartTs)
  const endIdx = findClosestCandleIndex(data.t, roundEndTs)

  let priceStart: number, priceEnd: number
  if (startIdx === endIdx) {
    priceStart = data.o![startIdx]
    priceEnd = data.c![endIdx]
  } else {
    priceStart = data.c![startIdx]
    priceEnd = data.c![endIdx]
  }

  return {
    priceStart: Math.round(priceStart * 100),
    priceEnd: Math.round(priceEnd * 100),
  }
}

// ---------------------------------------------------------------------------
// PROCESS ROUND
// ---------------------------------------------------------------------------

async function processRound(
  roundId: number,
  nonce: number,
  privateKey: string,
  log: LogEntry[]
): Promise<number> {
  let currentNonce = nonce

  // 1. Read round on-chain
  const round = await readRound(roundId)
  if (!round || (round.totalUp + round.totalDown === 0)) {
    log.push({ action: 'skip', detail: `Round ${roundId}: empty or not found` })
    return currentNonce
  }

  log.push({
    action: 'read',
    detail: `Round ${roundId}: UP=$${(round.totalUp / 1e6).toFixed(2)} DOWN=$${(round.totalDown / 1e6).toFixed(2)} resolved=${round.resolved}`,
  })

  let priceStart: number, priceEnd: number

  if (!round.resolved) {
    // 2. Fetch Pyth prices
    try {
      const prices = await fetchRoundPrices(roundId)
      priceStart = prices.priceStart
      priceEnd = prices.priceEnd
    } catch (e) {
      log.push({ action: 'error', detail: `Round ${roundId}: Pyth prices unavailable`, error: String(e) })
      return currentNonce
    }

    const outcome = priceEnd > priceStart ? 'UP' : 'DOWN'
    log.push({ action: 'prices', detail: `start=${priceStart} end=${priceEnd} outcome=${outcome}` })

    // 3. Try resolve-round (may fail on-chain if Stacks block time is behind)
    //    Even if this fails, claim-on-behalf has a safety net that resolves without block time check
    try {
      const { txId, nextNonce } = await broadcastWithRetry(
        (nonce) => makeContractCall({
          contractAddress: CONTRACT_ADDRESS,
          contractName: CONTRACT_NAME,
          functionName: 'resolve-round',
          functionArgs: [uintCV(roundId), uintCV(priceStart), uintCV(priceEnd)],
          senderKey: privateKey,
          network: STACKS_TESTNET,
          fee: TX_FEE,
          nonce,
        }),
        currentNonce
      )
      log.push({ action: 'resolve-round', detail: `Round ${roundId}`, txId })
      await waitForMempool(txId)
      currentNonce = nextNonce
    } catch (e) {
      // Don't return early — continue to claims which can resolve the round via safety net
      log.push({ action: 'warn', detail: `resolve-round broadcast failed for ${roundId}, will try claim-on-behalf`, error: String(e) })
    }
  } else {
    priceStart = round.priceStart
    priceEnd = round.priceEnd
    log.push({ action: 'already-resolved', detail: `Round ${roundId}: start=${priceStart} end=${priceEnd}` })
  }

  // 4. Read bettors
  const bettors = await readRoundBettors(roundId)
  if (bettors.length === 0) {
    log.push({ action: 'skip', detail: `Round ${roundId}: no bettors` })
    return currentNonce
  }

  log.push({ action: 'bettors', detail: `${bettors.length} bettor(s) found` })

  // 5. Claim on behalf of each bettor
  for (const bettor of bettors) {
    const userBets = await readUserBets(roundId, bettor)

    for (const side of ['UP', 'DOWN'] as const) {
      const bet = side === 'UP' ? userBets.up : userBets.down
      if (!bet || bet.claimed) continue

      try {
        const { txId, nextNonce } = await broadcastWithRetry(
          (nonce) => makeContractCall({
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
          currentNonce
        )
        log.push({ action: 'claim-on-behalf', detail: `${bettor.slice(0, 8)}... ${side}`, txId })
        await waitForMempool(txId)
        currentNonce = nextNonce
      } catch (e) {
        log.push({ action: 'error', detail: `claim-on-behalf ${bettor.slice(0, 8)}... ${side}`, error: String(e) })
      }
    }
  }

  return currentNonce
}

// ---------------------------------------------------------------------------
// ROUTE HANDLER
// ---------------------------------------------------------------------------

export async function GET(req: Request) {
  // Authenticate: Vercel Cron sends Authorization header with CRON_SECRET
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const log: LogEntry[] = []
  const startTime = Date.now()

  try {
    // Init wallet
    const { privateKey, address } = await initWallet()
    log.push({ action: 'init', detail: `Wallet: ${address}` })

    // Verify wallet matches contract DEPLOYER
    if (address !== CONTRACT_ADDRESS) {
      log.push({ action: 'fatal', detail: `Wallet ${address} does NOT match DEPLOYER ${CONTRACT_ADDRESS}` })
      return NextResponse.json({ ok: false, duration: Date.now() - startTime, log })
    }

    // Acquire sponsor lock so cron and sponsor endpoint don't compete for nonces
    const gotLock = await acquireSponsorLock(10000) // longer timeout for cron
    if (!gotLock) {
      log.push({ action: 'skip', detail: 'Could not acquire sponsor lock (sponsor endpoint busy)' })
      return NextResponse.json({ ok: false, duration: Date.now() - startTime, log })
    }

    try {
      // Use shared KV nonce tracker (same as sponsor endpoint)
      const tracked = await getSponsorNonce()
      let nonce: number
      if (tracked) {
        nonce = Number(tracked.nonce)
        log.push({ action: 'nonce', detail: `KV tracked nonce: ${nonce}` })
      } else {
        nonce = await getNonce(address)
        log.push({ action: 'nonce', detail: `API nonce (no KV): ${nonce}` })
      }

      // Scan recent rounds (last SCAN_BACK rounds) to catch any missed ones
      const SCAN_BACK = 10
      const currentRoundId = Math.floor(Date.now() / 60000)

      log.push({ action: 'scan', detail: `Rounds ${currentRoundId - SCAN_BACK} to ${currentRoundId - 1}` })

      for (let i = SCAN_BACK; i >= 1; i--) {
        const roundId = currentRoundId - i
        nonce = await processRound(roundId, nonce, privateKey, log)
      }

      // Persist final nonce to KV so sponsor endpoint picks it up
      await setSponsorNonce(BigInt(nonce))
      log.push({ action: 'nonce', detail: `KV nonce updated to ${nonce}` })
    } catch (e) {
      // Clear stale nonce on error so sponsor endpoint re-fetches from API
      await clearSponsorNonce()
      throw e
    } finally {
      await releaseSponsorLock()
    }

  } catch (e) {
    log.push({ action: 'fatal', detail: 'Unhandled error', error: e instanceof Error ? e.message : String(e) })
  }

  const duration = Date.now() - startTime
  return NextResponse.json({ ok: true, duration, log })
}
