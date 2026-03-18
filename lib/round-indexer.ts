/**
 * Round Indexer — server-side indexer for BitPredix round history.
 *
 * Scans contract transactions from the Hiro API, parses place-bet and claim
 * calls, and builds a complete round index. Resolved rounds are cached
 * permanently (immutable data). Supports v5 (claim-round) and v6
 * (claim-round-side) contract formats.
 *
 * Persistence: Uses Upstash Redis to cache the full index so Vercel serverless
 * cold starts hydrate instantly instead of re-scanning all contract history.
 */

// ============================================================================
// TYPES
// ============================================================================

export interface IndexedBet {
  txId: string
  user: string
  side: 'UP' | 'DOWN'
  amount: number      // micro-units (6 decimals)
  amountUsd: number   // amount / 1e6
  timestamp: number   // block_time (unix seconds)
  status: 'success' | 'pending' | 'failed'
  early: boolean      // bet placed in first 20s (jackpot eligible)
}

export interface JackpotData {
  snapshot: number       // jackpot balance frozen on first claim (micro-units)
  earlyUp: number        // total early UP bets (micro-units)
  earlyDown: number      // total early DOWN bets (micro-units)
  distributed: number    // total bonus paid out (micro-units)
  locked: boolean        // true after first claim
}

export interface IndexedRound {
  roundId: number
  startTimestamp: number
  endTimestamp: number
  totalUpUsd: number
  totalDownUsd: number
  totalPoolUsd: number
  resolved: boolean
  outcome: 'UP' | 'DOWN' | null
  priceStart: number | null
  priceEnd: number | null
  bets: IndexedBet[]
  participantCount: number
  lastUpdated: number
  jackpot?: JackpotData
}

export interface WalletStats {
  address: string
  totalBets: number
  totalVolumeUsd: number
  wins: number
  losses: number
  pending: number
  winRate: number
}

export interface ProfileBetRecord {
  roundId: number
  timestamp: number
  side: 'UP' | 'DOWN'
  amountUsd: number
  outcome: 'UP' | 'DOWN' | null
  resolved: boolean
  totalPool: number
  winningPool: number
  pnl: number
  poolSharePct: number
  priceStart: number | null
  priceEnd: number | null
  txId: string
  early: boolean
  jackpotBonus: number   // jackpot bonus received (USD), 0 if not eligible
}

export interface EquityPoint {
  time: number
  value: number
}

export interface WalletProfile {
  address: string
  firstSeen: number
  stats: {
    totalBets: number
    totalVolumeUsd: number
    wins: number
    losses: number
    pending: number
    winRate: number
    totalPnl: number
    roi: number
    bestWin: number
    worstLoss: number
    avgBetSize: number
    longestWinStreak: number
    longestLoseStreak: number
    currentStreak: { type: 'win' | 'loss'; count: number }
    sideDistribution: { upVolume: number; downVolume: number }
    totalJackpotEarned: number
    jackpotWins: number
  }
  equityCurve: EquityPoint[]
  recentBets: ProfileBetRecord[]
  totalBetRecords: number
}

export interface IndexerStatus {
  roundCount: number
  lastScan: number
  totalTxsIndexed: number
  scanning: boolean
}

// ============================================================================
// HIRO TX TYPES
// ============================================================================

interface HiroFunctionArg {
  hex: string
  repr: string
  name: string
  type: string
}

interface HiroTx {
  tx_id: string
  tx_type: string
  tx_status: string
  sender_address: string
  block_time: number
  block_time_iso: string
  contract_call: {
    contract_id: string
    function_name: string
    function_args: HiroFunctionArg[]
  }
}

// ============================================================================
// CONFIG
// ============================================================================

import { Redis } from '@upstash/redis'

import { HIRO_API, hiroHeaders, disableApiKey } from '@/lib/hiro'
const DEPLOYER = 'ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK'
const SCAN_PAGE_SIZE = 50
const MAX_PAGES_PER_SCAN = 20
const MIN_SCAN_INTERVAL_MS = 30_000
const FETCH_TIMEOUT = 12_000
const REDIS_CACHE_KEY = 'indexer:cache:v2'
const REDIS_CACHE_TTL = 3600 // 1 hour

function getContractAddress(): string {
  return process.env.NEXT_PUBLIC_BITPREDIX_CONTRACT_ID || `${DEPLOYER}.predixv2`
}

function getGatewayAddress(): string | null {
  return process.env.NEXT_PUBLIC_GATEWAY_CONTRACT_ID || null
}



