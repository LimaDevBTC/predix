'use client'

import { useEffect, useState, useRef } from 'react'
import { CircleCheck, CircleX } from 'lucide-react'
import { getPositionForRound, getPnl, saveMyResult } from '@/lib/positions'

type Side = 'UP' | 'DOWN'

interface ResolvedRound {
  id: string
  startAt: number
  endsAt: number
  priceAtStart: number
  priceAtEnd?: number
  outcome?: Side
  status: string
}

interface ResolutionModalProps {
  round: ResolvedRound
  onClose: () => void
  jackpotBonus?: number
}

function formatTime(ts: number) {
  const d = new Date(ts)
  // Formato: #YYYYMMDDHHMM (único globalmente, estilo profissional)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hour = String(d.getHours()).padStart(2, '0')
  const minute = String(d.getMinutes()).padStart(2, '0')
  return `#${year}${month}${day}${hour}${minute}`
}

export function ResolutionModal({ round, onClose, jackpotBonus = 0 }: ResolutionModalProps) {
  const [countdown, setCountdown] = useState(5)
  const savedRef = useRef(false)
  const pos = getPositionForRound(round.id)
  const pnl = round.outcome ? getPnl(round.id, round.outcome, pos) : 0
  const hasPosition = pos.sharesUp > 0 || pos.sharesDown > 0
  
  // Determina se ganhou: tem shares do lado vencedor
  // Se tem shares do vencedor, ele ganhou a aposta (mesmo que P&L seja negativo por ter comprado caro)
  const hasWinningShares = round.outcome 
    ? (round.outcome === 'UP' ? pos.sharesUp > 0 : pos.sharesDown > 0)
    : false
  const won = hasWinningShares // Ganhou se tem shares do lado vencedor

  useEffect(() => {
    if (hasPosition && round.outcome && !savedRef.current) {
      saveMyResult({ roundId: round.id, outcome: round.outcome, pnl, startAt: round.startAt })
      savedRef.current = true
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('bitpredix_my_results_updated'))
    }
  }, [hasPosition, round.id, round.outcome, round.startAt, pnl])

  useEffect(() => {
    const t = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearInterval(t)
          onClose()
          return 0
        }
        return c - 1
      })
    }, 1000)
    return () => clearInterval(t)
  }, [onClose])

  const outcome = round.outcome ?? 'UP'
  const isUp = outcome === 'UP'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
      style={{ animation: 'fadeIn 0.2s ease-out' }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="relative w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden shadow-2xl"
        style={{ animation: 'scaleIn 0.25s ease-out' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative p-6 sm:p-8">
          {/* Header - neutro e profissional */}
          <div className="flex items-center justify-between mb-6">
            <div>
              <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">
                Round {formatTime(round.startAt)}
              </p>
              <p className="text-sm text-zinc-400">Resolved</p>
            </div>
            {/* Badge de resultado - pequeno e discreto */}
            <div className={`px-3 py-1.5 rounded-lg font-mono font-semibold text-sm ${
              isUp 
                ? 'bg-up/10 text-up border border-up/20' 
                : 'bg-down/10 text-down border border-down/20'
            }`}>
              {outcome}
            </div>
          </div>

          {/* Preço - destaque sutil */}
          <div className="mb-6 pb-6 border-b border-zinc-800">
            <p className="text-xs text-zinc-500 uppercase tracking-wider mb-2">Price (close: Binance)</p>
            <div className="flex items-center justify-center gap-2">
              <span className="font-mono text-lg text-zinc-300">
                ${round.priceAtStart?.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
              </span>
              <span className="text-zinc-600">→</span>
              <span className={`font-mono text-lg font-semibold ${
                isUp ? 'text-up' : 'text-down'
              }`}>
                ${round.priceAtEnd?.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
              </span>
            </div>
          </div>

          {/* Seção de posição e P&L - design limpo */}
          {hasPosition ? (
            <div className="mb-6 space-y-4">
              {/* Posição do usuário */}
              <div className="bg-zinc-900/50 rounded-lg p-4 border border-zinc-800">
                <p className="text-xs text-zinc-500 uppercase tracking-wider mb-3">Your Position</p>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-zinc-400">UP</span>
                  <span className="font-mono text-zinc-300">{pos.sharesUp.toFixed(2)}</span>
                </div>
                <div className="flex items-center justify-between text-sm mt-2">
                  <span className="text-zinc-400">DOWN</span>
                  <span className="font-mono text-zinc-300">{pos.sharesDown.toFixed(2)}</span>
                </div>
              </div>

              {/* Resultado e P&L */}
              <div className="bg-zinc-900/50 rounded-lg p-4 border border-zinc-800">
                <div className="flex items-center justify-between mb-4">
                  <p className="text-xs text-zinc-500 uppercase tracking-wider">Result</p>
                  <span className={`inline-flex items-center gap-1 text-sm font-semibold ${
                    won ? 'text-up' : 'text-down'
                  }`}>
                    {won ? <CircleCheck size={14} /> : <CircleX size={14} />}
                    {won ? 'Won' : 'Lost'}
                  </span>
                </div>

                {/* Breakdown financeiro */}
                <div className="space-y-2.5 pt-3 border-t border-zinc-800">
                  {(() => {
                    const winningShares = round.outcome === 'UP' ? pos.sharesUp : pos.sharesDown
                    const totalCost = pos.costUp + pos.costDown
                    const payout = winningShares * 1.00
                    
                    return (
                      <>
                        <div className="flex justify-between items-center text-xs">
                          <span className="text-zinc-500">Payout</span>
                          <span className="font-mono text-zinc-300">${payout.toFixed(2)}</span>
                        </div>
                        {jackpotBonus > 0 && (
                          <div className="flex justify-between items-center text-xs">
                            <span className="text-yellow-500">Jackpot Bonus</span>
                            <span className="font-mono text-yellow-400">+${jackpotBonus.toFixed(2)}</span>
                          </div>
                        )}
                        <div className="flex justify-between items-center text-xs">
                          <span className="text-zinc-500">Cost</span>
                          <span className="font-mono text-zinc-400">${totalCost.toFixed(2)}</span>
                        </div>
                        <div className="pt-2 border-t border-zinc-800">
                          <div className="flex justify-between items-baseline">
                            <span className="text-xs text-zinc-500 uppercase tracking-wider">Net P&L</span>
                            <span className={`font-mono text-xl font-bold ${
                              pnl >= 0 
                                ? 'text-up' 
                                : won 
                                  ? 'text-zinc-400' // Cinza neutro se ganhou mas P&L negativo
                                  : 'text-down'     // Vermelho apenas se perdeu
                            }`}>
                              {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                            </span>
                          </div>
                          {pnl < 0 && won && (
                            <p className="text-xs text-zinc-500 mt-1">Bought at high price</p>
                          )}
                          <p className="text-xs text-zinc-600 mt-2 italic">
                            P&L for this round only
                          </p>
                        </div>
                      </>
                    )
                  })()}
                </div>
              </div>
            </div>
          ) : (
            <div className="mb-6 py-4 text-center">
              <p className="text-sm text-zinc-500">You didn&apos;t predict in this round</p>
            </div>
          )}

          {/* Botão - estilo profissional */}
          <button
            onClick={onClose}
            className="w-full py-3 rounded-lg font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-zinc-700 transition-colors"
          >
            Continue · {countdown}s
          </button>
        </div>
      </div>
    </div>
  )
}
