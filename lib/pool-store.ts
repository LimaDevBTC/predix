/**
 * Server-side KV store for optimistic pool totals, trades, and open prices.
 *
 * Uses Upstash Redis (via @upstash/redis) so all Vercel serverless instances
 * share the same state. Replaces the old globalThis in-memory caches
 * (pool-cache.ts + pool-broadcast.ts) which broke on multi-instance deploys.
 *
 * Fallback: in-memory Maps when UPSTASH_REDIS_REST_URL is not configured
 * (local dev without Redis).
 */

import { Redis } from '@upstash/redis'

export interface RecentTrade {
  id: string
  side: 'UP' | 'DOWN'
  amount: number  // USD (not micro)
  ts: number      // Date.now() when recorded
}

// ---------------------------------------------------------------------------
// Redis client (lazy singleton)
// ---------------------------------------------------------------------------

let redis: Redis | null = null
let redisChecked = false
let redisConnected = false

function getRedis(): Redis | null {
  if (redis) return redis
  if (redisChecked) return null

  // Support both naming conventions: UPSTASH_REDIS_REST_* (standard) and UPSTASH_KV_REST_API_* (Vercel integration)
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_KV_REST_API_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_KV_REST_API_TOKEN
  redisChecked = true

  if (url && token) {
    redis = new Redis({ url, token })
    redisConnected = true
    console.log('[pool-store] Redis connected:', url.replace(/^(https?:\/\/[^/]+).*/, '$1'))
    return redis
  }

  console.warn('[pool-store] NO REDIS — falling back to in-memory (cross-device sync WILL NOT work on Vercel)')
  return null
}

export function isRedisConnected(): boolean {
  getRedis() // ensure checked
  return redisConnected
}

// ---------------------------------------------------------------------------
// In-memory fallback (local dev without Redis — same behaviour as old code)
// ---------------------------------------------------------------------------

const g = globalThis as unknown as {
  __poolCache?: Map<number, { up: number; down: number }>
  __openPriceCache?: Map<number, number>
  __recentTrades?: Map<number, RecentTrade[]>
}
g.__poolCache ??= new Map()
g.__openPriceCache ??= new Map()
g.__recentTrades ??= new Map()

// ---------------------------------------------------------------------------
// Pool (optimistic totals in micro-units)
// ---------------------------------------------------------------------------

export async function addOptimisticBet(
  roundId: number,
  side: 'UP' | 'DOWN',
  amountMicro: number,
  tradeId?: string,
): Promise<string> {
  const id = tradeId || Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const trade: RecentTrade = { id, side, amount: amountMicro / 1e6, ts: Date.now() }
  const kv = getRedis()

  if (kv) {
    try {
      // Dedup: prevent double-counting when both sponsor and client pool-update
      // call this function for the same bet. Uses SETNX — first write wins.
      const dedupKey = `trade-seen:${roundId}:${id}`
      const isNew = await kv.set(dedupKey, '1', { nx: true, ex: 120 })
      if (isNew !== 'OK') {
        console.log(`[pool-store] Dedup hit: trade ${id} already processed, skipping`)
        return id
      }

      const field = side === 'UP' ? 'up' : 'down'
      const pipe = kv.pipeline()
      pipe.hincrby(`pool:${roundId}`, field, amountMicro)
      pipe.expire(`pool:${roundId}`, 300)
      pipe.lpush(`trades:${roundId}`, JSON.stringify(trade))
      pipe.ltrim(`trades:${roundId}`, 0, 49) // keep more trades for sync
      pipe.expire(`trades:${roundId}`, 120)
      await pipe.exec()
      console.log(`[pool-store] KV bet written: round=${roundId} ${side} $${(amountMicro / 1e6).toFixed(2)} id=${id}`)
    } catch (err) {
      console.error('[pool-store] Redis WRITE failed:', (err as Error).message)
      // Fall through to in-memory so at least the current instance sees it
      writeFallback(roundId, side, amountMicro, trade)
    }
  } else {
    writeFallback(roundId, side, amountMicro, trade)
  }

  return id
}