// ============================================================================
// REDIS CLIENT (lazy singleton)
// ============================================================================

let _redis: Redis | null = null
let _redisChecked = false

function getRedis(): Redis | null {
  if (_redis) return _redis
  if (_redisChecked) return null
  _redisChecked = true

  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_KV_REST_API_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_KV_REST_API_TOKEN
  if (url && token) {
    _redis = new Redis({ url, token })
    return _redis
  }
  return null
}

// ============================================================================
// SINGLETON STATE
// ============================================================================

const roundsIndex: Map<number, IndexedRound> = new Map()
const knownTxIds: Set<string> = new Set()

let lastScanTimestamp = 0
let totalTxsIndexed = 0
let scanInProgress = false
let initialScanDone = false
let activeScanPromise: Promise<void> | null = null
let hydratedFromCache = false

// ============================================================================
// PARSING HELPERS
// ============================================================================

function parseUint(repr: string): number {
  // "u29494078" -> 29494078
  if (repr.startsWith('u')) return parseInt(repr.slice(1), 10)
  return parseInt(repr, 10)
}

function parseString(repr: string): string {
  // '"UP"' -> 'UP'
  if (repr.startsWith('"') && repr.endsWith('"')) return repr.slice(1, -1)
  return repr
}

function parseTxStatus(status: string): 'success' | 'pending' | 'failed' {
  if (status === 'success') return 'success'
  if (status === 'pending') return 'pending'
  return 'failed'
}

// ============================================================================
// TRANSACTION PARSERS
// ============================================================================

const TICKET_WINDOW_S = 20

function parsePlaceBetTx(tx: HiroTx): { roundId: number; bet: IndexedBet } | null {
  const args = tx.contract_call.function_args
  if (!args || args.length < 3) return null

  const roundId = parseUint(args[0].repr)
  const side = parseString(args[1].repr) as 'UP' | 'DOWN'
  if (side !== 'UP' && side !== 'DOWN') return null

  const amount = parseUint(args[2].repr)
  if (isNaN(roundId) || isNaN(amount)) return null

  // Determine early status by timing: bet within first 20s of round
  const roundStartS = roundId * 60
  const elapsed = tx.block_time - roundStartS
  const early = elapsed >= 0 && elapsed <= TICKET_WINDOW_S

  return {
    roundId,
    bet: {
      txId: tx.tx_id,
      user: tx.sender_address,
      side,
      amount,
      amountUsd: amount / 1e6,
      timestamp: tx.block_time,
      status: parseTxStatus(tx.tx_status),
      early,
    },
  }
}

function parseClaimTx(tx: HiroTx): { roundId: number; priceStart: number; priceEnd: number } | null {
  const fn = tx.contract_call.function_name
  const args = tx.contract_call.function_args
  if (!args) return null

  if (fn === 'claim-round' && args.length >= 3) {
    // v5: (round-id, price-start, price-end)
    return {
      roundId: parseUint(args[0].repr),
      priceStart: parseUint(args[1].repr),
      priceEnd: parseUint(args[2].repr),
    }
  }

  if (fn === 'claim-round-side' && args.length >= 4) {
    // v6/predixv1: (round-id, side, price-start, price-end)
    return {
      roundId: parseUint(args[0].repr),
      priceStart: parseUint(args[2].repr),
      priceEnd: parseUint(args[3].repr),
    }
  }

  if (fn === 'resolve-round' && args.length >= 3) {
    // predixv1: (round-id, price-start, price-end)
    return {
      roundId: parseUint(args[0].repr),
      priceStart: parseUint(args[1].repr),
      priceEnd: parseUint(args[2].repr),
    }
  }

  if (fn === 'claim-on-behalf' && args.length >= 5) {
    // predixv1 cron: (user, round-id, side, price-start, price-end)
    return {
      roundId: parseUint(args[1].repr),
      priceStart: parseUint(args[3].repr),
      priceEnd: parseUint(args[4].repr),
    }
  }

  return null
}

// ============================================================================
// ROUND MANAGEMENT
// ============================================================================

function ensureRound(roundId: number): IndexedRound {
  let round = roundsIndex.get(roundId)
  if (!round) {
    round = {
      roundId,
      startTimestamp: roundId * 60,
      endTimestamp: (roundId + 1) * 60,
      totalUpUsd: 0,
      totalDownUsd: 0,
      totalPoolUsd: 0,
      resolved: false,
      outcome: null,
      priceStart: null,
      priceEnd: null,
      bets: [],
      participantCount: 0,
      lastUpdated: Date.now(),
    }
    roundsIndex.set(roundId, round)
  }
  return round
}

