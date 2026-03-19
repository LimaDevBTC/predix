/**
 * Jackpot 2.0 -- Daily lottery, hybrid on-chain + off-chain.
 *
 * ON-CHAIN (predixv3 contract):
 * - Jackpot treasury: 1% of volume stays in contract after each settlement
 * - pay-jackpot-winner: transfers from treasury to winner (sponsor-only via gateway)
 * - seed-jackpot: deployer can seed initial funds
 *
 * OFF-CHAIN (Redis):
 * - Ticket system: tracks early bets (0-20s), first/largest multipliers
 * - Daily draw logic: Bitcoin block hash randomness, winner calculation
 * - Draw history: results stored for 30 days
 *
 * Draw: daily at 21h ET, Bitcoin block hash as randomness
 * Payout: 10% of on-chain fund per draw (jackpot never zeros)
 */

import { Redis } from '@upstash/redis'
import { BITPREDIX_CONTRACT, splitContractId } from '@/lib/config'
import { HIRO_API, hiroHeaders } from '@/lib/hiro'

const TICKET_WINDOW_S = parseInt(process.env.JACKPOT_TICKET_WINDOW || '20', 10)
const PAYOUT_PCT = parseInt(process.env.JACKPOT_PAYOUT_PCT || '10', 10)

const [CONTRACT_ADDRESS, CONTRACT_NAME] = splitContractId(BITPREDIX_CONTRACT)

// Lazy Redis singleton (same pattern as pool-store)
let _redis: Redis | null = null
function getRedis(): Redis | null {
  if (_redis) return _redis
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return null
  _redis = new Redis({ url, token })
  return _redis
}

// ---------------------------------------------------------------------------
// Keys (Redis -- tickets only, no balance)
// ---------------------------------------------------------------------------
/**
 * Get day ID in ET timezone (YYYY-MM-DD).
 * All jackpot operations use ET because the draw happens at 21h ET.
 * Tickets reset at midnight ET, not midnight UTC.
 */
function dayId(date?: Date): string {
  const d = date || new Date()
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) // YYYY-MM-DD
}

/** Public accessor for today's ET date string. */
export function todayET(): string {
  return dayId()
}

const KEYS = {
  tickets: (day: string, user: string) => `jackpot:tickets:${day}:${user}`,
  ticketCount: (day: string) => `jackpot:ticket-count:${day}`,
  firstBettor: (roundId: string, side: string) => `jackpot:first:${roundId}:${side}`,
  maxBet: (roundId: string, side: string) => `jackpot:max-bet:${roundId}:${side}`,
  draw: (day: string) => `jackpot:draw:${day}`,
  ticketUsers: (day: string) => `jackpot:ticket-users:${day}`,
  roundTickets: (roundId: string) => `jackpot:round-tickets:${roundId}`,
}

// ---------------------------------------------------------------------------
// Ticket calculation (off-chain)
// ---------------------------------------------------------------------------

export interface BetInfo {
  user: string
  side: 'UP' | 'DOWN'
  amountUsd: number       // in USD (not micro-tokens)
  roundId: string
  betTimestampS: number   // unix seconds when sponsor received the bet
  roundStartS: number     // unix seconds when round started
}

export interface TicketResult {
  user: string
  tickets: number
  multiplier: number
  isFirst: boolean
  isLargest: boolean
}

/**
 * Determine if a bet is within the early window (0-20s).
 */
export function isEarlyBet(betTimestampS: number, roundStartS: number): boolean {
  const elapsed = betTimestampS - roundStartS
  return elapsed >= 0 && elapsed <= TICKET_WINDOW_S
}

/**
 * Record a bet for jackpot tracking (called by sponsor after successful broadcast).
 * Tracks first bettor and largest bet per side within early window.
 */
export async function recordEarlyBet(bet: BetInfo): Promise<void> {
  const redis = getRedis()
  if (!redis) return

  if (!isEarlyBet(bet.betTimestampS, bet.roundStartS)) return

  const firstKey = KEYS.firstBettor(bet.roundId, bet.side)
  const maxKey = KEYS.maxBet(bet.roundId, bet.side)

  // Track first bettor (SETNX -- only sets if not exists)
  await redis.setnx(firstKey, bet.user)
  await redis.expire(firstKey, 120)

  // Track largest bet (compare and update)
  const currentMax = await redis.hgetall(maxKey) as { amount?: string; bettor?: string } | null
  const currentAmount = currentMax?.amount ? parseFloat(currentMax.amount) : 0
  if (bet.amountUsd > currentAmount) {
    await redis.hset(maxKey, { amount: bet.amountUsd.toString(), bettor: bet.user })
    await redis.expire(maxKey, 120)
  }
}

