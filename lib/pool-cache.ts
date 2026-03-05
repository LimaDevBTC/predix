/**
 * Server-side in-memory cache for optimistic pool totals.
 *
 * When a client broadcasts a bet tx, it immediately notifies the server
 * via POST /api/pool-update. The GET /api/round handler merges these
 * optimistic values with on-chain data using max(), so ALL clients see
 * pool updates within the next poll cycle (~3s) instead of waiting for
 * blockchain confirmation (~10-30s on Stacks testnet).
 */

interface RoundPool {
  up: number   // micro-units (6 decimals)
  down: number // micro-units
}

const pools = new Map<number, RoundPool>()

/** Record an optimistic bet for a round (amount in micro-units). */
export function addOptimisticBet(roundId: number, side: 'UP' | 'DOWN', amountMicro: number) {
  const current = pools.get(roundId) ?? { up: 0, down: 0 }
  if (side === 'UP') current.up += amountMicro
  else current.down += amountMicro
  pools.set(roundId, current)

  // Evict old rounds (keep only last 3)
  if (pools.size > 3) {
    const sortedKeys = [...pools.keys()].sort((a, b) => a - b)
    for (let i = 0; i < sortedKeys.length - 3; i++) {
      pools.delete(sortedKeys[i])
    }
  }
}

/** Get optimistic pool totals for a round (micro-units). */
export function getOptimisticPool(roundId: number): RoundPool {
  return pools.get(roundId) ?? { up: 0, down: 0 }
}
