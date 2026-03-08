import { NextRequest, NextResponse } from 'next/server'
import { addOptimisticBet } from '@/lib/pool-store'

export const dynamic = 'force-dynamic'

/** Clients call this immediately after broadcasting a bet tx. */
export async function POST(request: NextRequest) {
  try {
    const { roundId, side, amountMicro, tradeId: clientTradeId } = await request.json()

    if (typeof roundId !== 'number' || roundId <= 0) {
      return NextResponse.json({ error: 'invalid roundId' }, { status: 400 })
    }
    if (side !== 'UP' && side !== 'DOWN') {
      return NextResponse.json({ error: 'invalid side' }, { status: 400 })
    }
    if (typeof amountMicro !== 'number' || amountMicro <= 0) {
      return NextResponse.json({ error: 'invalid amountMicro' }, { status: 400 })
    }

    const tradeId = await addOptimisticBet(
      roundId,
      side,
      amountMicro,
      typeof clientTradeId === 'string' ? clientTradeId : undefined,
    )

    // No broadcast needed — all clients poll from shared KV
    return NextResponse.json({ ok: true, tradeId })
  } catch {
    return NextResponse.json({ error: 'bad request' }, { status: 400 })
  }
}