function recalcRoundTotals(round: IndexedRound): void {
  // Count both success and pending bets for pool totals (pending = mempool, not yet confirmed)
  const activeBets = round.bets.filter((b) => b.status === 'success' || b.status === 'pending')
  round.totalUpUsd = activeBets.filter((b) => b.side === 'UP').reduce((s, b) => s + b.amountUsd, 0)
  round.totalDownUsd = activeBets.filter((b) => b.side === 'DOWN').reduce((s, b) => s + b.amountUsd, 0)
  round.totalPoolUsd = round.totalUpUsd + round.totalDownUsd
  round.participantCount = new Set(activeBets.map((b) => b.user)).size
  round.lastUpdated = Date.now()
}

// ============================================================================
// HIRO API FETCHING
// ============================================================================

async function fetchContractTxs(contractAddress: string, limit: number, offset: number): Promise<{ results: HiroTx[]; total: number }> {
  const url = `${HIRO_API}/extended/v1/address/${contractAddress}/transactions?limit=${limit}&offset=${offset}`
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT)

  try {
    let res = await fetch(url, {
      headers: hiroHeaders(),
      signal: controller.signal,
    })
    // Monthly quota exhausted — disable key and retry without it
    if (res.status === 429) {
      const remaining = res.headers.get('x-ratelimit-remaining-stacks-month')
      if (remaining === '0' || remaining === '-1') {
        disableApiKey()
        res = await fetch(url, { headers: hiroHeaders(), signal: controller.signal })
      }
    }
    clearTimeout(timeoutId)
    if (!res.ok) throw new Error(`Hiro API ${res.status}`)
    const data = await res.json()
    return { results: data.results || [], total: data.total || 0 }
  } catch (e) {
    clearTimeout(timeoutId)
    throw e
  }
}

async function fetchMempoolTxs(contractAddress: string): Promise<HiroTx[]> {
  const url = `${HIRO_API}/extended/v1/address/${contractAddress}/mempool?limit=50`
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT)

  try {
    let res = await fetch(url, {
      headers: hiroHeaders(),
      signal: controller.signal,
    })
    if (res.status === 429) {
      const remaining = res.headers.get('x-ratelimit-remaining-stacks-month')
      if (remaining === '0' || remaining === '-1') {
        disableApiKey()
        res = await fetch(url, { headers: hiroHeaders(), signal: controller.signal })
      }
    }
    clearTimeout(timeoutId)
    if (!res.ok) return []
    const data = await res.json()
    return (data.results || []).filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tx: any) => tx.tx_type === 'contract_call' && tx.contract_call
    )
  } catch {
    return []
  }
}

// ============================================================================
// ON-CHAIN ENRICHMENT
// ============================================================================

async function enrichUnresolvedRounds(): Promise<void> {
  const contractId = getContractAddress()
  const [contractAddr, contractName] = contractId.split('.')
  if (!contractAddr || !contractName) return

  const now = Math.floor(Date.now() / 1000)
  const unresolved = [...roundsIndex.values()]
    .filter((r) => !r.resolved && r.endTimestamp < now)
    .sort((a, b) => b.roundId - a.roundId)
    .slice(0, 10)

  for (const round of unresolved) {
    try {
      const { uintCV, tupleCV, cvToHex, deserializeCV } = await import('@stacks/transactions')
      const keyHex = cvToHex(tupleCV({ 'round-id': uintCV(round.roundId) }))
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT)

      const res = await fetch(
        `${HIRO_API}/v2/map_entry/${contractAddr}/${contractName}/rounds?proof=0`,
        {
          method: 'POST',
          headers: hiroHeaders(),
          body: JSON.stringify(keyHex),
          signal: controller.signal,
        },
      )
      clearTimeout(timeoutId)

      if (!res.ok) continue
      const json = (await res.json()) as { data?: string }
      if (!json.data) continue

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cv = deserializeCV(json.data) as any
      const tuple = cv?.type === 'some' && cv?.value ? cv.value : cv
      // v7 @stacks/transactions: tuple fields are under .value, not .data
      const d = tuple?.value ?? tuple?.data ?? cv?.value ?? cv?.data
      if (!d) continue

      const u = (k: string) => Number(d[k]?.value ?? 0)
      // v7 @stacks/transactions: bools have .type 'true'/'false', not .value
      const resolvedField = d['resolved']
      const resolved = resolvedField?.type === 'true' || resolvedField?.value === true || String(resolvedField?.value) === 'true'

      if (resolved) {
        const priceStart = u('price-start')
        const priceEnd = u('price-end')
        round.priceStart = priceStart / 100
        round.priceEnd = priceEnd / 100
        round.resolved = true
        round.outcome = priceEnd > priceStart ? 'UP' : 'DOWN'
        round.lastUpdated = Date.now()
      }
    } catch {
      // Skip — will retry next scan
    }
  }
}

