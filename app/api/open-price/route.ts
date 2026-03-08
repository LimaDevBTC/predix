import { NextRequest, NextResponse } from 'next/server'
import { setOpenPrice, getOpenPrice } from '@/lib/pool-store'

export const dynamic = 'force-dynamic'

/**
 * POST /api/open-price — first client to detect a round transition
 * sends its live Pyth price. Server stores it (first-write-wins via KV SET NX).
 *
 * GET /api/open-price?roundId=N — returns the stored open price (if any).
 */
export async function POST(request: NextRequest) {
  try {
    const { roundId, price } = await request.json()

    if (typeof roundId !== 'number' || roundId <= 0) {
      return NextResponse.json({ error: 'invalid roundId' }, { status: 400 })
    }
    if (typeof price !== 'number' || price <= 0) {
      return NextResponse.json({ error: 'invalid price' }, { status: 400 })
    }

    const accepted = await setOpenPrice(roundId, price)

    // Always return the canonical price (may differ from what was sent if another client was first)
    const canonical = await getOpenPrice(roundId)
    return NextResponse.json({ ok: true, accepted, price: canonical })
  } catch {
    return NextResponse.json({ error: 'bad request' }, { status: 400 })
  }
}

export async function GET(request: NextRequest) {
  const roundId = parseInt(request.nextUrl.searchParams.get('roundId') ?? '')
  if (isNaN(roundId) || roundId <= 0) {
    return NextResponse.json({ error: 'invalid roundId' }, { status: 400 })
  }

  const price = await getOpenPrice(roundId)
  return NextResponse.json({ ok: true, price })
}