function writeFallback(roundId: number, side: 'UP' | 'DOWN', amountMicro: number, trade: RecentTrade) {
  const pools = g.__poolCache!
  const current = pools.get(roundId) ?? { up: 0, down: 0 }
  if (side === 'UP') current.up += amountMicro
  else current.down += amountMicro
  pools.set(roundId, current)

  const trades = g.__recentTrades!
  const list = trades.get(roundId) ?? []
  list.push(trade)
  const cutoff = Date.now() - 60000
  trades.set(roundId, list.filter(t => t.ts > cutoff).slice(-30))

  // Evict old rounds
  if (pools.size > 3) {
    const sorted = [...pools.keys()].sort((a, b) => a - b)
    for (let i = 0; i < sorted.length - 3; i++) {
      pools.delete(sorted[i])
      trades.delete(sorted[i])
    }
  }
}

export async function getOptimisticPool(roundId: number): Promise<{ up: number; down: number; _kvConnected?: boolean }> {
  const kv = getRedis()
  if (kv) {
    try {
      const data = await kv.hgetall(`pool:${roundId}`)
      if (!data || Object.keys(data).length === 0) return { up: 0, down: 0, _kvConnected: true }
      return {
        up: Number((data as Record<string, unknown>).up || 0),
        down: Number((data as Record<string, unknown>).down || 0),
        _kvConnected: true,
      }
    } catch (err) {
      console.error('[pool-store] Redis READ failed:', (err as Error).message)
      // Fall through to in-memory
    }
  }
  const mem = g.__poolCache!.get(roundId) ?? { up: 0, down: 0 }
  return { ...mem, _kvConnected: false }
}

export async function getRecentTrades(roundId: number): Promise<RecentTrade[]> {
  const kv = getRedis()
  if (kv) {
    try {
      const raw: string[] = await kv.lrange(`trades:${roundId}`, 0, 49)
      if (!raw || raw.length === 0) return []
      const now = Date.now()
      return raw
        .map(item => typeof item === 'string' ? JSON.parse(item) : item)
        .filter((t: RecentTrade) => now - t.ts < 120_000) // keep trades for 2 minutes
    } catch (err) {
      console.error('[pool-store] Redis trades READ failed:', (err as Error).message)
    }
  }
  const cutoff = Date.now() - 120_000
  return (g.__recentTrades!.get(roundId) ?? []).filter(t => t.ts > cutoff)
}

// ---------------------------------------------------------------------------
// Open price (first-write-wins per round)
// ---------------------------------------------------------------------------

export async function setOpenPrice(roundId: number, price: number): Promise<boolean> {
  const kv = getRedis()
  if (kv) {
    try {
      const result = await kv.set(`open-price:${roundId}`, price, { nx: true, ex: 300 })
      return result === 'OK'
    } catch (err) {
      console.error('[pool-store] Redis setOpenPrice failed:', (err as Error).message)
    }
  }
  // In-memory fallback
  if (g.__openPriceCache!.has(roundId)) return false
  g.__openPriceCache!.set(roundId, price)
  if (g.__openPriceCache!.size > 3) {
    const sorted = [...g.__openPriceCache!.keys()].sort((a, b) => a - b)
    for (let i = 0; i < sorted.length - 3; i++) g.__openPriceCache!.delete(sorted[i])
  }
  return true
}

export async function getOpenPrice(roundId: number): Promise<number | null> {
  const kv = getRedis()
  if (kv) {
    try {
      const val = await kv.get<number>(`open-price:${roundId}`)
      return val ?? null
    } catch (err) {
      console.error('[pool-store] Redis getOpenPrice failed:', (err as Error).message)
    }
  }
  return g.__openPriceCache!.get(roundId) ?? null
}

// ---------------------------------------------------------------------------
// Sponsor nonce (cross-instance tracking)
// ---------------------------------------------------------------------------

const SPONSOR_NONCE_TTL_MS = 120_000

export async function getSponsorNonce(): Promise<{ nonce: bigint; ts: number } | null> {
  const kv = getRedis()
  if (kv) {
    const data = await kv.get<{ nonce: string; ts: number }>('sponsor-nonce')
    if (!data) return null
    if (Date.now() - data.ts > SPONSOR_NONCE_TTL_MS) return null
    return { nonce: BigInt(data.nonce), ts: data.ts }
  }
  // In-memory fallback
  const fg = globalThis as unknown as { __sponsorNonce?: bigint | null; __sponsorNonceTs?: number }
  if (fg.__sponsorNonce == null) return null
  if (Date.now() - (fg.__sponsorNonceTs ?? 0) > SPONSOR_NONCE_TTL_MS) return null
  return { nonce: fg.__sponsorNonce, ts: fg.__sponsorNonceTs ?? 0 }
}