/**
 * Compute jackpot data off-chain from early bets in each resolved round.
 * predixv8 doesn't have a round-jackpot map — jackpot is 1% of total pool
 * volume, and early bet pools are computed from bet timestamps.
 */
function computeJackpotData(): void {
  for (const round of roundsIndex.values()) {
    if (!round.resolved || round.jackpot) continue

    const activeBets = round.bets.filter(b => b.status === 'success')
    const hasCounterparty = activeBets.some(b => b.side === 'UP') && activeBets.some(b => b.side === 'DOWN')
    if (!hasCounterparty) continue

    const earlyBets = activeBets.filter(b => b.early)
    if (earlyBets.length === 0) continue

    // Jackpot snapshot = 1% of total pool volume (micro-units)
    const totalPoolMicro = activeBets.reduce((s, b) => s + b.amount, 0)
    const snapshot = Math.floor(totalPoolMicro * 0.01)

    const earlyUp = earlyBets.filter(b => b.side === 'UP').reduce((s, b) => s + b.amount, 0)
    const earlyDown = earlyBets.filter(b => b.side === 'DOWN').reduce((s, b) => s + b.amount, 0)

    round.jackpot = {
      snapshot,
      earlyUp,
      earlyDown,
      distributed: snapshot, // fully distributed to early winners
      locked: true,
    }
    round.lastUpdated = Date.now()
  }
}

// ============================================================================
// REDIS CACHE — persist index across Vercel cold starts
// ============================================================================

interface IndexerCache {
  rounds: [number, IndexedRound][]
  txIds: string[]
  totalTxsIndexed: number
  savedAt: number
}

async function hydrateFromRedis(): Promise<boolean> {
  if (hydratedFromCache) return false
  hydratedFromCache = true

  const kv = getRedis()
  if (!kv) return false

  try {
    const cached = await kv.get<IndexerCache>(REDIS_CACHE_KEY)
    if (!cached || !cached.rounds) return false

    for (const [id, round] of cached.rounds) {
      if (!roundsIndex.has(id)) roundsIndex.set(id, round)
    }
    for (const txId of cached.txIds) {
      knownTxIds.add(txId)
    }
    totalTxsIndexed = cached.totalTxsIndexed || 0
    console.log(`[round-indexer] Hydrated from Redis: ${cached.rounds.length} rounds, ${cached.txIds.length} txIds`)
    return true
  } catch (e) {
    console.error('[round-indexer] Redis hydrate error:', e instanceof Error ? e.message : e)
    return false
  }
}

async function persistToRedis(): Promise<void> {
  const kv = getRedis()
  if (!kv) return

  try {
    const cache: IndexerCache = {
      rounds: [...roundsIndex.entries()],
      txIds: [...knownTxIds],
      totalTxsIndexed,
      savedAt: Date.now(),
    }
    await kv.set(REDIS_CACHE_KEY, cache, { ex: REDIS_CACHE_TTL })
    console.log(`[round-indexer] Persisted to Redis: ${cache.rounds.length} rounds`)
  } catch (e) {
    console.error('[round-indexer] Redis persist error:', e instanceof Error ? e.message : e)
  }
}

// ============================================================================
// SCAN ENGINE
// ============================================================================

async function scanContractTransactions(): Promise<void> {
  // If a scan is already running, wait for it instead of returning empty
  if (activeScanPromise) return activeScanPromise

  // On cold start, hydrate from Redis first
  if (!hydratedFromCache) {
    await hydrateFromRedis()
    // If we got data from cache, mark initial scan done so we only do incremental
    if (roundsIndex.size > 0) {
      initialScanDone = true
      lastScanTimestamp = Date.now() - MIN_SCAN_INTERVAL_MS // allow immediate incremental scan
    }
  }

  const now = Date.now()
  if (initialScanDone && now - lastScanTimestamp < MIN_SCAN_INTERVAL_MS) return

  scanInProgress = true
  activeScanPromise = doScan(now)

  try {
    await activeScanPromise
  } finally {
    activeScanPromise = null
    scanInProgress = false
  }
}

