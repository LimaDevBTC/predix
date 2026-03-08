import { NextResponse } from 'next/server'
import { getRoundHistory, getIndexerStatus, getGlobalStats } from '@/lib/round-indexer'

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
    return NextResponse.json({ ...result, ok: true })
  } catch (e) {
    console.error('[round-history] Error:', e instanceof Error ? e.message : e)
    return NextResponse.json(
      { error: 'Failed to load round history', ok: false },
      { status: 500 },
    )
  }
}
