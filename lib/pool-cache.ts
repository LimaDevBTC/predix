/**
 * Server-side in-memory cache for optimistic pool totals.
 *
 * When a client broadcasts a bet tx, it immediately notifies the server
 * via POST /api/pool-update. The GET /api/round handler merges these
 * optimistic values with on-chain data using max(), so ALL clients see
 * pool updates within the next poll cycle (~3s) instead of waiting for
 * blockchain confirmation (~10-30s on Stacks testnet).
 *
 * All Maps are stored on globalThis to survive Next.js HMR reloads.
 */

interface RoundPool {
  up: number   // micro-units (6 decimals)
  down: number // micro-units
}

export interface RecentTrade {
  id: string
  side: 'UP' | 'DOWN'
  amount: number  // USD (not micro)
  ts: number      // Date.now() when recorded
}

const g = globalThis as unknown as {
  __poolCache?: Map<number, RoundPool>
  __openPriceCache?: Map<number, number>
  __recentTrades?: Map<number, RecentTrade[]>
}
g.__poolCache ??= new Map<number, RoundPool>()
g.__openPriceCache ??= new Map<number, number>()
g.__recentTrades ??= new Map<number, RecentTrade[]>()

const pools = g.__poolCache
const openPrices = g.__openPriceCache
const recentTrades = g.__recentTrades

/**
 * Record an optimistic bet for a round (amount in micro-units).
 * Accepts an optional tradeId (client-provided); generates one if not given.
 * Returns the tradeId used.
 */
export function addOptimisticBet(
  roundId: number,
  side: 'UP' | 'DOWN',
  amountMicro: number,
  tradeId?: string,
): string {
  const current = pools.get(roundId) ?? { up: 0, down: 0 }
  if (side === 'UP') current.up += amountMicro
  else current.down += amountMicro
  pools.set(roundId, current)

  // Record in recent trades buffer
  const id = tradeId || Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const trades = recentTrades.get(roundId) ?? []
  trades.push({ id, side, amount: amountMicro / 1e6, ts: Date.now() })
  // Keep max 20 per round, prune entries older than 60s
  const cutoff = Date.now() - 60000
  recentTrades.set(roundId, trades.filter(t => t.ts > cutoff).slice(-20))

  // Evict old rounds (keep only last 3)
  if (pools.size > 3) {
    const sortedKeys = [...pools.keys()].sort((a, b) => a - b)
    for (let i = 0; i < sortedKeys.length - 3; i++) {
      pools.delete(sortedKeys[i])
      recentTrades.delete(sortedKeys[i])
    }
  }

  return id
}

/** Get optimistic pool totals for a round (micro-units). */
export function getOptimisticPool(roundId: number): RoundPool {
  return pools.get(roundId) ?? { up: 0, down: 0 }
}

/** Get recent trades for a round (max 20, within last 60s). */
export function getRecentTrades(roundId: number): RecentTrade[] {
  const cutoff = Date.now() - 60000
  return (recentTrades.get(roundId) ?? []).filter(t => t.ts > cutoff)
}

// ============================================================================
// Open price cache — first-write-wins per round
// ============================================================================

/** Set open price for a round. Returns true if this was the first write (accepted). */
export function setOpenPrice(roundId: number, price: number): boolean {
  if (openPrices.has(roundId)) return false
  openPrices.set(roundId, price)
  // Evict old rounds (keep last 3)
  if (openPrices.size > 3) {
    const sorted = [...openPrices.keys()].sort((a, b) => a - b)
    for (let i = 0; i < sorted.length - 3; i++) openPrices.delete(sorted[i])
  }
  return true
}

/** Get the canonical open price for a round, or null if not yet set. */
export function getOpenPrice(roundId: number): number | null {
  return openPrices.get(roundId) ?? null
}
