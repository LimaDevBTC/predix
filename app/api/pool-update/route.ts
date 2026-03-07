import { NextRequest, NextResponse } from 'next/server'
import { addOptimisticBet, getOptimisticPool } from '@/lib/pool-cache'
import { broadcastPoolUpdate } from '@/lib/pool-broadcast'

export const dynamic = 'force-dynamic'

/** Clients call this immediately after broadcasting a bet tx. */
export async function POST(request: NextRequest) {
  try {
    const { roundId, side, amountMicro, clientId, tradeId: clientTradeId } = await request.json()

    if (typeof roundId !== 'number' || roundId <= 0) {
      return NextResponse.json({ error: 'invalid roundId' }, { status: 400 })
    }
    if (side !== 'UP' && side !== 'DOWN') {
      return NextResponse.json({ error: 'invalid side' }, { status: 400 })
    }
    if (typeof amountMicro !== 'number' || amountMicro <= 0) {
      return NextResponse.json({ error: 'invalid amountMicro' }, { status: 400 })
    }

    const tradeId = addOptimisticBet(
      roundId,
      side,
      amountMicro,
      typeof clientTradeId === 'string' ? clientTradeId : undefined,
    )

    // Broadcast to all connected SSE clients so they see the update instantly
    const pool = getOptimisticPool(roundId)
    broadcastPoolUpdate({
      roundId,
      side,
      amountMicro,
      totalUp: pool.up,
      totalDown: pool.down,
      clientId: typeof clientId === 'string' ? clientId : undefined,
      tradeId,
    })

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'bad request' }, { status: 400 })
  }
}