/**
 * After a round is settled, calculate and credit tickets for all early bettors.
 * Called by cron/resolve after successful on-chain settlement.
 *
 * NOTE: Jackpot balance accumulation is now on-chain (1% stays in contract).
 * This function only handles ticket crediting in Redis.
 *
 * @param roundId - The settled round ID
 * @param earlyBets - All early bets in this round (from sponsor tracking)
 */
export async function creditTicketsAfterSettlement(
  roundId: string,
  earlyBets: BetInfo[],
): Promise<TicketResult[]> {
  const redis = getRedis()
  if (!redis) return []

  const today = dayId()
  const results: TicketResult[] = []

  // Get first/largest for each side
  const firstUp = await redis.get(KEYS.firstBettor(roundId, 'UP')) as string | null
  const firstDown = await redis.get(KEYS.firstBettor(roundId, 'DOWN')) as string | null
  const maxUpData = await redis.hgetall(KEYS.maxBet(roundId, 'UP')) as { amount?: string; bettor?: string } | null
  const maxDownData = await redis.hgetall(KEYS.maxBet(roundId, 'DOWN')) as { amount?: string; bettor?: string } | null
  const largestUp = maxUpData?.bettor || null
  const largestDown = maxDownData?.bettor || null

  // Calculate tickets per bettor
  const userTickets = new Map<string, { tickets: number; multiplier: number; isFirst: boolean; isLargest: boolean }>()

  for (const bet of earlyBets) {
    const isFirst = (bet.side === 'UP' ? firstUp : firstDown) === bet.user
    const isLargest = (bet.side === 'UP' ? largestUp : largestDown) === bet.user

    let multiplier = 1
    if (isFirst && isLargest) multiplier = 4
    else if (isFirst || isLargest) multiplier = 2

    const tickets = Math.floor(bet.amountUsd * multiplier)

    const existing = userTickets.get(bet.user)
    if (existing) {
      existing.tickets += tickets
      existing.multiplier = Math.max(existing.multiplier, multiplier)
      existing.isFirst = existing.isFirst || isFirst
      existing.isLargest = existing.isLargest || isLargest
    } else {
      userTickets.set(bet.user, { tickets, multiplier, isFirst, isLargest })
    }
  }

  // Save to Redis
  for (const [user, data] of userTickets) {
    if (data.tickets > 0) {
      await redis.incrby(KEYS.tickets(today, user), data.tickets)
      await redis.expire(KEYS.tickets(today, user), 48 * 3600)
      await redis.incrby(KEYS.ticketCount(today), data.tickets)
      await redis.expire(KEYS.ticketCount(today), 48 * 3600)
      // Track user in day's set (for draw iteration)
      await redis.sadd(KEYS.ticketUsers(today), user)
      await redis.expire(KEYS.ticketUsers(today), 48 * 3600)

      results.push({ user, ...data })
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Jackpot balance (on-chain read)
// ---------------------------------------------------------------------------

/**
 * Get current jackpot balance from on-chain contract (micro-tokens).
 * Reads the `jackpot-balance` data-var from predixv3 via Hiro API.
 */
export async function getJackpotBalance(): Promise<number> {
  try {
    const res = await fetch(
      `${HIRO_API}/v2/data_var/${CONTRACT_ADDRESS}/${CONTRACT_NAME}/jackpot-balance?proof=0`,
      { headers: hiroHeaders() }
    )
    if (!res.ok) {
      console.warn(`[jackpot] Failed to read on-chain balance: HTTP ${res.status}`)
      return 0
    }
    const data = await res.json() as { data?: string }
    if (!data.data) return 0

    // Clarity uint serialized as hex -- parse it
    // Format: 0x0100000000000000000000000000000000 (u0)
    const { hexToCV, cvToJSON } = await import('@stacks/transactions')
    const cv = hexToCV(data.data)
    const json = cvToJSON(cv) as { value: string }
    return Number(json.value) || 0
  } catch (e) {
    console.warn('[jackpot] Error reading on-chain balance:', e)
    return 0
  }
}

// ---------------------------------------------------------------------------
// Draw
// ---------------------------------------------------------------------------

export interface DrawResult {
  date: string
  blockHeight: number
  blockHash: string
  totalTickets: number
  winnerIndex: string
  winner: string
  prize: number
  jackpotBalanceAfter: number
}

/**
 * Resolve the ticket owner for a given index.
 * Iterates through users of the day, summing tickets until reaching winnerIndex.
 * Users are stored as hash160 signers — converts to Stacks address before returning.
 */
export async function resolveTicketOwner(day: string, winnerIndex: bigint): Promise<string | null> {
  const redis = getRedis()
  if (!redis) return null

  const users = await redis.smembers(KEYS.ticketUsers(day))
  if (!users || users.length === 0) return null

  let winner: string | null = null
  let cumulative = BigInt(0)
  for (const user of users) {
    const tickets = await redis.get(KEYS.tickets(day, user)) as number | null
    if (!tickets) continue
    cumulative += BigInt(tickets)
    if (cumulative > winnerIndex) {
      winner = user
      break
    }
  }

  // Fallback: return last user (rounding edge case)
  if (!winner) winner = users[users.length - 1]

  // Convert hash160 signer to Stacks address if needed
  if (winner && !winner.startsWith('S')) {
    try {
      const { c32address } = await import('c32check')
      const { NETWORK_NAME } = await import('./config')
      // version 26 = testnet (ST), version 22 = mainnet (SP)
      const version = NETWORK_NAME === 'mainnet' ? 22 : 26
      winner = c32address(version, winner)
    } catch (e) {
      console.error('[jackpot] Failed to convert hash160 to address:', e)
    }
  }

  return winner
}

/**
 * Get user's ticket count for today.
 */
export async function getUserTickets(user: string, day?: string): Promise<number> {
  const redis = getRedis()
  if (!redis) return 0
  const d = day || dayId()
  const tickets = await redis.get(KEYS.tickets(d, user)) as number | null
  return tickets || 0
}

/**
 * Get total tickets for a day.
 */
export async function getTotalTickets(day?: string): Promise<number> {
  const redis = getRedis()
  if (!redis) return 0
  const d = day || dayId()
  const total = await redis.get(KEYS.ticketCount(d)) as number | null
  return total || 0
}

// ---------------------------------------------------------------------------
// Per-round ticket persistence
// ---------------------------------------------------------------------------

/**
 * Save ticket results for a round (called after creditTicketsAfterSettlement).
 * Stored for 7 days — enough for round history browsing.
 */
export async function saveRoundTickets(roundId: string, results: TicketResult[]): Promise<void> {
  const redis = getRedis()
  if (!redis || results.length === 0) return
  await redis.set(KEYS.roundTickets(roundId), JSON.stringify(results))
  await redis.expire(KEYS.roundTickets(roundId), 7 * 24 * 3600)
}

/**
 * Get ticket results for a specific round.
 */
export async function getRoundTickets(roundId: string): Promise<TicketResult[]> {
  const redis = getRedis()
  if (!redis) return []
  const raw = await redis.get(KEYS.roundTickets(roundId))
  if (!raw) return []
  return typeof raw === 'string' ? JSON.parse(raw) : raw as unknown as TicketResult[]
}

/**
 * Get ticket results for multiple rounds in a single batch.
 */
export async function getRoundTicketsBatch(roundIds: string[]): Promise<Map<string, TicketResult[]>> {
  const redis = getRedis()
  const result = new Map<string, TicketResult[]>()
  if (!redis || roundIds.length === 0) return result

  const pipeline = redis.pipeline()
  for (const id of roundIds) {
    pipeline.get(KEYS.roundTickets(id))
  }
  const responses = await pipeline.exec()

  for (let i = 0; i < roundIds.length; i++) {
    const raw = responses[i]
    if (raw) {
      const tickets = typeof raw === 'string' ? JSON.parse(raw) : raw as unknown as TicketResult[]
      if (Array.isArray(tickets) && tickets.length > 0) {
        result.set(roundIds[i], tickets)
      }
    }
  }
  return result
}

/**
 * Calculate prize amount: PAYOUT_PCT% of balance.
 */
export function calculatePrize(balance: number): number {
  return Math.floor(balance * PAYOUT_PCT / 100)
}

/**
 * Save draw result to Redis.
 */
export async function saveDrawResult(result: DrawResult): Promise<void> {
  const redis = getRedis()
  if (!redis) return
  await redis.set(KEYS.draw(result.date), JSON.stringify(result))
  await redis.expire(KEYS.draw(result.date), 30 * 24 * 3600) // 30 days
}

/**
 * Get draw result for a specific day.
 */
export async function getDrawResult(day: string): Promise<DrawResult | null> {
  const redis = getRedis()
  if (!redis) return null
  const raw = await redis.get(KEYS.draw(day)) as string | null
  if (!raw) return null
  return typeof raw === 'string' ? JSON.parse(raw) : raw as unknown as DrawResult
}

/**
 * Get recent draw results (last N days).
 */
export async function getRecentDraws(count: number = 7): Promise<DrawResult[]> {
  const results: DrawResult[] = []
  const now = new Date()
  for (let i = 0; i < count; i++) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const result = await getDrawResult(dayId(d))
    if (result) results.push(result)
  }
  return results
}
