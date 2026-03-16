'use client'

import { useState, useEffect, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { Footer } from './Footer'

const EquityCurveChart = dynamic(() => import('./EquityCurveChart'), {
  ssr: false,
  loading: () => <div className="h-[280px] animate-pulse bg-zinc-800/50 rounded-lg" />,
})

// ============================================================================
// TYPES (mirrors lib/round-indexer.ts WalletProfile)
// ============================================================================

interface ProfileBetRecord {
  roundId: number
  timestamp: number
  side: 'UP' | 'DOWN'
  amountUsd: number
  outcome: 'UP' | 'DOWN' | null
  resolved: boolean
  totalPool: number
  winningPool: number
  pnl: number
  poolSharePct: number
  priceStart: number | null
  priceEnd: number | null
  txId: string
  early: boolean
  jackpotBonus: number
}

interface EquityPoint {
  time: number
  value: number
}

interface ProfileStats {
  totalBets: number
  totalVolumeUsd: number
  wins: number
  losses: number
  pending: number
  winRate: number
  totalPnl: number
  roi: number
  bestWin: number
  worstLoss: number
  avgBetSize: number
  longestWinStreak: number
  longestLoseStreak: number
  currentStreak: { type: 'win' | 'loss'; count: number }
  sideDistribution: { upVolume: number; downVolume: number }
}

interface WalletProfile {
  address: string
  firstSeen: number
  stats: ProfileStats
  equityCurve: EquityPoint[]
  recentBets: ProfileBetRecord[]
  totalBetRecords: number
}

// ============================================================================
// HELPERS
// ============================================================================

function shortenAddress(addr: string): string {
  if (addr.length <= 14) return addr
  return addr.slice(0, 8) + '...' + addr.slice(-6)
}

function formatUsd(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatPrice(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function timeAgo(ts: number): string {
  const now = Math.floor(Date.now() / 1000)
  const diff = now - ts
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`
  return new Date(ts * 1000).toLocaleDateString()
}

function formatDate(ts: number): string {
  if (ts === 0) return 'Unknown'
  return new Date(ts * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

// ============================================================================
// IDENTICON
// ============================================================================

function generateIdenticon(address: string): { grid: boolean[][]; color: string; bg: string } {
  let hash = 0
  for (let i = 0; i < address.length; i++) {
    hash = ((hash << 5) - hash) + address.charCodeAt(i)
    hash |= 0
  }

  const grid: boolean[][] = []
  for (let y = 0; y < 5; y++) {
    const row: boolean[] = []
    for (let x = 0; x < 3; x++) {
      row.push(((hash >> (y * 3 + x)) & 1) === 1)
    }
    grid.push([row[0], row[1], row[2], row[1], row[0]])
  }

  const hue = Math.abs(hash) % 360
  const color = `hsl(${hue}, 65%, 55%)`
  const bg = `hsl(${hue}, 20%, 15%)`

  return { grid, color, bg }
}

function Identicon({ address }: { address: string }) {
  const { grid, color, bg } = generateIdenticon(address)
  return (
    <div
      className="w-12 h-12 rounded-xl grid grid-cols-5 grid-rows-5 gap-px p-1 shrink-0"
      style={{ backgroundColor: bg }}
    >
      {grid.flat().map((filled, i) => (
        <div
          key={i}
          className="rounded-[2px]"
          style={{ backgroundColor: filled ? color : 'transparent' }}
        />
      ))}
    </div>
  )
}

// ============================================================================
// STAT CARD
// ============================================================================

function StatCard({ label, value, subtext, color, large }: {
  label: string
  value: string
  subtext?: string
  color?: 'up' | 'down' | 'default'
  large?: boolean
}) {
  return (
    <div className={`bg-zinc-900/50 rounded-xl border border-zinc-800 p-4 ${large ? 'col-span-2' : ''}`}>
      <div className="text-xs text-zinc-500 mb-1">{label}</div>
      <div className={`font-mono text-lg sm:text-xl font-bold ${
        color === 'up' ? 'text-up' : color === 'down' ? 'text-down' : 'text-zinc-100'
      }`}>
        {value}
      </div>
      {subtext && <div className="text-[11px] text-zinc-500 mt-0.5">{subtext}</div>}
    </div>
  )
}

// ============================================================================
// WIN RATE RING
// ============================================================================

function WinRateRing({ rate }: { rate: number }) {
  const pct = rate * 100
  const circumference = 2 * Math.PI * 24
  const offset = circumference * (1 - rate)

  return (
    <svg width="56" height="56" className="shrink-0">
      <circle cx="28" cy="28" r="24" fill="none" stroke="#27272a" strokeWidth="4" />
      <circle cx="28" cy="28" r="24" fill="none"
        stroke="#22C55E" strokeWidth="4"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform="rotate(-90 28 28)"
      />
      <text x="28" y="32" textAnchor="middle" className="fill-zinc-100 text-xs font-mono font-bold">
        {pct.toFixed(0)}%
      </text>
    </svg>
  )
}

// ============================================================================
// BET HISTORY ROW
// ============================================================================

function BetRow({ bet, expanded, onToggle }: {
  bet: ProfileBetRecord
  expanded: boolean
  onToggle: () => void
}) {
  const won = bet.resolved && bet.pnl >= 0
  const lost = bet.resolved && bet.pnl < 0

  return (
    <div className="border-b border-zinc-800/50 last:border-b-0">
      {/* Mobile summary row */}
      <button
        onClick={onToggle}
        className="sm:hidden w-full px-3 py-2.5 text-left hover:bg-zinc-800/20 transition-colors"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`text-xs font-medium ${bet.side === 'UP' ? 'text-up' : 'text-down'}`}>
              {bet.side} {bet.side === 'UP' ? '\u2191' : '\u2193'}
              {bet.early && <span className="ml-1 text-[9px] text-bitcoin/70" title="Jackpot eligible">J</span>}
            </span>
            <span className="text-zinc-300 font-mono text-xs">${formatUsd(bet.amountUsd)}</span>
          </div>
          <span className={`text-xs font-mono font-medium ${
            !bet.resolved ? 'text-zinc-500' : bet.pnl >= 0 ? 'text-up' : 'text-down'
          }`}>
            {!bet.resolved ? '-' : `${bet.pnl >= 0 ? '+' : ''}$${formatUsd(Math.abs(bet.pnl))}`}
          </span>
        </div>
        <div className="flex items-center justify-between mt-1">
          <span className="text-[10px] text-zinc-500">{timeAgo(bet.timestamp)}</span>
          <span className={`text-[10px] ${
            !bet.resolved ? 'text-zinc-500' :
            bet.outcome === bet.side ? 'text-up' : 'text-down'
          }`}>
            {!bet.resolved ? 'pending' : `${bet.outcome === bet.side ? 'Won \u2713' : 'Lost \u2717'}`}
          </span>
        </div>
      </button>

      {/* Desktop summary row */}
      <button
        onClick={onToggle}
        className="hidden sm:flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-zinc-800/20 transition-colors"
      >
        {/* Time */}
        <span className="text-zinc-500 text-[11px] w-16 shrink-0">
          {timeAgo(bet.timestamp)}
        </span>

        {/* Side */}
        <span className={`text-xs font-medium w-12 shrink-0 whitespace-nowrap ${
          bet.side === 'UP' ? 'text-up' : 'text-down'
        }`}>
          {bet.side} {bet.side === 'UP' ? '\u2191' : '\u2193'}
          {bet.early && <span className="ml-1 text-[9px] text-bitcoin/70" title="Jackpot eligible">J</span>}
        </span>

        {/* Amount */}
        <span className="text-zinc-300 text-xs font-mono w-20 shrink-0 text-right">
          ${formatUsd(bet.amountUsd)}
        </span>

        {/* Pool % */}
        <span className="text-zinc-500 text-[11px] w-14 shrink-0 text-right">
          {bet.poolSharePct.toFixed(1)}%
        </span>

        {/* Outcome */}
        <span className={`text-xs w-16 shrink-0 text-right whitespace-nowrap ${
          !bet.resolved ? 'text-zinc-500' :
          bet.outcome === bet.side ? 'text-up' : 'text-down'
        }`}>
          {!bet.resolved ? 'pending' : `${bet.outcome} ${bet.outcome === bet.side ? '\u2713' : '\u2717'}`}
        </span>

        {/* P&L */}
        <span className={`text-xs font-mono font-medium flex-1 text-right ${
          !bet.resolved ? 'text-zinc-500' :
          bet.pnl >= 0 ? 'text-up' : 'text-down'
        }`}>
          {!bet.resolved ? '-' : `${bet.pnl >= 0 ? '+' : ''}$${formatUsd(Math.abs(bet.pnl))}`}
        </span>

        {/* Expand chevron */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className={`h-3 w-3 text-zinc-600 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="px-3 pb-3 pt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-500 bg-zinc-800/10">
          <span>Round <span className="text-zinc-300">{bet.roundId}</span></span>
          {bet.priceStart !== null && bet.priceEnd !== null && (
            <span>
              BTC: <span className="text-zinc-300">${formatPrice(bet.priceStart)}</span>
              {' \u2192 '}
              <span className={bet.priceEnd > bet.priceStart ? 'text-up' : 'text-down'}>
                ${formatPrice(bet.priceEnd)}
              </span>
            </span>
          )}
          <span>Pool: <span className="text-zinc-300">${formatUsd(bet.totalPool)}</span></span>
          {bet.jackpotBonus > 0 && (
            <span className="text-bitcoin">Jackpot: +${formatUsd(bet.jackpotBonus)}</span>
          )}
          <a
            href={`https://explorer.hiro.so/txid/${bet.txId}?chain=testnet`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1"
          >
            View tx
            <svg xmlns="http://www.w3.org/2000/svg" className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

const FILTERS = ['All', 'Wins', 'Losses', 'Pending'] as const
type Filter = typeof FILTERS[number]

export default function ProfilePage({ address }: { address: string }) {
  const [profile, setProfile] = useState<WalletProfile | null>(null)
  const [balance, setBalance] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [loadingMore, setLoadingMore] = useState(false)
  const [activeFilter, setActiveFilter] = useState<Filter>('All')
  const [expandedBetIdx, setExpandedBetIdx] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)

  const fetchProfile = useCallback(async (pageNum: number, append: boolean) => {
    if (append) setLoadingMore(true)
    else setLoading(true)
    setError(null)

    try {
      const res = await fetch(`/api/profile?address=${encodeURIComponent(address)}&page=${pageNum}&pageSize=20`)
      if (!res.ok) throw new Error('Failed to fetch profile')
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || 'Failed')

      if (append && profile) {
        setProfile({
          ...data.profile,
          recentBets: [...profile.recentBets, ...data.profile.recentBets],
        })
      } else {
        setProfile(data.profile)
      }
      setBalance(data.balance ?? 0)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load profile')
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [address, profile])

  useEffect(() => {
    setPage(1)
    setProfile(null)
    fetchProfile(1, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address])

  const loadMore = () => {
    if (loadingMore) return
    const next = page + 1
    setPage(next)
    fetchProfile(next, true)
  }

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* noop */ }
  }

  const filteredBets = (profile?.recentBets ?? []).filter((bet) => {
    if (activeFilter === 'All') return true
    if (activeFilter === 'Wins') return bet.resolved && bet.pnl >= 0
    if (activeFilter === 'Losses') return bet.resolved && bet.pnl < 0
    if (activeFilter === 'Pending') return !bet.resolved
    return true
  })

  const stats = profile?.stats
  const hasMore = profile ? profile.recentBets.length < profile.totalBetRecords : false

  return (
    <main className="min-h-screen bg-zinc-950">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
        {/* Address card */}
        <div className="bg-zinc-900/50 rounded-xl border border-zinc-800 p-4 sm:p-5 mb-6">
          <div className="flex items-center gap-4">
            <Identicon address={address} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-zinc-100 font-mono text-sm sm:text-base font-medium truncate">
                  {shortenAddress(address)}
                </span>
                <button
                  onClick={copyAddress}
                  className="text-zinc-600 hover:text-zinc-300 transition-colors shrink-0"
                  title="Copy address"
                >
                  {copied ? (
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-up" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                  )}
                </button>
              </div>
              <div className="flex items-center gap-3 mt-1 text-xs text-zinc-500 flex-wrap">
                {profile && profile.firstSeen > 0 && (
                  <span>Member since {formatDate(profile.firstSeen)}</span>
                )}
                {balance > 0 && (
                  <span className="text-zinc-400">
                    Balance: <span className="font-mono text-zinc-300">${formatUsd(balance)}</span> USDCx
                  </span>
                )}
              </div>
            </div>
          </div>
          {/* Explorer link */}
          <div className="mt-3 pt-3 border-t border-zinc-800/50">
            <a
              href={`https://explorer.hiro.so/address/${address}?chain=testnet`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors flex items-center gap-1"
            >
              View on Hiro Explorer
              <svg xmlns="http://www.w3.org/2000/svg" className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          </div>
        </div>

        {/* Loading skeleton */}
        {loading && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {[...Array(8)].map((_, i) => (
                <div key={i} className={`bg-zinc-900/50 rounded-xl border border-zinc-800 p-4 h-20 animate-pulse ${i === 0 ? 'col-span-2' : ''}`} />
              ))}
            </div>
            <div className="bg-zinc-900/50 rounded-xl border border-zinc-800 h-[320px] animate-pulse" />
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="text-sm text-red-400/80 bg-red-500/5 rounded-xl px-4 py-3 border border-red-500/10 mb-4">
            {error}
          </div>
        )}

        {/* Empty state */}
        {!loading && profile && stats && stats.totalBets === 0 && (
          <div className="text-center py-16">
            <div className="text-zinc-500 text-lg font-medium mb-2">No predictions yet</div>
            <div className="text-zinc-600 text-sm">This address hasn&apos;t placed any predictions yet.</div>
          </div>
        )}

        {/* Stats + content (only if has bets) */}
        {!loading && profile && stats && stats.totalBets > 0 && (
          <div className="space-y-4">
            {/* Performance — hero card */}
            <div className="bg-zinc-900/50 rounded-xl border border-zinc-800 p-4 sm:p-5">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                {/* P&L + ROI */}
                <div className="flex-1 min-w-[140px]">
                  <div className="text-xs text-zinc-500 mb-1">Total P&L</div>
                  <div className={`font-mono text-2xl sm:text-3xl font-bold ${
                    stats.totalPnl >= 0 ? 'text-up' : 'text-down'
                  }`}>
                    {stats.totalPnl >= 0 ? '+' : ''}${formatUsd(Math.abs(stats.totalPnl))}
                  </div>
                  <div className={`text-xs font-mono mt-1 ${
                    stats.roi >= 0 ? 'text-up/70' : 'text-down/70'
                  }`}>
                    {stats.roi >= 0 ? '+' : ''}{(stats.roi * 100).toFixed(1)}% ROI
                  </div>
                </div>
                {/* Win Rate ring */}
                <div className="flex items-center gap-3">
                  <WinRateRing rate={stats.winRate} />
                  <div>
                    <div className="text-xs text-zinc-500 mb-0.5">Win Rate</div>
                    <div className="text-xs text-zinc-400">
                      <span className="text-up">{stats.wins}W</span>
                      {' - '}
                      <span className="text-down">{stats.losses}L</span>
                      {stats.pending > 0 && <span className="text-zinc-500"> - {stats.pending}P</span>}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Activity stats */}
            <div className="grid grid-cols-3 gap-3">
              <StatCard
                label="Volume"
                value={`$${formatUsd(stats.totalVolumeUsd)}`}
                subtext={`${stats.totalBets} predictions`}
              />
              <StatCard
                label="Avg Prediction"
                value={`$${formatUsd(stats.avgBetSize)}`}
              />
              <StatCard
                label="Streak"
                value={`${stats.currentStreak.count} ${stats.currentStreak.type === 'win' ? 'W' : 'L'}`}
                subtext={`Best: ${stats.longestWinStreak}W / ${stats.longestLoseStreak}L`}
                color={stats.currentStreak.type === 'win' ? 'up' : 'down'}
              />
            </div>

            {/* Records + Side Distribution */}
            <div className="grid grid-cols-2 gap-3">
              <StatCard
                label="Best Win"
                value={`+$${formatUsd(stats.bestWin)}`}
                color="up"
              />
              <StatCard
                label="Worst Loss"
                value={`-$${formatUsd(Math.abs(stats.worstLoss))}`}
                color="down"
              />
            </div>

            {/* Side Distribution */}
            {(stats.sideDistribution.upVolume > 0 || stats.sideDistribution.downVolume > 0) && (
              <div className="bg-zinc-900/50 rounded-xl border border-zinc-800 p-3 sm:p-4">
                <div className="flex items-center gap-3">
                  <span className="text-up text-xs font-medium w-16 sm:w-20 text-right">
                    {((stats.sideDistribution.upVolume / stats.totalVolumeUsd) * 100).toFixed(0)}% UP
                  </span>
                  <div className="flex-1 h-2.5 rounded-full overflow-hidden flex bg-zinc-800">
                    <div
                      className="bg-up/70 transition-all"
                      style={{ width: `${(stats.sideDistribution.upVolume / stats.totalVolumeUsd) * 100}%` }}
                    />
                    <div
                      className="bg-down/70 transition-all"
                      style={{ width: `${(stats.sideDistribution.downVolume / stats.totalVolumeUsd) * 100}%` }}
                    />
                  </div>
                  <span className="text-down text-xs font-medium w-16 sm:w-20">
                    {((stats.sideDistribution.downVolume / stats.totalVolumeUsd) * 100).toFixed(0)}% DOWN
                  </span>
                </div>
              </div>
            )}

            {/* Equity Curve */}
            <div className="bg-zinc-900/50 rounded-xl border border-zinc-800 p-4 sm:p-5">
              <div className="text-xs text-zinc-500 mb-3 font-medium">P&L Equity Curve</div>
              <EquityCurveChart data={profile.equityCurve} />
            </div>

            {/* Bet History */}
            <div className="bg-zinc-900/50 rounded-xl border border-zinc-800 overflow-hidden">
              {/* Filter tabs */}
              <div className="flex items-center gap-1 px-4 pt-4 pb-2">
                {FILTERS.map((f) => (
                  <button
                    key={f}
                    onClick={() => { setActiveFilter(f); setExpandedBetIdx(null) }}
                    className={`px-3 py-1 text-xs rounded-lg transition-colors ${
                      activeFilter === f
                        ? 'bg-zinc-800 text-zinc-200 font-medium'
                        : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>

              {/* Table header (desktop) */}
              <div className="hidden sm:grid grid-cols-[4rem_3rem_5rem_3.5rem_4rem_1fr_1rem] gap-3 px-3 py-2 text-[10px] text-zinc-600 font-medium uppercase tracking-wider border-b border-zinc-800/50">
                <span>Time</span>
                <span>Side</span>
                <span className="text-right">Amount</span>
                <span className="text-right">Pool%</span>
                <span className="text-right">Result</span>
                <span className="text-right">P&L</span>
                <span />
              </div>

              {/* Rows */}
              {filteredBets.length === 0 ? (
                <div className="text-center py-8 text-zinc-600 text-sm">
                  {activeFilter === 'All' ? 'No predictions found' : `No ${activeFilter.toLowerCase()} found`}
                </div>
              ) : (
                filteredBets.map((bet, i) => (
                  <BetRow
                    key={`${bet.roundId}-${bet.side}-${bet.txId}`}
                    bet={bet}
                    expanded={expandedBetIdx === i}
                    onToggle={() => setExpandedBetIdx(expandedBetIdx === i ? null : i)}
                  />
                ))
              )}

              {/* Load more */}
              {hasMore && activeFilter === 'All' && (
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="w-full py-3 text-xs text-zinc-500 hover:text-zinc-300 border-t border-zinc-800/50 transition-colors disabled:opacity-50"
                >
                  {loadingMore ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="h-3 w-3 border border-zinc-500 border-t-transparent rounded-full animate-spin" />
                      Loading...
                    </span>
                  ) : (
                    'Load more predictions'
                  )}
                </button>
              )}
            </div>
          </div>
        )}

        <Footer />
      </div>
    </main>
  )
}
