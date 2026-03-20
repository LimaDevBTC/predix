'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Ticket, Clock } from 'lucide-react'

// ============================================================================
// TYPES (mirrors lib/round-indexer.ts)
// ============================================================================

interface IndexedBet {
  txId: string
  user: string
  side: 'UP' | 'DOWN'
  amount: number
  amountUsd: number
  timestamp: number
  status: string
  early?: boolean
}

interface TicketResult {
  user: string
  tickets: number
  multiplier: number
  isFirst: boolean
  isLargest: boolean
}

interface IndexedRound {
  roundId: number
  startTimestamp: number
  endTimestamp: number
  totalUpUsd: number
  totalDownUsd: number
  totalPoolUsd: number
  resolved: boolean
  outcome: 'UP' | 'DOWN' | null
  priceStart: number | null
  priceEnd: number | null
  bets: IndexedBet[]
  participantCount: number
  tickets?: TicketResult[] | null
  totalTickets?: number
}

// ============================================================================
// HELPERS
// ============================================================================

const PAGE_SIZE = 10

function timeAgo(ts: number): string {
  const now = Math.floor(Date.now() / 1000)
  const diff = now - ts
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`
  return new Date(ts * 1000).toLocaleDateString()
}

function formatRoundTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatUsd(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatPrice(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function shortenAddress(addr: string): string {
  if (addr.length <= 10) return addr.toLowerCase()
  return (addr.slice(0, 4) + '\u2026' + addr.slice(-4)).toLowerCase()
}

// ============================================================================
// HELPERS
// ============================================================================

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toFixed(0)
}

// ============================================================================
// STAT CARD
// ============================================================================

function GlobalStatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 overflow-hidden">
      <div className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</div>
      <div className="text-sm font-mono text-zinc-200 mt-0.5 truncate">{value}</div>
    </div>
  )
}

// ============================================================================
// TYPES (global stats)
// ============================================================================

interface GlobalStats {
  totalVolume: number
  totalRounds: number
  resolvedRounds: number
  upWins: number
  downWins: number
  uniqueWallets: number
  largestPool: number
  avgPoolSize: number
}

// ============================================================================
// COMPONENT
// ============================================================================

export function RoundExplorer({ initialRoundId }: { initialRoundId?: number }) {
  const [rounds, setRounds] = useState<IndexedRound[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [total, setTotal] = useState(0)
  const [expandedRoundId, setExpandedRoundId] = useState<number | null>(initialRoundId ?? null)
  const [searchQuery, setSearchQuery] = useState(initialRoundId ? String(initialRoundId) : '')
  const [searchActive, setSearchActive] = useState(!!initialRoundId)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [stats, setStats] = useState<GlobalStats | null>(null)
  const [jackpot, setJackpot] = useState<{ balance: number; totalTickets: number } | null>(null)

  // Fetch paginated rounds
  const fetchRounds = useCallback(async (pageNum: number, append: boolean) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/round-history?page=${pageNum}&pageSize=${PAGE_SIZE}`)
      if (!res.ok) throw new Error('Failed to fetch')
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || 'Unknown error')

      setRounds((prev) => (append ? [...prev, ...data.rounds] : data.rounds))
      setHasMore(data.hasMore)
      setTotal(data.total)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  // Search by round ID
  const searchRound = useCallback(async (query: string) => {
    const roundId = parseInt(query.trim())
    if (isNaN(roundId)) {
      setError('Enter a valid round ID (number)')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/round-history?roundId=${roundId}`)
      if (!res.ok) throw new Error('Round not found')
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || 'Round not found')

      if (data.rounds.length === 0) {
        setError(`Round ${roundId} not found. It may have had no predictions.`)
        setRounds([])
      } else {
        setRounds(data.rounds)
        setExpandedRoundId(roundId)
      }
      setHasMore(false)
      setTotal(data.rounds.length)
      setSearchActive(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Not found')
      setRounds([])
    } finally {
      setLoading(false)
    }
  }, [])

  const clearSearch = useCallback(() => {
    setSearchQuery('')
    setSearchActive(false)
    setExpandedRoundId(null)
    setPage(1)
    fetchRounds(1, false)
  }, [fetchRounds])

  // Initial load
  useEffect(() => {
    if (initialRoundId) {
      searchRound(String(initialRoundId))
    } else {
      fetchRounds(1, false)
    }
  }, [fetchRounds, searchRound, initialRoundId])

  // Fetch global stats + jackpot
  useEffect(() => {
    fetch('/api/round-history?stats=global')
      .then(r => r.json())
      .then(data => { if (data.ok) setStats(data) })
      .catch(() => {})
    fetch('/api/jackpot/status')
      .then(r => r.json())
      .then(data => { if (data.ok) setJackpot({ balance: data.balance, totalTickets: data.totalTickets }) })
      .catch(() => {})
  }, [])

  // Listen for new bets/claims
  useEffect(() => {
    const onUpdate = () => {
      if (!searchActive) {
        setTimeout(() => fetchRounds(1, false), 5000)
      }
    }
    window.addEventListener('bitpredix:balance-changed', onUpdate)
    return () => window.removeEventListener('bitpredix:balance-changed', onUpdate)
  }, [fetchRounds, searchActive])

  const loadMore = () => {
    if (loading || !hasMore) return
    const nextPage = page + 1
    setPage(nextPage)
    fetchRounds(nextPage, true)
  }

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (searchQuery.trim()) {
      searchRound(searchQuery)
    }
  }

  const toggleExpand = (roundId: number) => {
    setExpandedRoundId((prev) => (prev === roundId ? null : roundId))
  }

  return (
    <div className="space-y-4">
      {/* Search bar */}
      <div className="flex items-center gap-2">
        <form onSubmit={handleSearchSubmit} className="flex-1 flex gap-2">
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by round ID..."
            className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
          />
          <button
            type="submit"
            disabled={loading || !searchQuery.trim()}
            className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 text-sm rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Search
          </button>
        </form>
        {searchActive && (
          <button
            onClick={clearSearch}
            className="px-3 py-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {/* Global stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <GlobalStatCard label="Total Volume" value={`$${formatCompact(stats.totalVolume)}`} />
          <GlobalStatCard label="Rounds Played" value={String(stats.totalRounds)} />
          <GlobalStatCard label="Unique Traders" value={String(stats.uniqueWallets)} />
          <GlobalStatCard label="UP Win Rate" value={`${stats.resolvedRounds > 0 ? ((stats.upWins / stats.resolvedRounds) * 100).toFixed(0) : 0}%`} />
        </div>
      )}

      {/* Jackpot banner */}
      {jackpot && (
        <a
          href="/jackpot"
          className="flex items-center justify-between rounded-xl border border-bitcoin/20 bg-gradient-to-r from-bitcoin/[0.06] via-bitcoin/[0.03] to-transparent px-4 py-3 hover:from-bitcoin/[0.10] hover:via-bitcoin/[0.05] transition-all group"
        >
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-bitcoin">Daily Jackpot</span>
            <span className="text-zinc-400 text-xs font-mono">
              Prize: <span className="text-zinc-200 font-bold">${(jackpot.balance * 0.10).toFixed(0)}</span>
            </span>
            <span className="hidden sm:inline text-zinc-500 text-xs">|</span>
            <span className="hidden sm:inline text-zinc-400 text-xs font-mono">
              Tickets today: <span className="text-zinc-200 font-bold">{jackpot.totalTickets}</span>
            </span>
          </div>
          <span className="text-[10px] text-zinc-500 group-hover:text-bitcoin/60 transition-colors">
            View &rarr;
          </span>
        </a>
      )}

      {/* Stats bar */}
      <div className="flex items-center gap-4 text-xs text-zinc-500">
        <span>{total} round{total !== 1 ? 's' : ''} indexed</span>
        {searchActive && (
          <span className="text-bitcoin">Showing search results</span>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="text-xs text-red-400/80 bg-red-500/5 rounded-lg px-3 py-2 border border-red-500/10">
          {error}
        </div>
      )}

      {/* Loading (initial) */}
      {loading && rounds.length === 0 && !error && (
        <div className="flex items-center gap-2 text-zinc-500 text-xs py-8 justify-center">
          <div className="h-4 w-4 border-2 border-zinc-500 border-t-transparent rounded-full animate-spin" />
          Indexing contract transactions...
        </div>
      )}

      {/* Empty */}
      {!loading && rounds.length === 0 && !error && (
        <div className="text-center py-8 text-zinc-500 text-sm">
          No rounds found.
        </div>
      )}

      {/* Round list */}
      {rounds.length > 0 && (
        <div className="space-y-2">
          {rounds.map((round) => (
            <RoundRow
              key={round.roundId}
              round={round}
              expanded={expandedRoundId === round.roundId}
              onToggle={() => toggleExpand(round.roundId)}
            />
          ))}
        </div>
      )}

      {/* Load more */}
      {hasMore && !searchActive && (
        <button
          onClick={loadMore}
          disabled={loading}
          className="w-full py-3 text-sm text-zinc-500 hover:text-zinc-300 bg-zinc-900/50 border border-zinc-800 rounded-lg transition-colors disabled:opacity-50"
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <span className="h-3 w-3 border border-zinc-500 border-t-transparent rounded-full animate-spin" />
              Loading...
            </span>
          ) : (
            'Load more rounds'
          )}
        </button>
      )}
    </div>
  )
}

// ============================================================================
// ROUND ROW (collapsible)
// ============================================================================

function RoundRow({
  round,
  expanded,
  onToggle,
}: {
  round: IndexedRound
  expanded: boolean
  onToggle: () => void
}) {
  const upPct = round.totalPoolUsd > 0
    ? (round.totalUpUsd / round.totalPoolUsd) * 100
    : 50

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden transition-colors hover:border-zinc-700/60">
      {/* Header row (clickable) */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-zinc-800/30"
      >
        {/* Expand indicator */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className={`h-3 w-3 text-zinc-600 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>

        {/* Outcome badge */}
        <div
          className={`shrink-0 w-9 h-9 rounded-lg border flex items-center justify-center text-xs font-bold ${
            round.outcome === 'UP'
              ? 'text-up bg-up/10 border-up/30'
              : round.outcome === 'DOWN'
                ? 'text-down bg-down/10 border-down/30'
                : 'text-zinc-400 bg-zinc-400/10 border-zinc-400/30'
          }`}
        >
          {round.outcome === 'UP' ? 'UP' : round.outcome === 'DOWN' ? 'DN' : '...'}
        </div>

        {/* Round info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-zinc-200 font-medium text-sm">
              Round {round.roundId}
            </span>
            <span className="text-zinc-600 text-[10px]">
              {formatRoundTime(round.startTimestamp)}
            </span>
          </div>
          <div className="flex items-center gap-3 mt-0.5">
            {/* Pool bar */}
            <div className="flex-1 h-1.5 rounded-full overflow-hidden flex bg-zinc-800 max-w-[120px]">
              <div className="bg-up/70 transition-all" style={{ width: `${upPct}%` }} />
              <div className="bg-down/70 transition-all" style={{ width: `${100 - upPct}%` }} />
            </div>
            <span className="text-zinc-500 text-[10px]">
              ${formatUsd(round.totalPoolUsd)} pool
            </span>
            <span className="text-zinc-600 text-[10px]">
              {round.participantCount} predictor{round.participantCount !== 1 ? 's' : ''}
            </span>
            {round.totalTickets != null && round.totalTickets > 0 && (
              <span className="inline-flex items-center gap-0.5 text-bitcoin/70 text-[10px]">
                <Ticket size={8} />
                {round.totalTickets}
              </span>
            )}
          </div>
        </div>

        {/* Time ago */}
        <div className="shrink-0 text-zinc-600 text-[10px]">
          {round.startTimestamp > 0 ? timeAgo(round.startTimestamp) : ''}
        </div>
      </button>

      {/* Expanded detail panel */}
      {expanded && (
        <div className="border-t border-zinc-800 px-4 py-3 space-y-3">
          {/* Prices */}
          {round.resolved && round.priceStart !== null && round.priceEnd !== null && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-zinc-500">Open:</span>
              <span className="text-zinc-300 font-medium">${formatPrice(round.priceStart)}</span>
              <span className="text-zinc-600">&rarr;</span>
              <span className="text-zinc-500">Close:</span>
              <span className={`font-medium ${
                round.outcome === 'UP' ? 'text-up' : round.outcome === 'DOWN' ? 'text-down' : 'text-zinc-300'
              }`}>
                ${formatPrice(round.priceEnd)}
              </span>
              {round.priceEnd !== null && round.priceStart !== null && (
                <span className={`text-[10px] ${
                  round.priceEnd > round.priceStart ? 'text-up' : 'text-down'
                }`}>
                  ({round.priceEnd > round.priceStart ? '+' : ''}{((round.priceEnd - round.priceStart) / round.priceStart * 100).toFixed(3)}%)
                </span>
              )}
            </div>
          )}

          {!round.resolved && (
            <div className="text-xs text-zinc-500">
              Round not yet resolved. Prices will appear after the first claim.
            </div>
          )}

          {/* Pool breakdown */}
          <div className="flex items-center gap-4 text-xs">
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-up/70" />
              <span className="text-zinc-400">UP:</span>
              <span className="text-zinc-300 font-medium">${formatUsd(round.totalUpUsd)}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-down/70" />
              <span className="text-zinc-400">DOWN:</span>
              <span className="text-zinc-300 font-medium">${formatUsd(round.totalDownUsd)}</span>
            </div>
            <div className="text-zinc-600">= ${formatUsd(round.totalPoolUsd)} total</div>
          </div>

          {/* Pool ratio bar (larger) */}
          <div className="h-2 rounded-full overflow-hidden flex bg-zinc-800">
            <div className="bg-up/70 transition-all" style={{ width: `${upPct}%` }} />
            <div className="bg-down/70 transition-all" style={{ width: `${100 - upPct}%` }} />
          </div>
          <div className="flex justify-between text-[10px] text-zinc-600">
            <span>{upPct.toFixed(0)}% UP</span>
            <span>{(100 - upPct).toFixed(0)}% DOWN</span>
          </div>

          {/* Participants table */}
          {round.bets.length > 0 && (() => {
            const ticketMap = new Map<string, TicketResult>()
            if (round.tickets) {
              for (const t of round.tickets) ticketMap.set(t.user, t)
            }
            const hasTickets = ticketMap.size > 0

            return (
            <div className="mt-2">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-zinc-500 font-medium">
                  Participants ({round.bets.length})
                </span>
                {round.totalTickets != null && round.totalTickets > 0 && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-bitcoin/10 text-bitcoin text-[10px] font-mono font-bold">
                    <Ticket size={9} />
                    {round.totalTickets.toLocaleString()} tickets
                  </span>
                )}
              </div>
              <div className="rounded-lg border border-zinc-800 overflow-hidden">
                {/* Table header */}
                <div className={`flex px-2 sm:px-3 py-1.5 bg-zinc-800/50 text-[10px] text-zinc-500 font-medium uppercase tracking-wider`}>
                  <span className="w-[28%] sm:w-[30%]">Wallet</span>
                  <span className="w-[12%] text-center">Side</span>
                  <span className="w-[22%] sm:w-[20%] text-right">Amt</span>
                  {hasTickets && <span className="w-[12%] sm:w-[12%] text-right">Tkts</span>}
                  <span className={`${hasTickets ? 'w-[26%] sm:w-[26%]' : 'w-[38%] sm:w-[38%]'} text-right`}>Result</span>
                </div>
                {/* Rows */}
                {round.bets
                  .filter((b) => b.status === 'success' || b.status === 'pending')
                  .sort((a, b) => {
                    if (a.status !== b.status) return a.status === 'success' ? -1 : 1
                    return b.amountUsd - a.amountUsd
                  })
                  .map((bet) => {
                    const isPending = bet.status === 'pending'
                    const won = !isPending && round.resolved && bet.side === round.outcome
                    const lost = !isPending && round.resolved && bet.side !== round.outcome
                    const userTicket = ticketMap.get(bet.user)

                    return (
                      <div
                        key={bet.txId}
                        className={`flex items-center px-2 sm:px-3 py-2 border-t border-zinc-800/50 text-xs hover:bg-zinc-800/20 transition-colors ${isPending ? 'opacity-60' : ''}`}
                      >
                        {/* Wallet */}
                        <a
                          href={`/profile/${bet.user}`}
                          className="w-[28%] sm:w-[30%] text-zinc-400 hover:text-zinc-200 transition-colors font-mono text-[11px] truncate"
                          title={bet.user}
                        >
                          {shortenAddress(bet.user)}
                        </a>

                        {/* Side */}
                        <span className={`w-[12%] text-center font-medium ${
                          bet.side === 'UP' ? 'text-up' : 'text-down'
                        }`}>
                          {bet.side}
                        </span>

                        {/* Amount */}
                        <span className="w-[22%] sm:w-[20%] text-right text-zinc-300 font-mono">
                          ${formatUsd(bet.amountUsd)}
                        </span>

                        {/* Tickets */}
                        {hasTickets && (
                          <span className="w-[12%] text-right font-mono text-bitcoin">
                            {userTicket ? userTicket.tickets : <span className="text-zinc-600">—</span>}
                          </span>
                        )}

                        {/* Result */}
                        <span className={`${hasTickets ? 'w-[26%]' : 'w-[38%]'} text-right font-medium font-mono ${
                          isPending ? 'text-yellow-500' : won ? 'text-up' : lost ? 'text-down' : 'text-zinc-500'
                        }`}>
                          {(() => {
                            if (isPending) return <><Clock size={10} /> Pending</>
                            if (won) {
                              const winningPoolUsd = round.outcome === 'UP' ? round.totalUpUsd : round.totalDownUsd
                              const payout = winningPoolUsd > 0 ? (bet.amountUsd / winningPoolUsd) * round.totalPoolUsd * 0.97 : 0
                              const netProfit = payout - bet.amountUsd
                              return <>+${formatUsd(netProfit)}</>
                            }
                            if (lost) return <>-${formatUsd(bet.amountUsd)}</>
                            return <><Clock size={10} /> Pending</>
                          })()}
                        </span>
                      </div>
                    )
                  })}
              </div>
            </div>
            )
          })()}

          {/* Explorer link */}
          <div className="flex justify-end pt-1">
            <a
              href={`https://explorer.hiro.so/txid/${round.bets[0]?.txId}?chain=testnet`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors flex items-center gap-1"
            >
              View on Explorer
              <svg xmlns="http://www.w3.org/2000/svg" className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          </div>
        </div>
      )}
    </div>
  )
}
