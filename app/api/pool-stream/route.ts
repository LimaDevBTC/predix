import { subscribePoolUpdates, subscribeOpenPrice } from '@/lib/pool-broadcast'
import { getOptimisticPool, getOpenPrice, getRecentTrades } from '@/lib/pool-cache'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * SSE endpoint — clients connect here to receive real-time pool updates.
 * When any user places a bet, all connected clients get the new pool totals instantly.
 */
export async function GET(request: Request) {
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    start(controller) {
      const send = (obj: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))
        } catch {}
      }

      // Send current pool state on connect (so late joiners catch up)
      const currentRoundId = Math.floor(Date.now() / 60000)
      const pool = getOptimisticPool(currentRoundId)
      const trades = getRecentTrades(currentRoundId)
      send({ type: 'snapshot', roundId: currentRoundId, totalUp: pool.up, totalDown: pool.down, recentTrades: trades })

      // Send current open price if already set (late joiners get it immediately)
      const openPrice = getOpenPrice(currentRoundId)
      if (openPrice !== null) {
        send({ type: 'open-price', roundId: currentRoundId, price: openPrice })
      }

      // Subscribe to live updates
      const unsub = subscribePoolUpdates((data) => {
        send({ type: 'pool-update', ...data })
      })

      // Subscribe to open price broadcasts
      const unsubOpen = subscribeOpenPrice((data) => {
        send({ type: 'open-price', ...data })
      })

      // Heartbeat every 25s to keep connection alive through proxies
      const heartbeat = setInterval(() => {
        send({ type: 'heartbeat' })
      }, 25000)

      // Cleanup when client disconnects
      request.signal.addEventListener('abort', () => {
        unsub()
        unsubOpen()
        clearInterval(heartbeat)
        try { controller.close() } catch {}
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx
    },
  })
}
