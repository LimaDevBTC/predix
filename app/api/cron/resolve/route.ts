import { NextResponse } from 'next/server'
import {
  makeContractCall,
  PostConditionMode,
  uintCV,
  cvToHex,
  tupleCV,
  hexToCV,
  cvToJSON,
} from '@stacks/transactions'
import { STACKS_TESTNET, STACKS_MAINNET } from '@stacks/network'
import { generateWallet, getStxAddress } from '@stacks/wallet-sdk'
import { NETWORK_NAME, GATEWAY_CONTRACT, BITPREDIX_CONTRACT, splitContractId } from '@/lib/config'
import { HIRO_API, hiroHeaders, disableApiKey } from '@/lib/hiro'
import { alert } from '@/lib/alerting'
import { creditTicketsAfterSettlement } from '@/lib/jackpot'
import {
  getSponsorNonce,
  setSponsorNonce,
  clearSponsorNonce,
  acquireSponsorLock,
  releaseSponsorLock,
  getRoundsWithBets,
  removeResolvedRound,
  getActiveUserCount,
  getRoundBettorValidity,
} from '@/lib/pool-store'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

const [GATEWAY_ADDRESS, GATEWAY_NAME] = splitContractId(GATEWAY_CONTRACT)
const [CONTRACT_ADDRESS, CONTRACT_NAME] = splitContractId(BITPREDIX_CONTRACT)
const STACKS_NETWORK = NETWORK_NAME === 'mainnet' ? STACKS_MAINNET : STACKS_TESTNET
const PYTH_BENCHMARKS = 'https://benchmarks.pyth.network'
const TX_FEE = BigInt(process.env.SPONSOR_TX_FEE || '50000')

// Circuit breaker thresholds
const PRICE_CHANGE_THRESHOLD = parseFloat(process.env.PRICE_CHANGE_THRESHOLD || '0.005')
const PRICE_DIVERGENCE_THRESHOLD = 0.003 // 0.3% Hermes vs Benchmarks
const PRICE_SANE_MIN = 10_000 * 100 // $10k in cents
const PRICE_SANE_MAX = 500_000 * 100 // $500k in cents

// Consecutive circuit breaker failures tracking
let circuitBreakerFailures = 0

interface RoundData {
  totalUp: number
  totalDown: number
  priceStart: number
  priceEnd: number
  resolved: boolean
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

async function fetchJson(url: string, options: RequestInit = {}, retries = 2): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      ...options,
      headers: { ...hiroHeaders(), ...(options.headers as Record<string, string>) },
    })
    if (res.status === 429) {
      const remaining = res.headers.get('x-ratelimit-remaining-stacks-month')
      if (remaining === '0' || remaining === '-1') {
        disableApiKey()
        continue
      }
      if (attempt < retries) {
        await sleep(500 * (attempt + 1))
        continue
      }
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
    return res.json() as Promise<Record<string, unknown>>
  }
  throw new Error(`Exhausted retries for ${url}`)
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// WALLET
// ---------------------------------------------------------------------------

async function initWallet() {
  const mnemonic = process.env.SPONSOR_MNEMONIC || process.env.ORACLE_MNEMONIC
  if (!mnemonic) throw new Error('SPONSOR_MNEMONIC not configured')

  const wallet = await generateWallet({ secretKey: mnemonic, password: '' })
  const account = wallet.accounts[0]
  const privateKey = account.stxPrivateKey
  const address = getStxAddress({ account, network: NETWORK_NAME })

  return { privateKey, address }
}

async function getNonce(address: string): Promise<number> {
  const data = await fetchJson(`${HIRO_API}/extended/v1/address/${address}/nonces`)
  return (data as { possible_next_nonce: number }).possible_next_nonce
}

// ---------------------------------------------------------------------------
// BROADCAST
// ---------------------------------------------------------------------------

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

async function fetchCurrentHermesPrice(): Promise<number> {
  try {
    const res = await fetch('https://hermes.pyth.network/v2/updates/price/latest?ids[]=e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43')
    const data = await res.json() as { parsed?: Array<{ price?: { price?: string; expo?: number } }> }
    const p = data.parsed?.[0]?.price
    if (p?.price && p?.expo !== undefined) {
      return parseFloat(p.price) * Math.pow(10, p.expo) * 100 // to cents
    }
  } catch { /* fallback */ }
  return 0
}

// ---------------------------------------------------------------------------
// CIRCUIT BREAKER
// ---------------------------------------------------------------------------