export async function setSponsorNonce(nonce: bigint): Promise<void> {
  const kv = getRedis()
  if (kv) {
    await kv.set('sponsor-nonce', { nonce: nonce.toString(), ts: Date.now() }, { ex: 120 })
    return
  }
  const fg = globalThis as unknown as { __sponsorNonce?: bigint | null; __sponsorNonceTs?: number }
  fg.__sponsorNonce = nonce
  fg.__sponsorNonceTs = Date.now()
}

export async function clearSponsorNonce(): Promise<void> {
  const kv = getRedis()
  if (kv) {
    await kv.del('sponsor-nonce')
    return
  }
  const fg = globalThis as unknown as { __sponsorNonce?: bigint | null }
  fg.__sponsorNonce = null
}

// ---------------------------------------------------------------------------
// Sponsor lock (cross-instance serialization via Redis SETNX)
// ---------------------------------------------------------------------------

export async function acquireSponsorLock(timeoutMs = 3000): Promise<boolean> {
  const kv = getRedis()
  if (kv) {
    const result = await kv.set('sponsor-lock', '1', { nx: true, px: timeoutMs })
    return result === 'OK'
  }
  // In-memory: use promise chain (existing behaviour)
  return true // lock handled by caller's globalThis.__sponsorLock
}

export async function releaseSponsorLock(): Promise<void> {
  const kv = getRedis()
  if (kv) {
    await kv.del('sponsor-lock')
  }
}

// ---------------------------------------------------------------------------
// Jackpot: optimistic early bet tracking
// ---------------------------------------------------------------------------

export async function addOptimisticEarlyBet(
  roundId: number,
  side: 'UP' | 'DOWN',
  amountMicro: number,
): Promise<void> {
  const kv = getRedis()
  if (!kv) return
  try {
    const field = side === 'UP' ? 'early-up' : 'early-down'
    const pipe = kv.pipeline()
    pipe.hincrby(`jackpot:${roundId}`, field, amountMicro)
    pipe.expire(`jackpot:${roundId}`, 300)
    await pipe.exec()
  } catch (err) {
    console.warn('[pool-store] Redis jackpot write failed (non-fatal):', (err as Error).message)
  }
}

export async function getOptimisticEarlyBets(roundId: number): Promise<{ earlyUp: number; earlyDown: number }> {
  const kv = getRedis()
  if (!kv) return { earlyUp: 0, earlyDown: 0 }
  try {
    const data = await kv.hgetall(`jackpot:${roundId}`)
    if (!data || Object.keys(data).length === 0) return { earlyUp: 0, earlyDown: 0 }
    return {
      earlyUp: Number((data as Record<string, unknown>)['early-up'] || 0),
      earlyDown: Number((data as Record<string, unknown>)['early-down'] || 0),
    }
  } catch (err) {
    console.warn('[pool-store] Redis jackpot read failed:', (err as Error).message)
    return { earlyUp: 0, earlyDown: 0 }
  }
}

// ---------------------------------------------------------------------------
// Active users (heartbeat via ZSET — score = unix timestamp)
// ---------------------------------------------------------------------------

const ACTIVE_TTL_SECONDS = 15

export async function heartbeatAndCount(sessionId: string): Promise<number> {
  const kv = getRedis()
  if (!kv) return 1
  try {
    const now = Math.floor(Date.now() / 1000)
    const pipe = kv.pipeline()
    pipe.zadd('active-users', { score: now, member: sessionId })
    pipe.zremrangebyscore('active-users', '-inf', now - ACTIVE_TTL_SECONDS)
    pipe.zcard('active-users')
    const results = await pipe.exec()
    const count = (results[2] as number) ?? 1
    return Math.max(count, 1)
  } catch (err) {
    console.warn('[pool-store] heartbeat failed:', (err as Error).message)
    return 1
  }
}
