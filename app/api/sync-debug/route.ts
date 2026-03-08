import { NextResponse } from 'next/server'
import { getOptimisticPool, getRecentTrades, isRedisConnected } from '@/lib/pool-store'

export const dynamic = 'force-dynamic'

/** GET: diagnostic endpoint to verify Redis connectivity and pool sync state. */
export async function GET() {
  const roundId = Math.floor(Date.now() / 1000 / 60)

  const kvConnected = isRedisConnected()
  const [pool, trades] = await Promise.all([
    getOptimisticPool(roundId),
    getRecentTrades(roundId),
  ])

  return NextResponse.json({
    ok: true,
    kvConnected,
    roundId,
    pool: { up: pool.up / 1e6, down: pool.down / 1e6 },
    tradeCount: trades.length,
    recentTrades: trades.slice(0, 10),
    serverNow: Date.now(),
    env: {
      hasUpstashUrl: !!(process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_KV_REST_API_URL),
      hasUpstashToken: !!(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_KV_REST_API_TOKEN),
    },
  }, {
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  })
}