async function validatePrices(priceStart: number, priceEnd: number): Promise<{ valid: boolean; reason?: string }> {
  // 1. Excessive change in 60s
  const change = Math.abs(priceEnd - priceStart) / priceStart
  if (change > PRICE_CHANGE_THRESHOLD) {
    return { valid: false, reason: `Price change ${(change * 100).toFixed(2)}% exceeds ${PRICE_CHANGE_THRESHOLD * 100}% threshold` }
  }

  // 2. Cross-check: Benchmarks vs Hermes
  const hermesPrice = await fetchCurrentHermesPrice()
  if (hermesPrice > 0) {
    const divergence = Math.abs(hermesPrice - priceEnd) / hermesPrice
    if (divergence > PRICE_DIVERGENCE_THRESHOLD) {
      return { valid: false, reason: `Hermes/Benchmark divergence ${(divergence * 100).toFixed(2)}% exceeds ${PRICE_DIVERGENCE_THRESHOLD * 100}% threshold` }
    }
  }

  // 3. Sanity: price in reasonable BTC range
  if (priceEnd < PRICE_SANE_MIN || priceEnd > PRICE_SANE_MAX) {
    return { valid: false, reason: `Price ${priceEnd} outside sane range ($10k-$500k)` }
  }

  return { valid: true }
}

// ---------------------------------------------------------------------------
// PROCESS ROUND — resolve-and-distribute via gateway (one atomic call)
// ---------------------------------------------------------------------------

async function processRound(
  roundId: number,
  nonce: number,
  privateKey: string,
  log: LogEntry[]
): Promise<number> {
  let currentNonce = nonce

  const clog = (entry: LogEntry) => {
    log.push(entry)
    console.log(`[cron] R${roundId} ${entry.action}: ${entry.detail}${entry.txId ? ` tx=${entry.txId}` : ''}${entry.error ? ` ERR=${entry.error}` : ''}`)
  }

  // 1. Read round on-chain
  const round = await readRound(roundId)
  if (!round || (round.totalUp + round.totalDown === 0)) {
    return currentNonce
  }

  // Already resolved — nothing to do (resolve-and-distribute is atomic)
  if (round.resolved) {
    clog({ action: 'already-resolved', detail: `start=${round.priceStart} end=${round.priceEnd}` })
    return currentNonce
  }

  clog({
    action: 'found',
    detail: `UP=$${(round.totalUp / 1e6).toFixed(2)} DOWN=$${(round.totalDown / 1e6).toFixed(2)}`,
  })

  // 2. Fetch Pyth prices
  let priceStart: number, priceEnd: number
  try {
    const prices = await fetchRoundPrices(roundId)
    priceStart = prices.priceStart
    priceEnd = prices.priceEnd
  } catch (e) {
    clog({ action: 'error', detail: 'Pyth prices unavailable', error: String(e) })
    return currentNonce
  }

  const outcome = priceEnd > priceStart ? 'UP' : priceEnd < priceStart ? 'DOWN' : 'TIE'
  clog({ action: 'prices', detail: `start=${priceStart} end=${priceEnd} outcome=${outcome}` })

  // 3. Circuit breaker — validate prices before submitting
  const validation = await validatePrices(priceStart, priceEnd)
  if (!validation.valid) {
    circuitBreakerFailures++
    clog({ action: 'circuit-breaker', detail: validation.reason!, error: `consecutive=${circuitBreakerFailures}` })
    if (circuitBreakerFailures >= 3) {
      await alert('CRITICAL', `Circuit breaker: ${circuitBreakerFailures} consecutive failures`, {
        roundId, priceStart, priceEnd, reason: validation.reason,
      })
    }
    return currentNonce
  }
  circuitBreakerFailures = 0 // reset on success

  // 4. Call resolve-and-distribute via gateway (one atomic call)
  try {
    const { txId, nextNonce } = await broadcastWithRetry(
      (nonce) => makeContractCall({
        contractAddress: GATEWAY_ADDRESS,
        contractName: GATEWAY_NAME,
        functionName: 'resolve-and-distribute',
        functionArgs: [uintCV(roundId), uintCV(priceStart), uintCV(priceEnd)],
        senderKey: privateKey,
        network: STACKS_NETWORK,
        postConditionMode: PostConditionMode.Allow,
        fee: TX_FEE,
        nonce,
      }),
      currentNonce
    )
    clog({ action: 'resolve-and-distribute', detail: `broadcast ok`, txId })
    await waitForMempool(txId)
    currentNonce = nextNonce

    // 5. Post-settlement: credit jackpot tickets in Redis (off-chain)
    // NOTE: Jackpot balance accumulation is now on-chain (1% stays in contract).
    // Tickets only credited for VALID rounds: 2+ distinct wallets on opposite sides.
    // Same wallet betting both sides does NOT count as valid counterparty.
    try {
      const validity = await getRoundBettorValidity(roundId)
      if (validity.hasCounterparty) {
        await creditTicketsAfterSettlement(roundId.toString(), [])
        clog({ action: 'jackpot-tickets', detail: `tickets credited (${validity.uniqueWallets} wallets, UP=${validity.upBettors} DOWN=${validity.downBettors})` })
      } else {
        clog({ action: 'jackpot-skip', detail: `no valid counterparty (${validity.uniqueWallets} unique wallets)` })
      }
    } catch (e) {
      clog({ action: 'warn', detail: 'Jackpot ticket credit failed (non-fatal)', error: String(e) })
    }

  } catch (e) {
    clog({ action: 'error', detail: 'resolve-and-distribute failed', error: String(e) })
    await alert('WARN', `Settlement failed for round ${roundId}`, { error: String(e) })
  }

  return currentNonce
}