async function scanAddress(address: string): Promise<number> {
  let offset = 0
  let pagesScanned = 0
  let newTxs = 0

  while (pagesScanned < MAX_PAGES_PER_SCAN) {
    const { results } = await fetchContractTxs(address, SCAN_PAGE_SIZE, offset)
    if (results.length === 0) break

    let allKnown = true

    for (const tx of results) {
      if (tx.tx_type !== 'contract_call') continue
      if (!tx.contract_call) continue

      // Skip already indexed
      if (knownTxIds.has(tx.tx_id)) continue
      allKnown = false

      const fn = tx.contract_call.function_name

      if (fn === 'place-bet') {
        const parsed = parsePlaceBetTx(tx)
        if (parsed) {
          const round = ensureRound(parsed.roundId)
          if (!round.bets.some((b) => b.txId === parsed.bet.txId)) {
            round.bets.push(parsed.bet)
            recalcRoundTotals(round)
            newTxs++
          }
        }
        // Always mark as known (even if parse fails) to avoid re-processing
        knownTxIds.add(tx.tx_id)
      }

      if (fn === 'claim-round' || fn === 'claim-round-side' || fn === 'resolve-round' || fn === 'claim-on-behalf') {
        // Always mark as known regardless of status
        knownTxIds.add(tx.tx_id)
        if (tx.tx_status === 'success') {
          const parsed = parseClaimTx(tx)
          if (parsed) {
            const round = ensureRound(parsed.roundId)
            if (!round.resolved && parsed.priceStart > 0 && parsed.priceEnd > 0) {
              round.priceStart = parsed.priceStart / 100
              round.priceEnd = parsed.priceEnd / 100
              round.resolved = true
              round.outcome = parsed.priceEnd > parsed.priceStart ? 'UP' : 'DOWN'
              round.lastUpdated = Date.now()
            }
            newTxs++
          }
        }
      }
    }

    offset += SCAN_PAGE_SIZE
    pagesScanned++

    // If all txs on this page were already known, stop scanning
    if (allKnown && initialScanDone) break
  }

  return newTxs
}

async function doScan(now: number): Promise<void> {
  try {
    const contractAddress = getContractAddress()
    const gatewayAddress = getGatewayAddress()
    let newTxs = 0

    // Scan main contract (claims, resolves) and gateway (place-bet) in parallel
    const scanPromises: Promise<number>[] = [scanAddress(contractAddress)]
    if (gatewayAddress && gatewayAddress !== contractAddress) {
      scanPromises.push(scanAddress(gatewayAddress))
    }
    const results = await Promise.all(scanPromises)
    newTxs = results.reduce((a, b) => a + b, 0)

    totalTxsIndexed += newTxs

    // Scan mempool for pending bets on both contracts
    const mempoolPromises = [scanMempool(contractAddress)]
    if (gatewayAddress && gatewayAddress !== contractAddress) {
      mempoolPromises.push(scanMempool(gatewayAddress))
    }
    await Promise.all(mempoolPromises)

    // Enrich unresolved rounds with on-chain data + compute jackpot from early bets
    await enrichUnresolvedRounds()
    computeJackpotData()

    lastScanTimestamp = now
    initialScanDone = true

    // Persist to Redis after successful scan (if we found new data or first scan)
    if (newTxs > 0 || roundsIndex.size > 0) {
      // Fire-and-forget to avoid blocking the response
      persistToRedis().catch(() => {})
    }
  } catch (e) {
    console.error('[round-indexer] Scan error:', e instanceof Error ? e.message : e)
  }
}

/**
 * Scan mempool for pending place-bet txs.
 * Mempool bets are ephemeral: old pending bets are removed each scan,
 * then current mempool bets are re-added. Once confirmed, they'll be
 * picked up by the main scan and marked as 'success'.
 */
