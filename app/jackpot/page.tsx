'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, ExternalLink, Ticket, Trophy, Clock, TrendingUp,
  Zap, Shield, Hash, Users, ChevronRight, Sparkles,
} from 'lucide-react'
import { getLocalStorage, isConnected } from '@stacks/connect'
import { Footer } from '@/components/Footer'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface JackpotStatus {
  balance: number
  totalTickets: number
  userTickets: number
  userProbability: number
  countdownMs: number
  drawHourET: number
}

interface DrawResult {
  date: string
  blockHeight: number
  blockHash: string
  totalTickets: number
  winnerIndex: string
  winner: string
  prize: number
  jackpotBalanceAfter: number
  txId?: string
  transferError?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCountdown(ms: number): { h: string; m: string; s: string; drawing: boolean } {
  if (ms <= 0) return { h: '00', m: '00', s: '00', drawing: true }
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return {
    h: h.toString().padStart(2, '0'),
    m: m.toString().padStart(2, '0'),
    s: s.toString().padStart(2, '0'),
    drawing: false,
  }
}

function truncateAddress(addr: string): string {
  if (!addr || addr.length <= 16) return addr || '???'
  return `${addr.slice(0, 8)}...${addr.slice(-4)}`
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr + 'T00:00:00')
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch { return dateStr }
}

function countdownProgress(ms: number): number {
  const totalMs = 24 * 3600000
  return Math.max(0, Math.min(100, ((totalMs - ms) / totalMs) * 100))
}

// ---------------------------------------------------------------------------
// Countdown digit component
// ---------------------------------------------------------------------------