// ---------------------------------------------------------------------------
// ROUTE HANDLER
// ---------------------------------------------------------------------------

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const log: LogEntry[] = []
  const startTime = Date.now()

  const logAndPrint = (entry: LogEntry) => {
    log.push(entry)
    console.log(`[cron] ${entry.action}: ${entry.detail}${entry.txId ? ` tx=${entry.txId}` : ''}${entry.error ? ` ERR=${entry.error}` : ''}`)
  }

  try {
    const { privateKey, address } = await initWallet()
    logAndPrint({ action: 'init', detail: `Sponsor: ${address}` })

    // Acquire sponsor lock
    const gotLock = await acquireSponsorLock(10000)
    if (!gotLock) {
      logAndPrint({ action: 'skip', detail: 'Could not acquire sponsor lock' })
      return NextResponse.json({ ok: false, duration: Date.now() - startTime, log })
    }

    try {
      const tracked = await getSponsorNonce()
      let nonce: number
      if (tracked) {
        nonce = Number(tracked.nonce)
        logAndPrint({ action: 'nonce', detail: `KV tracked nonce: ${nonce}` })
      } else {
        nonce = await getNonce(address)
        logAndPrint({ action: 'nonce', detail: `API nonce (no KV): ${nonce}` })
      }

      // Optimized scan: KV-first + small on-chain safety net
      const kvRounds = await getRoundsWithBets()
      const activeUsers = await getActiveUserCount()
      const currentRoundId = Math.floor(Date.now() / 60000)

      logAndPrint({ action: 'state', detail: `KV rounds=${kvRounds.length} [${kvRounds.join(',')}] activeUsers=${activeUsers}` })

      // Small on-chain scan (last 5 min) as safety net
      const SCAN_BACK = 5
      const scanIds = Array.from({ length: SCAN_BACK }, (_, i) => currentRoundId - SCAN_BACK + i)
      const kvSet = new Set(kvRounds)
      const onChainOnlyIds = scanIds.filter(id => !kvSet.has(id))

      const scanActiveIds: number[] = []
      if (onChainOnlyIds.length > 0) {
        const results = await Promise.all(
          onChainOnlyIds.map(id => readRound(id).then(r => ({ id, round: r })).catch(() => ({ id, round: null })))
        )
        for (const r of results) {
          if (r.round && (r.round.totalUp + r.round.totalDown > 0) && !r.round.resolved) {
            scanActiveIds.push(r.id)
          }
        }
      }

      const allIds = [...new Set([...kvRounds, ...scanActiveIds])].sort((a, b) => a - b)

      if (allIds.length === 0) {
        logAndPrint({ action: 'skip', detail: 'No rounds with bets' })
      } else {
        logAndPrint({ action: 'scan', detail: `${allIds.length} rounds to process: [${allIds.join(',')}]` })
      }

      for (const roundId of allIds) {
        const prevNonce = nonce
        nonce = await processRound(roundId, nonce, privateKey, log)

        if (nonce === prevNonce && kvSet.has(roundId)) {
          await removeResolvedRound(roundId)
          logAndPrint({ action: 'kv-cleanup', detail: `Removed R${roundId} from rounds-with-bets` })
        }
      }

      logAndPrint({ action: 'done', detail: `Processed ${allIds.length} rounds` })
      await setSponsorNonce(BigInt(nonce))

    } catch (e) {
      await clearSponsorNonce()
      throw e
    } finally {
      await releaseSponsorLock()
    }

  } catch (e) {
    logAndPrint({ action: 'fatal', detail: 'Unhandled error', error: e instanceof Error ? e.message : String(e) })
    await alert('CRITICAL', 'Cron resolve fatal error', { error: String(e) })
  }

  const duration = Date.now() - startTime
  console.log(`[cron] Completed in ${duration}ms, ${log.length} log entries`)
  return NextResponse.json({ ok: true, duration, log })
}