async function scanMempool(contractAddress: string): Promise<void> {
  try {
    // 1. Remove old pending bets from all rounds
    for (const round of roundsIndex.values()) {
      const hadPending = round.bets.some((b) => b.status === 'pending')
      if (hadPending) {
        round.bets = round.bets.filter((b) => b.status !== 'pending')
        recalcRoundTotals(round)
      }
    }

    // 2. Fetch current mempool
    const mempoolTxs = await fetchMempoolTxs(contractAddress)
    let added = 0

    for (const tx of mempoolTxs) {
      if (tx.contract_call.function_name !== 'place-bet') continue

      const parsed = parsePlaceBetTx(tx)
      if (!parsed) continue

      const round = ensureRound(parsed.roundId)
      // Force status to pending for mempool txs
      parsed.bet.status = 'pending'
      // Use receipt_time as timestamp if block_time is 0
      if (!parsed.bet.timestamp) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parsed.bet.timestamp = (tx as any).receipt_time || Math.floor(Date.now() / 1000)
      }

      if (!round.bets.some((b) => b.txId === parsed.bet.txId)) {
        round.bets.push(parsed.bet)
        recalcRoundTotals(round)
        added++
      }
    }

    if (added > 0) {
      console.log(`[round-indexer] Mempool: added ${added} pending bet(s)`)
    }
  } catch (e) {
    console.error('[round-indexer] Mempool scan error:', e instanceof Error ? e.message : e)
  }
}

// ============================================================================
// PUBLIC API
// ============================================================================

export async function getRoundHistory(opts: {
  page?: number
  pageSize?: number
  roundId?: number
}): Promise<{ rounds: IndexedRound[]; total: number; hasMore: boolean }> {
  // Trigger scan if needed
  await scanContractTransactions()

  const { page = 1, pageSize = 10, roundId } = opts

  // Search by specific round
  if (roundId !== undefined) {
    const round = roundsIndex.get(roundId)
    return {
      rounds: round ? [round] : [],
      total: round ? 1 : 0,
      hasMore: false,
    }
  }

  // Paginated list, newest first — skip rounds with no successful bets
  const allRounds = [...roundsIndex.values()]
    .filter((r) => r.totalPoolUsd > 0)
    .sort((a, b) => b.roundId - a.roundId)
  const start = (page - 1) * pageSize
  const slice = allRounds.slice(start, start + pageSize)

  return {
    rounds: slice,
    total: allRounds.length,
    hasMore: start + pageSize < allRounds.length,
  }
}

export function getWalletStats(address: string): WalletStats {
  let totalBets = 0
  let totalVolumeUsd = 0
  let wins = 0
  let losses = 0
  let pending = 0

  for (const round of roundsIndex.values()) {
    const userBets = round.bets.filter((b) => b.user === address && b.status === 'success')
    if (userBets.length === 0) continue

    for (const bet of userBets) {
      totalBets++
      totalVolumeUsd += bet.amountUsd

      if (!round.resolved) {
        pending++
      } else if (bet.side === round.outcome) {
        wins++
      } else {
        losses++
      }
    }
  }

  const decided = wins + losses
  return {
    address,
    totalBets,
    totalVolumeUsd,
    wins,
    losses,
    pending,
    winRate: decided > 0 ? wins / decided : 0,
  }
}

