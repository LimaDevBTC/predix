import { NextResponse } from 'next/server'
import { getLeaderboard } from '@/lib/round-indexer'
import type { LeaderboardSortBy } from '@/lib/round-indexer'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 60

const VALID_SORT: LeaderboardSortBy[] = ['pnl', 'volume', 'winRate', 'totalBets', 'roi']

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)

  const sortBy = (searchParams.get('sortBy') || 'pnl') as LeaderboardSortBy
  if (!VALID_SORT.includes(sortBy)) {
    return NextResponse.json({ error: 'Invalid sortBy', ok: false }, { status: 400 })
  }

  const page = Math.max(1, parseInt(searchParams.get('page') || '1'))
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') || '50')))
  const search = searchParams.get('search') || undefined

  try {
    const result = await getLeaderboard(sortBy, page, pageSize, search)
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    console.error('[leaderboard] Error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Failed to load leaderboard', ok: false }, { status: 500 })
  }
}