function CountdownDigit({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col items-center">
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 sm:px-4 sm:py-2.5 min-w-[3rem] sm:min-w-[3.5rem] text-center">
        <span className="text-2xl sm:text-3xl font-mono font-bold text-zinc-100 tabular-nums">{value}</span>
      </div>
      <span className="text-[9px] text-zinc-600 uppercase tracking-widest mt-1.5">{label}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Stat card component
// ---------------------------------------------------------------------------

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-3 sm:p-4">
      <div className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</div>
      <div className={`text-lg sm:text-xl font-mono font-bold mt-0.5 ${accent ? 'text-bitcoin' : 'text-zinc-200'}`}>
        {value}
      </div>
      {sub && <div className="text-[10px] text-zinc-600 mt-0.5">{sub}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Multiplier badge
// ---------------------------------------------------------------------------

function MultiplierBadge({ value, label, desc }: { value: string; label: string; desc: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="shrink-0 w-10 h-10 rounded-lg bg-bitcoin/10 border border-bitcoin/20 flex items-center justify-center">
        <span className="text-bitcoin font-mono font-bold text-sm">{value}</span>
      </div>
      <div className="min-w-0">
        <div className="text-zinc-300 text-sm font-medium">{label}</div>
        <div className="text-zinc-500 text-xs mt-0.5">{desc}</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function JackpotPage() {
  const [status, setStatus] = useState<JackpotStatus | null>(null)
  const [draws, setDraws] = useState<DrawResult[]>([])
  const [loading, setLoading] = useState(true)
  const [address, setAddress] = useState<string | null>(null)
  const [countdownMs, setCountdownMs] = useState(0)

  // Get wallet address
  useEffect(() => {
    if (!isConnected()) return
    const data = getLocalStorage()
    setAddress(data?.addresses?.stx?.[0]?.address ?? null)
  }, [])

  // Fetch data
  const fetchData = useCallback(async () => {
    try {
      const params = address ? `?address=${address}` : ''
      const [statusRes, historyRes] = await Promise.all([
        fetch(`/api/jackpot/status${params}`),
        fetch('/api/jackpot/history'),
      ])
      const statusData = await statusRes.json()
      const historyData = await historyRes.json()

      if (statusData.ok) {
        setStatus(statusData)
        setCountdownMs(statusData.countdownMs)
      }
      if (historyData.ok && historyData.draws) {
        setDraws(historyData.draws)
      }
    } catch { /* ignore */ }
    setLoading(false)
  }, [address])

  useEffect(() => { fetchData() }, [fetchData])

  // Live countdown
  useEffect(() => {
    if (!status) return
    const id = setInterval(() => {
      setCountdownMs(prev => Math.max(0, prev - 1000))
    }, 1000)
    return () => clearInterval(id)
  }, [status])

  // Refresh every 30s
  useEffect(() => {
    const id = setInterval(fetchData, 30_000)
    return () => clearInterval(id)
  }, [fetchData])

  const countdown = formatCountdown(countdownMs)
  const prize = status ? status.balance * 0.10 : 0
  const progress = countdownProgress(countdownMs)

  return (
    <main className="min-h-screen bg-zinc-950">
      <div className="w-full max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Link
            href="/"
            className="p-2 -ml-2 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/60 transition-colors"
          >
            <ArrowLeft size={18} />
          </Link>
          <div className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/moneybag.png" alt="" className="w-7 h-7" />
            <h1 className="text-zinc-200 font-semibold text-lg sm:text-xl">Jackpot</h1>
          </div>
          <span className="text-[10px] text-zinc-600 bg-zinc-800/60 rounded px-1.5 py-0.5 uppercase tracking-wider">Daily</span>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-6 h-6 border-2 border-bitcoin/40 border-t-bitcoin rounded-full animate-spin" />
          </div>
        ) : (
          <div className="space-y-4">

            {/* ============================================================ */}
            {/* HERO: Treasury + Countdown */}
            {/* ============================================================ */}
            <div className="rounded-xl bg-gradient-to-br from-yellow-900/20 via-zinc-900/80 to-zinc-900 border border-bitcoin/20 p-5 sm:p-6 relative overflow-hidden">
              {/* Subtle glow */}
              <div className="absolute -top-20 -right-20 w-60 h-60 bg-bitcoin/5 rounded-full blur-3xl pointer-events-none" />

              <div className="relative">
                {/* Treasury */}
                <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1 flex items-center gap-1.5">
                  <Shield size={10} className="text-bitcoin/60" />
                  On-Chain Treasury
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="text-4xl sm:text-5xl font-mono font-bold text-bitcoin">
                    ${status ? status.balance.toFixed(2) : '0.00'}
                  </span>
                  <span className="text-zinc-500 text-sm">USDCx</span>
                </div>

                {/* Next Prize */}
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-zinc-500 text-xs">Next prize</span>
                  <span className="font-mono text-zinc-300 text-sm font-medium">
                    ${prize.toFixed(2)}
                  </span>
                  <span className="text-zinc-600 text-[10px]">(10%)</span>
                </div>

                {/* Countdown */}
                <div className="mt-5">
                  <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2.5 flex items-center gap-1.5">
                    <Clock size={10} />
                    {countdown.drawing ? 'Drawing now...' : 'Next draw'}
                  </div>

                  {countdown.drawing ? (
                    <div className="flex items-center gap-2 text-bitcoin font-mono font-bold text-lg">
                      <Sparkles size={16} className="animate-pulse" />
                      Drawing winner...
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <CountdownDigit value={countdown.h} label="Hours" />
                      <span className="text-zinc-600 text-xl font-mono font-bold mt-[-14px]">:</span>
                      <CountdownDigit value={countdown.m} label="Min" />
                      <span className="text-zinc-600 text-xl font-mono font-bold mt-[-14px]">:</span>
                      <CountdownDigit value={countdown.s} label="Sec" />
                    </div>
                  )}
                </div>

                {/* Progress bar */}
                <div className="mt-4">
                  <div className="h-1 rounded-full bg-zinc-800 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-bitcoin/60 to-bitcoin transition-all duration-1000"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                  <div className="flex justify-between mt-1">
                    <span className="text-[9px] text-zinc-600">0:00 ET</span>
                    <span className="text-[9px] text-bitcoin/80 font-medium">9 PM ET</span>
                  </div>
                </div>
              </div>
            </div>

            {/* ============================================================ */}
            {/* STATS ROW */}
            {/* ============================================================ */}
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
              <StatCard
                label="Today's Pool"
                value={status ? status.totalTickets.toLocaleString() : '0'}
                sub="tickets"
              />
              <StatCard
                label="Draws"
                value={draws.length.toString()}
                sub="all time"
              />
              <StatCard
                label="Total Won"
                value={`$${draws.reduce((sum, d) => sum + (d.txId && !d.transferError ? d.prize : 0), 0) / 1e6 > 0 ? (draws.reduce((sum, d) => sum + (d.txId && !d.transferError ? d.prize : 0), 0) / 1e6).toFixed(0) : '0'}`}
                sub="paid out"
                accent
              />
            </div>

            {/* ============================================================ */}
            {/* MY TICKETS */}
            {/* ============================================================ */}
            {address && status ? (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <Ticket size={16} className="text-bitcoin" />
                    <span className="text-sm font-medium text-zinc-300">My Tickets</span>
                  </div>
                  <span className="text-[10px] text-zinc-600 bg-zinc-800/60 rounded px-1.5 py-0.5">today</span>
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Tickets</div>
                    <div className="text-2xl font-mono font-bold text-zinc-200 mt-0.5">
                      {status.userTickets.toLocaleString()}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Win Chance</div>
                    <div className="text-2xl font-mono font-bold text-zinc-200 mt-0.5">
                      {status.totalTickets > 0 && status.userTickets > 0
                        ? `${((status.userTickets / status.totalTickets) * 100).toFixed(1)}%`
                        : '0%'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Win Prize</div>
                    <div className="text-2xl font-mono font-bold text-bitcoin mt-0.5">
                      {status.userTickets > 0
                        ? `$${prize.toFixed(0)}`
                        : '--'}
                    </div>
                    <div className="text-[10px] text-zinc-600 mt-0.5">winner takes all</div>
                  </div>
                </div>

                {/* Ticket progress bar */}
                {status.totalTickets > 0 && (
                  <div className="mt-4">
                    <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-bitcoin/80 transition-all duration-500"
                        style={{ width: `${Math.min(100, (status.userTickets / status.totalTickets) * 100)}%` }}
                      />
                    </div>
                    <div className="flex justify-between mt-1">
                      <span className="text-[10px] text-zinc-600">
                        {status.userTickets.toLocaleString()} / {status.totalTickets.toLocaleString()}
                      </span>
                      <span className="text-[10px] text-zinc-500">
                        Win chance: <span className="text-zinc-300 font-medium">
                          {status.userProbability > 0
                            ? `${(status.userProbability * 100).toFixed(1)}%`
                            : '0%'}
                        </span>
                      </span>
                    </div>
                  </div>
                )}

                {status.userTickets === 0 && (
                  <div className="mt-3 rounded-lg bg-zinc-800/30 border border-zinc-800/60 p-3 flex items-start gap-2.5">
                    <Zap size={14} className="text-bitcoin shrink-0 mt-0.5" />
                    <div className="text-xs text-zinc-400">
                      <span className="text-zinc-300 font-medium">No tickets yet.</span>{' '}
                      Predict in the first 20 seconds of any round to earn tickets.
                      <Link href="/" className="text-bitcoin hover:text-bitcoin/80 ml-1 inline-flex items-center gap-0.5">
                        Go predict <ChevronRight size={10} />
                      </Link>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-zinc-800/60 flex items-center justify-center">
                    <Ticket size={18} className="text-zinc-600" />
                  </div>
                  <div>
                    <p className="text-zinc-400 text-sm font-medium">Connect wallet to track your tickets</p>
                    <p className="text-zinc-600 text-xs mt-0.5">Your daily ticket count, pool share, and win chance</p>
                  </div>
                </div>
              </div>
            )}

            {/* ============================================================ */}
            {/* DRAW HISTORY */}
            {/* ============================================================ */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
              <div className="px-5 pt-4 pb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Trophy size={16} className="text-zinc-500" />
                  <span className="text-sm font-medium text-zinc-300">Draw History</span>
                </div>
                {draws.length > 0 && (
                  <span className="text-[10px] text-zinc-600">{draws.length} draw{draws.length !== 1 ? 's' : ''}</span>
                )}
              </div>

              {draws.length === 0 ? (
                <div className="px-5 pb-5">
                  <div className="rounded-lg bg-zinc-800/20 border border-zinc-800/40 p-6 text-center">
                    <Trophy size={24} className="text-zinc-700 mx-auto mb-2" />
                    <p className="text-zinc-500 text-sm">No draws yet</p>
                    <p className="text-zinc-600 text-xs mt-1">The first draw happens at 9 PM ET</p>
                  </div>
                </div>
              ) : (
                <div className="divide-y divide-zinc-800/60">
                  {draws.map(d => {
                    const paid = d.txId && !d.transferError
                    const isMyWin = address && d.winner && (
                      d.winner.toLowerCase() === address.toLowerCase() ||
                      d.winner.startsWith(address.slice(0, 8))
                    )
                    return (
                      <div key={d.date} className="px-5 py-3.5 hover:bg-zinc-800/20 transition-colors">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-zinc-200 text-sm font-medium">{formatDate(d.date)}</span>
                              {isMyWin && (
                                <span className="text-[9px] bg-bitcoin/20 text-bitcoin rounded px-1.5 py-0.5 font-medium uppercase tracking-wider">
                                  You won!
                                </span>
                              )}
                              {!paid && d.transferError && (
                                <span className="text-[9px] bg-red-500/10 text-red-400/80 rounded px-1.5 py-0.5 uppercase tracking-wider">
                                  Pending
                                </span>
                              )}
                            </div>
                            <div className="text-zinc-600 text-xs mt-1 flex items-center gap-1.5 flex-wrap">
                              <Users size={10} className="shrink-0" />
                              <Link
                                href={`/profile/${d.winner}`}
                                className="hover:text-zinc-400 transition-colors"
                              >
                                {truncateAddress(d.winner)}
                              </Link>
                              <span className="text-zinc-700">|</span>
                              <span>{d.totalTickets.toLocaleString()} tickets</span>
                              <span className="text-zinc-700">|</span>
                              <span>idx {d.winnerIndex}</span>
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <div className={`font-mono font-bold text-sm ${paid ? 'text-bitcoin' : 'text-zinc-500'}`}>
                              {paid ? '+' : ''}${(d.prize / 1e6).toFixed(2)}
                            </div>
                            <div className="flex items-center gap-2 mt-0.5 justify-end">
                              <a
                                href={`https://mempool.space/block/${d.blockHash}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-zinc-600 hover:text-zinc-400 text-[10px] inline-flex items-center gap-0.5"
                              >
                                <Hash size={8} />
                                {d.blockHeight.toLocaleString()}
                                <ExternalLink size={7} />
                              </a>
                              {d.txId && (
                                <a
                                  href={`https://explorer.hiro.so/txid/${d.txId}?chain=testnet`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-zinc-600 hover:text-zinc-400 text-[10px] inline-flex items-center gap-0.5"
                                >
                                  tx
                                  <ExternalLink size={7} />
                                </a>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* ============================================================ */}
            {/* TICKET MULTIPLIERS */}
            {/* ============================================================ */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
              <div className="flex items-center gap-2 mb-4">
                <Zap size={16} className="text-bitcoin" />
                <span className="text-sm font-medium text-zinc-300">Ticket Multipliers</span>
              </div>

              <div className="space-y-3">
                <MultiplierBadge
                  value="1x"
                  label="Early Predictor"
                  desc="Predict within the first 20 seconds. $1 = 1 ticket."
                />
                <MultiplierBadge
                  value="2x"
                  label="First or Largest"
                  desc="Be the first predictor on a side, or place the largest prediction."
                />
                <MultiplierBadge
                  value="4x"
                  label="First + Largest"
                  desc="Both first and largest on a side. Maximum multiplier."
                />
              </div>

              <div className="mt-4 pt-3 border-t border-zinc-800/60">
                <div className="flex items-center gap-2 text-xs text-zinc-500">
                  <Shield size={12} />
                  <span>
                    Only rounds with 2+ wallets on opposite sides qualify.
                    Self-dealing is detected and excluded.
                  </span>
                </div>
              </div>
            </div>

            {/* ============================================================ */}
            {/* HOW IT WORKS */}
            {/* ============================================================ */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
              <div className="flex items-center gap-2 mb-4">
                <TrendingUp size={16} className="text-zinc-500" />
                <span className="text-sm font-medium text-zinc-300">How the Jackpot Works</span>
              </div>

              <div className="space-y-4">
                {/* Step 1 */}
                <div className="flex gap-3">
                  <div className="shrink-0 w-6 h-6 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center">
                    <span className="text-[10px] text-zinc-400 font-mono font-bold">1</span>
                  </div>
                  <div className="text-xs text-zinc-400 leading-relaxed pt-0.5">
                    <span className="text-zinc-300 font-medium">Treasury grows every round.</span>{' '}
                    1% of all settled volume is deposited into the on-chain jackpot treasury automatically.
                    The fund can only increase from volume or decrease from prize payouts.
                  </div>
                </div>

                {/* Step 2 */}
                <div className="flex gap-3">
                  <div className="shrink-0 w-6 h-6 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center">
                    <span className="text-[10px] text-zinc-400 font-mono font-bold">2</span>
                  </div>
                  <div className="text-xs text-zinc-400 leading-relaxed pt-0.5">
                    <span className="text-zinc-300 font-medium">Earn tickets by predicting early.</span>{' '}
                    Predictions in the first 20 seconds of a round earn tickets. Multipliers reward
                    speed and conviction. Tickets reset daily at midnight ET.
                  </div>
                </div>

                {/* Step 3 */}
                <div className="flex gap-3">
                  <div className="shrink-0 w-6 h-6 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center">
                    <span className="text-[10px] text-zinc-400 font-mono font-bold">3</span>
                  </div>
                  <div className="text-xs text-zinc-400 leading-relaxed pt-0.5">
                    <span className="text-zinc-300 font-medium">Daily draw at 9 PM ET.</span>{' '}
                    The first Bitcoin block mined after 9 PM ET provides the random seed.
                    Winner index = <code className="text-zinc-500 bg-zinc-800/60 px-1 rounded text-[10px]">block_hash mod total_tickets</code>.
                    Prize is 10% of the treasury.
                  </div>
                </div>

                {/* Step 4 */}
                <div className="flex gap-3">
                  <div className="shrink-0 w-6 h-6 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center">
                    <span className="text-[10px] text-zinc-400 font-mono font-bold">4</span>
                  </div>
                  <div className="text-xs text-zinc-400 leading-relaxed pt-0.5">
                    <span className="text-zinc-300 font-medium">Prize paid automatically.</span>{' '}
                    The winner receives USDCx directly from the on-chain treasury via a sponsored transaction.
                    No claim needed. The jackpot never zeros out.
                  </div>
                </div>
              </div>

              {/* Verifiability note */}
              <div className="mt-4 pt-3 border-t border-zinc-800/60">
                <div className="flex items-start gap-2 text-xs text-zinc-500">
                  <Shield size={12} className="shrink-0 mt-0.5 text-bitcoin/50" />
                  <span>
                    <span className="text-zinc-400 font-medium">Fully verifiable.</span>{' '}
                    Treasury balance lives on-chain. Draw results use a public Bitcoin block hash.
                    Anyone can independently reproduce the winner calculation.
                  </span>
                </div>
              </div>
            </div>

          </div>
        )}

        <Footer />
      </div>
    </main>
  )
}