export async function getWalletProfile(
  address: string,
  page: number = 1,
  pageSize: number = 20
): Promise<WalletProfile> {
  // Trigger scan if needed
  await scanContractTransactions()
  const allBetRecords: ProfileBetRecord[] = []
  let firstSeen = Infinity

  for (const round of roundsIndex.values()) {
    const userBets = round.bets.filter((b) => b.user === address && b.status === 'success')
    if (userBets.length === 0) continue

    for (const bet of userBets) {
      if (bet.timestamp < firstSeen) firstSeen = bet.timestamp

      let pnl = 0
      let winningPool = 0
      let poolSharePct = 0
      const sidePool = bet.side === 'UP' ? round.totalUpUsd : round.totalDownUsd

      if (sidePool > 0) {
        poolSharePct = (bet.amountUsd / sidePool) * 100
      }

      if (round.resolved && round.outcome) {
        winningPool = round.outcome === 'UP' ? round.totalUpUsd : round.totalDownUsd
        if (bet.side === round.outcome) {
          const grossPayout = (bet.amountUsd / winningPool) * round.totalPoolUsd
          const fee = grossPayout * 0.03
          pnl = grossPayout - fee - bet.amountUsd
        } else {
          pnl = -bet.amountUsd
        }
      }

      // Calculate jackpot bonus for early winning bets
      let jackpotBonus = 0
      if (bet.early && round.resolved && round.outcome && bet.side === round.outcome && round.jackpot && round.jackpot.locked) {
        const earlyWinPool = round.outcome === 'UP' ? round.jackpot.earlyUp : round.jackpot.earlyDown
        if (earlyWinPool > 0) {
          jackpotBonus = (bet.amount / earlyWinPool) * round.jackpot.snapshot / 1e6
        }
      }

      allBetRecords.push({
        roundId: round.roundId,
        timestamp: round.endTimestamp,
        side: bet.side,
        amountUsd: bet.amountUsd,
        outcome: round.outcome,
        resolved: round.resolved,
        totalPool: round.totalPoolUsd,
        winningPool,
        pnl: pnl + jackpotBonus,
        poolSharePct,
        priceStart: round.priceStart,
        priceEnd: round.priceEnd,
        txId: bet.txId,
        early: bet.early,
        jackpotBonus,
      })
    }
  }

  allBetRecords.sort((a, b) => a.timestamp - b.timestamp)

  let totalPnl = 0, wins = 0, losses = 0, pending = 0
  let bestWin = 0, worstLoss = 0
  let upVolume = 0, downVolume = 0
  let totalVolume = 0
  let totalJackpotEarned = 0, jackpotWins = 0
  let curStreak = 0, curStreakType: 'win' | 'loss' = 'win'
  let longestWin = 0, longestLose = 0

  const equityCurve: EquityPoint[] = []
  let cumPnl = 0

  for (const bet of allBetRecords) {
    totalVolume += bet.amountUsd
    if (bet.side === 'UP') upVolume += bet.amountUsd
    else downVolume += bet.amountUsd

    if (!bet.resolved) {
      pending++
      continue
    }

    totalPnl += bet.pnl
    cumPnl += bet.pnl
    equityCurve.push({ time: bet.timestamp, value: cumPnl })

    if (bet.jackpotBonus > 0) {
      totalJackpotEarned += bet.jackpotBonus
      jackpotWins++
    }

    if (bet.pnl > bestWin) bestWin = bet.pnl
    if (bet.pnl < worstLoss) worstLoss = bet.pnl

    const isWin = bet.pnl >= 0
    if (isWin) {
      wins++
      if (curStreakType === 'win') { curStreak++ }
      else { curStreak = 1; curStreakType = 'win' }
      if (curStreak > longestWin) longestWin = curStreak
    } else {
      losses++
      if (curStreakType === 'loss') { curStreak++ }
      else { curStreak = 1; curStreakType = 'loss' }
      if (curStreak > longestLose) longestLose = curStreak
    }
  }

  const decided = wins + losses
  const totalBets = allBetRecords.length

  const sortedDesc = [...allBetRecords].reverse()
  const start = (page - 1) * pageSize
  const recentBets = sortedDesc.slice(start, start + pageSize)

  return {
    address,
    firstSeen: firstSeen === Infinity ? 0 : firstSeen,
    stats: {
      totalBets,
      totalVolumeUsd: totalVolume,
      wins,
      losses,
      pending,
      winRate: decided > 0 ? wins / decided : 0,
      totalPnl,
      roi: totalVolume > 0 ? totalPnl / totalVolume : 0,
      bestWin,
      worstLoss,
      avgBetSize: totalBets > 0 ? totalVolume / totalBets : 0,
      longestWinStreak: longestWin,
      longestLoseStreak: longestLose,
      currentStreak: { type: curStreakType, count: curStreak },
      sideDistribution: { upVolume, downVolume },
      totalJackpotEarned,
      jackpotWins,
    },
    equityCurve,
    recentBets,
    totalBetRecords: allBetRecords.length,
  }
}

// ============================================================================
// LEADERBOARD
// ============================================================================

export interface LeaderboardEntry {
  rank: number
  address: string
  totalBets: number
  totalVolumeUsd: number
  wins: number
  losses: number
  winRate: number
  totalPnl: number
  roi: number
}

export type LeaderboardSortBy = 'pnl' | 'volume' | 'winRate' | 'totalBets' | 'roi'

