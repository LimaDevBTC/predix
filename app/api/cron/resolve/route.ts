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
import { dispatchWebhookEvent } from '@/lib/agent-webhooks'
import { creditTicketsAfterSettlement, saveRoundTickets } from '@/lib/jackpot'
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
  getEarlyBets,
  signalRoundResolved,
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

/** Fire-and-forget: log tx status once it appears in mempool. Non-blocking. */
function logMempoolStatus(txId: string): void {
  sleep(2000).then(async () => {
    try {
      const data = await fetchJson(`${HIRO_API}/extended/v1/tx/${txId}`)
      const status = (data as { tx_status?: string }).tx_status || 'unknown'
      console.log(`[cron] tx ${txId} mempool status: ${status}`)
    } catch { /* ignore */ }
  })
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

const PYTH_BTC_FEED_ID = 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43'
const HERMES_BASE = 'https://hermes.pyth.network'

async function fetchRoundPrices(roundId: number): Promise<{ priceStart: number; priceEnd: number; source: string }> {
  // Try Benchmarks first, fall back to Hermes historical prices
  try {
    const prices = await fetchRoundPricesBenchmarks(roundId)
    return { ...prices, source: 'benchmarks' }
  } catch (benchErr) {
    console.log(`[cron] Benchmarks failed for R${roundId}: ${benchErr}, trying Hermes fallback`)
    try {
      const prices = await fetchRoundPricesHermes(roundId)
      return { ...prices, source: 'hermes' }
    } catch (hermesErr) {
      throw new Error(`Both price sources failed — Benchmarks: ${benchErr}, Hermes: ${hermesErr}`)
    }
  }
}

async function fetchRoundPricesBenchmarks(roundId: number): Promise<{ priceStart: number; priceEnd: number }> {
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

async function fetchHermesPriceAt(timestamp: number): Promise<number> {
  const res = await fetch(`${HERMES_BASE}/v2/updates/price/${timestamp}?ids[]=${PYTH_BTC_FEED_ID}`)
  if (!res.ok) throw new Error(`Hermes HTTP ${res.status}`)
  const data = await res.json() as { parsed?: Array<{ price?: { price?: string; expo?: number } }> }
  const p = data.parsed?.[0]?.price
  if (!p?.price || p?.expo === undefined) throw new Error('Hermes returned no price data')
  return Math.round(parseFloat(p.price) * Math.pow(10, p.expo) * 100) // USD cents
}

async function fetchRoundPricesHermes(roundId: number): Promise<{ priceStart: number; priceEnd: number }> {
  const roundStartTs = roundId * 60
  const roundEndTs = (roundId + 1) * 60
  const [priceStart, priceEnd] = await Promise.all([
    fetchHermesPriceAt(roundStartTs),
    fetchHermesPriceAt(roundEndTs),
  ])
  return { priceStart, priceEnd }
}

async function fetchCurrentHermesPrice(): Promise<number> {
  try {
    return await fetchHermesPriceAt(Math.floor(Date.now() / 1000))
  } catch { /* fallback */ }
  return 0
}

// ---------------------------------------------------------------------------
// CIRCUIT BREAKER
// ---------------------------------------------------------------------------

async function validatePrices(priceStart: number, priceEnd: number, source: string): Promise<{ valid: boolean; reason?: string }> {
  // 1. Excessive change in 60s
  const change = Math.abs(priceEnd - priceStart) / priceStart
  if (change > PRICE_CHANGE_THRESHOLD) {
    return { valid: false, reason: `Price change ${(change * 100).toFixed(2)}% exceeds ${PRICE_CHANGE_THRESHOLD * 100}% threshold` }
  }

  // 2. Cross-check: Benchmarks vs Hermes (skip if prices already came from Hermes)
  if (source !== 'hermes') {
    const hermesPrice = await fetchCurrentHermesPrice()
    if (hermesPrice > 0) {
      const divergence = Math.abs(hermesPrice - priceEnd) / hermesPrice
      if (divergence > PRICE_DIVERGENCE_THRESHOLD) {
        return { valid: false, reason: `Hermes/Benchmark divergence ${(divergence * 100).toFixed(2)}% exceeds ${PRICE_DIVERGENCE_THRESHOLD * 100}% threshold` }
      }
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

// ---------------------------------------------------------------------------
// PHASE 1: Prefetch — read on-chain + fetch prices (parallelizable)
// ---------------------------------------------------------------------------

interface PrefetchResult {
  roundId: number
  round: RoundData
  priceStart: number
  priceEnd: number
  priceSource: string
  skip: boolean         // true = nothing to settle (no bets, already resolved, prices failed)
  alreadyResolved: boolean
}

async function prefetchRound(roundId: number, log: LogEntry[]): Promise<PrefetchResult> {
  const clog = (entry: LogEntry) => {
    log.push(entry)
    console.log(`[cron] R${roundId} ${entry.action}: ${entry.detail}${entry.error ? ` ERR=${entry.error}` : ''}`)
  }

  const empty: PrefetchResult = { roundId, round: { totalUp: 0, totalDown: 0, priceStart: 0, priceEnd: 0, resolved: false }, priceStart: 0, priceEnd: 0, priceSource: '', skip: true, alreadyResolved: false }

  // 1. Read round on-chain
  const round = await readRound(roundId)
  if (!round || (round.totalUp + round.totalDown === 0)) {
    return empty
  }

  if (round.resolved) {
    clog({ action: 'already-resolved', detail: `start=${round.priceStart} end=${round.priceEnd}` })
    return { ...empty, round, skip: true, alreadyResolved: true }
  }

  clog({ action: 'found', detail: `UP=$${(round.totalUp / 1e6).toFixed(2)} DOWN=$${(round.totalDown / 1e6).toFixed(2)}` })

  // 2. Fetch prices
  try {
    const prices = await fetchRoundPrices(roundId)
    const outcome = prices.priceEnd > prices.priceStart ? 'UP' : prices.priceEnd < prices.priceStart ? 'DOWN' : 'TIE'
    clog({ action: 'prices', detail: `start=${prices.priceStart} end=${prices.priceEnd} outcome=${outcome} source=${prices.source}` })

    // 3. Circuit breaker
    const validation = await validatePrices(prices.priceStart, prices.priceEnd, prices.source)
    if (!validation.valid) {
      circuitBreakerFailures++
      clog({ action: 'circuit-breaker', detail: validation.reason!, error: `consecutive=${circuitBreakerFailures}` })
      if (circuitBreakerFailures >= 3) {
        await alert('CRITICAL', `Circuit breaker: ${circuitBreakerFailures} consecutive failures`, {
          roundId, priceStart: prices.priceStart, priceEnd: prices.priceEnd, reason: validation.reason,
        })
      }
      return empty
    }
    circuitBreakerFailures = 0

    return { roundId, round, priceStart: prices.priceStart, priceEnd: prices.priceEnd, priceSource: prices.source, skip: false, alreadyResolved: false }
  } catch (e) {
    clog({ action: 'error', detail: 'All price sources unavailable', error: String(e) })
    return empty
  }
}

// ---------------------------------------------------------------------------
// PHASE 2: Settle — broadcast sequentially (nonce ordering required)
// ---------------------------------------------------------------------------

interface SettleResult {
  nextNonce: number
  resolved: boolean
}

async function settleRound(
  pf: PrefetchResult,
  nonce: number,
  privateKey: string,
  log: LogEntry[]
): Promise<SettleResult> {
  let currentNonce = nonce
  const { roundId, round, priceStart, priceEnd } = pf

  const clog = (entry: LogEntry) => {
    log.push(entry)
    console.log(`[cron] R${roundId} ${entry.action}: ${entry.detail}${entry.txId ? ` tx=${entry.txId}` : ''}${entry.error ? ` ERR=${entry.error}` : ''}`)
  }

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
    logMempoolStatus(txId)
    signalRoundResolved(roundId).catch(() => {}) // signal UI to invalidate Hiro cache
    currentNonce = nextNonce

    // Post-settlement: credit jackpot tickets (non-blocking for settlement)
    try {
      const validity = await getRoundBettorValidity(roundId)
      if (validity.hasCounterparty) {
        const earlyBets = await getEarlyBets(roundId)
        const betInfos = earlyBets.map(eb => ({
          user: eb.user, side: eb.side, amountUsd: eb.amountUsd,
          roundId: eb.roundId, betTimestampS: eb.betTimestampS, roundStartS: eb.roundStartS,
        }))
        const ticketResults = await creditTicketsAfterSettlement(roundId.toString(), betInfos)
        if (ticketResults.length > 0) {
          await saveRoundTickets(roundId.toString(), ticketResults)
        }
        clog({ action: 'jackpot-tickets', detail: `tickets credited: ${betInfos.length} early bets → ${ticketResults.length} users, ${ticketResults.reduce((s, t) => s + t.tickets, 0)} total tickets (${validity.uniqueWallets} wallets, UP=${validity.upBettors} DOWN=${validity.downBettors})` })
      } else {
        clog({ action: 'jackpot-skip', detail: `no valid counterparty (${validity.uniqueWallets} unique wallets)` })
      }
    } catch (e) {
      clog({ action: 'warn', detail: 'Jackpot ticket credit failed (non-fatal)', error: String(e) })
    }

    // Dispatch webhook events (fire and forget)
    const outcome = priceEnd > priceStart ? 'UP' : priceEnd < priceStart ? 'DOWN' : 'TIE'
    dispatchWebhookEvent('round.resolved', {
      roundId, outcome, priceStart, priceEnd,
      totalVolume: (round.totalUp + round.totalDown) / 1e6,
    }).catch(() => {})
    dispatchWebhookEvent('bet.result', {
      roundId, outcome, priceStart, priceEnd,
      totalUp: round.totalUp / 1e6, totalDown: round.totalDown / 1e6,
      totalVolume: (round.totalUp + round.totalDown) / 1e6,
    }).catch(() => {})

    return { nextNonce: currentNonce, resolved: true }
  } catch (e) {
    clog({ action: 'error', detail: 'resolve-and-distribute failed', error: String(e) })
    await alert('WARN', `Settlement failed for round ${roundId}`, { error: String(e) })
    return { nextNonce: currentNonce, resolved: false }
  }
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

    // Dispatch round lifecycle events (fire and forget)
    const nowRoundId = Math.floor(Date.now() / 60000)
    dispatchWebhookEvent('round.open', {
      roundId: nowRoundId,
      startsAt: nowRoundId * 60,
      endsAt: (nowRoundId + 1) * 60,
      tradingClosesAt: (nowRoundId + 1) * 60 - 10,
    }).catch(() => {})

    dispatchWebhookEvent('round.trading_closed', {
      roundId: nowRoundId - 1,
      closedAt: Math.floor(Date.now() / 1000),
    }).catch(() => {})

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

      // On-chain scan as safety net (catches rounds missed by KV)
      const SCAN_BACK = 20
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

      // Phase 1: Prefetch all rounds in parallel (on-chain reads + prices)
      const prefetched = await Promise.all(
        allIds.map(id => prefetchRound(id, log).catch(() => null))
      )

      // Handle already-resolved rounds (KV cleanup, no broadcast needed)
      for (const pf of prefetched) {
        if (pf?.alreadyResolved && kvSet.has(pf.roundId)) {
          await removeResolvedRound(pf.roundId)
          logAndPrint({ action: 'kv-cleanup', detail: `Removed R${pf.roundId} from rounds-with-bets` })
        }
      }

      // Phase 2: Settle ready rounds sequentially (nonce ordering)
      const toSettle = prefetched.filter((pf): pf is PrefetchResult => pf !== null && !pf.skip)
      for (const pf of toSettle) {
        const result = await settleRound(pf, nonce, privateKey, log)
        nonce = result.nextNonce

        if (result.resolved && kvSet.has(pf.roundId)) {
          await removeResolvedRound(pf.roundId)
          logAndPrint({ action: 'kv-cleanup', detail: `Removed R${pf.roundId} from rounds-with-bets` })
        }
      }

      logAndPrint({ action: 'done', detail: `Processed ${allIds.length} rounds (${toSettle.length} settled)` })
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
