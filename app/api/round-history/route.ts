import { NextResponse } from 'next/server'
import { getRoundHistory, getIndexerStatus, getGlobalStats } from '@/lib/round-indexer'
import { getRoundTicketsBatch } from '@/lib/jackpot'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 60

/**
 * GET /api/round-history?page=1&pageSize=10         → paginated round list
 * GET /api/round-history?roundId=29494078            → specific round lookup
 * GET /api/round-history?status=indexer              → indexer health check
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)

  // Indexer status endpoint
  if (searchParams.get('status') === 'indexer') {
    return NextResponse.json({ ...getIndexerStatus(), ok: true })
  }

  // Global stats endpoint
  if (searchParams.get('stats') === 'global') {
    return NextResponse.json({ ...(await getGlobalStats()), ok: true })
  }

  const page = Math.max(1, parseInt(searchParams.get('page') || '1'))
  const pageSize = Math.min(50, Math.max(1, parseInt(searchParams.get('pageSize') || '10')))
  const roundIdParam = searchParams.get('roundId')
  const roundId = roundIdParam ? parseInt(roundIdParam) : undefined

  try {
    const result = await getRoundHistory({ page, pageSize, roundId })

    // Enrich resolved rounds with per-round ticket data from Redis
    const resolvedIds = result.rounds
      .filter(r => r.resolved)
      .map(r => String(r.roundId))
    const ticketMap = resolvedIds.length > 0
      ? await getRoundTicketsBatch(resolvedIds)
      : new Map()

    const enrichedRounds = result.rounds.map(r => {
      const tickets = ticketMap.get(String(r.roundId))
      return {
        ...r,
        tickets: tickets || null,
        totalTickets: tickets ? tickets.reduce((s: number, t: { tickets: number }) => s + t.tickets, 0) : 0,
      }
    })

    return NextResponse.json({ ...result, rounds: enrichedRounds, ok: true })
  } catch (e) {
    console.error('[round-history] Error:', e instanceof Error ? e.message : e)
    return NextResponse.json(
      { error: 'Failed to load round history', ok: false },
      { status: 500 },
    )
  }
}