export async function getLeaderboard(
  sortBy: LeaderboardSortBy = 'pnl',
  page: number = 1,
  pageSize: number = 50,
  search?: string
): Promise<{ entries: LeaderboardEntry[]; total: number }> {
  // Trigger scan if needed
  await scanContractTransactions()
  // 1. Collect all unique addresses from roundsIndex
  const statsMap = new Map<string, {
    totalBets: number
    totalVolumeUsd: number
    wins: number
    losses: number
    totalPnl: number
  }>()

  for (const round of roundsIndex.values()) {
    for (const bet of round.bets) {
      if (bet.status !== 'success') continue

      let entry = statsMap.get(bet.user)
      if (!entry) {
        entry = { totalBets: 0, totalVolumeUsd: 0, wins: 0, losses: 0, totalPnl: 0 }
        statsMap.set(bet.user, entry)
      }

      entry.totalBets++
      entry.totalVolumeUsd += bet.amountUsd

      if (round.resolved && round.outcome) {
        if (bet.side === round.outcome) {
          entry.wins++
          const winningPool = round.outcome === 'UP' ? round.totalUpUsd : round.totalDownUsd
          if (winningPool > 0) {
            const grossPayout = (bet.amountUsd / winningPool) * round.totalPoolUsd
            const fee = grossPayout * 0.03
            entry.totalPnl += grossPayout - fee - bet.amountUsd
          }
        } else {
          entry.losses++
          entry.totalPnl -= bet.amountUsd
        }
      }
    }
  }

  // 2. Convert to LeaderboardEntry array
  let entries: Omit<LeaderboardEntry, 'rank'>[] = []
  for (const [address, s] of statsMap) {
    const decided = s.wins + s.losses
    entries.push({
      address,
      totalBets: s.totalBets,
      totalVolumeUsd: s.totalVolumeUsd,
      wins: s.wins,
      losses: s.losses,
      winRate: decided > 0 ? s.wins / decided : 0,
      totalPnl: s.totalPnl,
      roi: s.totalVolumeUsd > 0 ? s.totalPnl / s.totalVolumeUsd : 0,
    })
  }

  // 2b. Filter by search query
  if (search && search.trim().length > 0) {
    const q = search.trim().toUpperCase()
    entries = entries.filter((e) => e.address.toUpperCase().includes(q))
  }

  // 3. Sort
  const sortFns: Record<LeaderboardSortBy, (a: typeof entries[0], b: typeof entries[0]) => number> = {
    pnl: (a, b) => b.totalPnl - a.totalPnl,
    volume: (a, b) => b.totalVolumeUsd - a.totalVolumeUsd,
    winRate: (a, b) => b.winRate - a.winRate || b.totalBets - a.totalBets,
    totalBets: (a, b) => b.totalBets - a.totalBets,
    roi: (a, b) => b.roi - a.roi || b.totalVolumeUsd - a.totalVolumeUsd,
  }
  entries.sort(sortFns[sortBy])

  // 4. Paginate and assign ranks
  const total = entries.length
  const start = (page - 1) * pageSize
  const paged = entries.slice(start, start + pageSize).map((e, i) => ({
    ...e,
    rank: start + i + 1,
  }))

  return { entries: paged, total }
}

export interface GlobalStats {
  totalVolume: number
  totalRounds: number
  resolvedRounds: number
  upWins: number
  downWins: number
  uniqueWallets: number
  largestPool: number
  avgPoolSize: number
  totalJackpotDistributed: number
  jackpotRounds: number
  largestJackpot: number
  avgJackpotSize: number
}

export async function getGlobalStats(): Promise<GlobalStats> {
  await scanContractTransactions()
  let totalVolume = 0
  let totalRounds = 0
  let resolvedRounds = 0
  let upWins = 0
  let downWins = 0
  const uniqueWallets = new Set<string>()
  let largestPool = 0
  let totalJackpotDistributed = 0
  let jackpotRounds = 0
  let largestJackpot = 0

  for (const round of roundsIndex.values()) {
    if (round.totalPoolUsd === 0) continue
    totalRounds++
    totalVolume += round.totalPoolUsd
    if (round.totalPoolUsd > largestPool) largestPool = round.totalPoolUsd
    if (round.resolved) {
      resolvedRounds++
      if (round.outcome === 'UP') upWins++
      else if (round.outcome === 'DOWN') downWins++
    }
    for (const bet of round.bets) {
      if (bet.status === 'success') uniqueWallets.add(bet.user)
    }
    // Jackpot aggregation
    if (round.jackpot && round.jackpot.locked && round.jackpot.snapshot > 0) {
      const jpUsd = round.jackpot.snapshot / 1e6
      totalJackpotDistributed += jpUsd
      jackpotRounds++
      if (jpUsd > largestJackpot) largestJackpot = jpUsd
    }
  }

  return {
    totalVolume,
    totalRounds,
    resolvedRounds,
    upWins,
    downWins,
    uniqueWallets: uniqueWallets.size,
    largestPool,
    avgPoolSize: totalRounds > 0 ? totalVolume / totalRounds : 0,
    totalJackpotDistributed,
    jackpotRounds,
    largestJackpot,
    avgJackpotSize: jackpotRounds > 0 ? totalJackpotDistributed / jackpotRounds : 0,
  }
}

export function getIndexerStatus(): IndexerStatus {
  return {
    roundCount: roundsIndex.size,
    lastScan: lastScanTimestamp,
    totalTxsIndexed,
    scanning: scanInProgress,
  }
}
