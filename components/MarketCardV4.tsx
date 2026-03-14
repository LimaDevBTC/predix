'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { getLocalStorage, isConnected, request } from '@stacks/connect'
import { uintCV, contractPrincipalCV, stringAsciiCV, boolCV } from '@stacks/transactions'
import { TradeTape, type TradeTapeItem } from './TradeTape'
import { BtcPrice } from './BtcPrice'
import { Countdown } from './Countdown'
import dynamic from 'next/dynamic'
import type { BtcPricePoint } from './BtcPriceChart'

const BtcPriceChart = dynamic(() => import('./BtcPriceChart'), {
  ssr: false,
  loading: () => <div className="w-full h-[220px] sm:h-[280px] lg:h-[320px] rounded-xl bg-zinc-900/50 animate-pulse" />,
})
import { usePythPrice } from '@/lib/pyth'
import { sponsoredContractCall, getSavedPublicKey, savePublicKey } from '@/lib/sponsored-tx'
import confetti from 'canvas-confetti'

const BITPREDIX_CONTRACT = process.env.NEXT_PUBLIC_BITPREDIX_CONTRACT_ID || 'ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK.predixv2'
const GATEWAY_CONTRACT = process.env.NEXT_PUBLIC_GATEWAY_CONTRACT_ID || 'ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK.predixv2-gateway'
const TOKEN_CONTRACT = process.env.NEXT_PUBLIC_TEST_USDCX_CONTRACT_ID || 'ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK.test-usdcx'
const MAX_APPROVE_AMOUNT = BigInt('1000000000000') // 1 million USD (6 decimals)

type Side = 'UP' | 'DOWN'

const ROUND_DURATION_MS = 60 * 1000  // 60 segundos
const TRADING_WINDOW_MS = 50 * 1000  // Trading fecha 10s antes do fim do round
const MIN_BET_USD = 1

// Virtual seed liquidity — prevents cold-start pricing distortion.
// With SEED=100, a $1 bet moves price ~0.5%, $100 moves ~25%.
// This is purely cosmetic: payouts use real pool values only.
const VIRTUAL_SEED_USD = 100

/** Calculate display prices with virtual seed liquidity. */
function calcSeededPrices(realUp: number, realDown: number) {
  const effUp = VIRTUAL_SEED_USD + realUp
  const effDown = VIRTUAL_SEED_USD + realDown
  const total = effUp + effDown
  return {
    priceUp: effUp / total,
    priceDown: effDown / total,
  }
}

interface RoundInfo {
  id: number
  startAt: number
  endsAt: number
  tradingClosesAt: number
  priceAtStart: number | null
}

function getCurrentRoundInfo(): RoundInfo {
  const now = Date.now()
  const roundId = Math.floor(now / ROUND_DURATION_MS)
  const startAt = roundId * ROUND_DURATION_MS
  const endsAt = startAt + ROUND_DURATION_MS
  const tradingClosesAt = startAt + TRADING_WINDOW_MS

  return {
    id: roundId,
    startAt,
    endsAt,
    tradingClosesAt,
    priceAtStart: null
  }
}

interface RoundResult {
  roundId: number
  outcome: 'UP' | 'DOWN'
  netPnL: number | null  // positive = won, negative = lost, null = pool data unavailable
  won: boolean
}

interface PoolData {
  totalUp: number    // USD in UP pool
  totalDown: number  // USD in DOWN pool
  priceUp: number    // 0-1 implied probability
  priceDown: number  // 0-1 implied probability
}

export function MarketCardV4() {
  const [round, setRound] = useState<RoundInfo | null>(null)
  const [amount, setAmount] = useState('')
  const [trading, setTrading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [roundBets, setRoundBets] = useState<{ roundId: number; up: number; down: number } | null>(null)
  const [stxAddress, setStxAddress] = useState<string | null>(null)
  const [btcPriceHistory, setBtcPriceHistory] = useState<BtcPricePoint[]>([])
  const [pool, setPool] = useState<PoolData | null>(null)
  const [jackpot, setJackpot] = useState<{ balance: number; earlyUp: number; earlyDown: number } | null>(null)
  const [isEarlyBet, setIsEarlyBet] = useState(false)
  const [earlySecsLeft, setEarlySecsLeft] = useState(0)
  const [recentRounds, setRecentRounds] = useState<{ id: string; outcome: 'UP' | 'DOWN' }[]>([])
  const [roundResult, setRoundResult] = useState<RoundResult | null>(null)
  const [tradeTape, setTradeTape] = useState<TradeTapeItem[]>([])
  const tradeTapeTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const roundBetsRef = useRef(roundBets)
  const poolRef = useRef(pool)
  const shownTradeIdsRef = useRef<Set<string>>(new Set())

  const roundId = round?.id ?? null
  const lastRoundIdRef = useRef<number | null>(null)
  const openPriceRef = useRef<number | null>(null)
  const sessionIdRef = useRef<string>('')
  const fetchingOpenForRef = useRef<number | null>(null)

  // Generate anonymous session ID for active user tracking
  useEffect(() => {
    let sid = sessionStorage.getItem('predix_sid')
    if (!sid) {
      sid = 's_' + Math.random().toString(36).slice(2, 10)
      sessionStorage.setItem('predix_sid', sid)
    }
    sessionIdRef.current = sid
  }, [])

  // Timer reativo para countdown da janela de jackpot (primeiros 20s)
  useEffect(() => {
    const tick = () => {
      const roundStartMs = (round?.id ?? 0) * 60 * 1000
      const elapsed = (Date.now() - roundStartMs) / 1000
      setEarlySecsLeft(Math.max(0, Math.ceil(20 - elapsed)))
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [round?.id])

  // Push a bet into the trade tape (auto-removes after 4s, max 5 visible)
  const pushTradeTape = useCallback((side: 'UP' | 'DOWN', amount: number) => {
    const item: TradeTapeItem = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), side, amount }
    setTradeTape(prev => [...prev.slice(-4), item])
    const timer = setTimeout(() => {
      setTradeTape(prev => prev.filter(x => x.id !== item.id))
    }, 4000)
    tradeTapeTimersRef.current.push(timer)
  }, [])

  // Pyth price em tempo real
  const { price: currentPrice, loading: priceLoading, error: priceError } = usePythPrice()

  // Atualiza round a cada segundo
  useEffect(() => {
    const updateRound = () => {
      const newRound = getCurrentRoundInfo()

      // Se mudou de round, captura resultado e reseta
      if (lastRoundIdRef.current !== newRound.id) {
        // Capture round result before resetting
        const prevBets = roundBetsRef.current
        const prevOpenPrice = openPriceRef.current
        const prevPool = poolRef.current
        // Only calculate result if bets belong to the round that just ended
        if (prevBets && prevBets.roundId === lastRoundIdRef.current && (prevBets.up > 0 || prevBets.down > 0) && prevOpenPrice && currentPrice) {
          const outcome: 'UP' | 'DOWN' = currentPrice > prevOpenPrice ? 'UP' : 'DOWN'
          const totalCost = prevBets.up + prevBets.down
          const winningBet = outcome === 'UP' ? prevBets.up : prevBets.down

          let netPnL: number | null = null
          if (winningBet > 0 && prevPool && prevPool.totalUp > 0 && prevPool.totalDown > 0) {
            const winningPool = outcome === 'UP' ? prevPool.totalUp : prevPool.totalDown
            const totalPool = prevPool.totalUp + prevPool.totalDown
            const grossPayout = (winningBet / winningPool) * totalPool
            const netPayout = grossPayout * 0.97
            netPnL = Math.round((netPayout - totalCost) * 100) / 100
            // Safety clamp: PnL can never be worse than losing everything
            netPnL = Math.max(-totalCost, netPnL)
          } else if (winningBet > 0) {
            // No reliable pool data — show conservative estimate
            netPnL = Math.round((winningBet * 0.97 - totalCost) * 100) / 100
          } else {
            // User only bet on losing side — total loss
            netPnL = -totalCost
          }

          setRoundResult({
            roundId: prevBets.roundId,
            outcome,
            netPnL,
            won: winningBet > 0,
          })
        }

        lastRoundIdRef.current = newRound.id
        // Do NOT use the local Pyth price — it varies per device & timing.
        // Set null and let KV polling / fallback-fetch deliver the canonical server price.
        openPriceRef.current = null
        fetchingOpenForRef.current = null
        setRoundBets(null)
        setPool(null)
        setJackpot(null)
        setIsEarlyBet(false)
        setTradeTape([])
        tradeTapeTimersRef.current.forEach(clearTimeout)
        tradeTapeTimersRef.current = []
        shownTradeIdsRef.current = new Set()

        // Immediately fetch pool for the new round — don't wait for next poll cycle
        fetchPoolRef.current()

        // Limpa cache de open prices antigos (mantém últimos 60 rounds = 1h)
        try {
          const keys = Object.keys(localStorage).filter(k => k.startsWith('opv3_') || k.startsWith('opv2_') || k.startsWith('openPrice_'))
          if (keys.length > 60) {
            keys.sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]))
            for (let i = 0; i < keys.length - 60; i++) localStorage.removeItem(keys[i])
          }
        } catch {}
      }

      setRound({
        ...newRound,
        priceAtStart: openPriceRef.current
      })
    }

    updateRound()
    const interval = setInterval(updateRound, 1000)
    return () => clearInterval(interval)
  }, [currentPrice])

  // Fetch canonical open price from server whenever we don't have one.
  // Runs on round change, page refresh, and tab resume.
  const fetchCanonicalOpen = useCallback((rid: number) => {
    if (!rid) return
    if (openPriceRef.current) return
    if (fetchingOpenForRef.current === rid) return
    fetchingOpenForRef.current = rid

    const cacheKey = `opv3_${rid}`

    // Check localStorage cache first — set by polling/server on this device
    try {
      const cached = localStorage.getItem(cacheKey)
      if (cached) {
        const cachedPrice = parseFloat(cached)
        if (!isNaN(cachedPrice) && cachedPrice > 0) {
          openPriceRef.current = cachedPrice
          setRound(prev => prev ? { ...prev, priceAtStart: cachedPrice } : prev)
          return
        }
      }
    } catch {}

    // Ask server for canonical open price
    const fetchFromServer = async (attempt: number) => {
      if (fetchingOpenForRef.current !== rid || openPriceRef.current) return
      try {
        const res = await fetch(`/api/open-price?roundId=${rid}`)
        const data = await res.json()
        if (openPriceRef.current) return
        if (data.price && typeof data.price === 'number' && data.price > 0) {
          openPriceRef.current = data.price
          try { localStorage.setItem(cacheKey, String(data.price)) } catch {}
          setRound(prev => prev ? { ...prev, priceAtStart: data.price } : prev)
          return
        }
      } catch {}
      // Server doesn't have it yet — retry
      if (attempt < 8) {
        setTimeout(() => fetchFromServer(attempt + 1), 2000)
      }
    }

    fetchFromServer(0)
  }, [])

  useEffect(() => {
    if (roundId) fetchCanonicalOpen(roundId)
  }, [roundId, fetchCanonicalOpen])

  // On tab resume: re-sync open price if we don't have it (SSE may have died)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      // Full re-sync on tab resume: pool + open price
      fetchPoolRef.current()
      const rid = lastRoundIdRef.current
      if (rid && !openPriceRef.current) {
        fetchingOpenForRef.current = null // reset so fetchCanonicalOpen can retry
        fetchCanonicalOpen(rid)
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [fetchCanonicalOpen])

  // Keep refs in sync for round transition capture
  useEffect(() => { roundBetsRef.current = roundBets }, [roundBets])
  useEffect(() => { poolRef.current = pool }, [pool])

  // Auto-dismiss round result after 8s + confetti on win
  useEffect(() => {
    if (!roundResult) return
    if (roundResult.won) {
      confetti({
        particleCount: 80,
        spread: 60,
        origin: { y: 0.7 },
        colors: ['#22c55e', '#4ade80', '#86efac', '#fbbf24', '#f59e0b'],
        disableForReducedMotion: true,
      })
    }
    const timer = setTimeout(() => setRoundResult(null), 8000)
    return () => clearTimeout(timer)
  }, [roundResult])

  // Auto-dismiss errors after 6s
  useEffect(() => {
    if (!error) return
    const timer = setTimeout(() => setError(null), 6000)
    return () => clearTimeout(timer)
  }, [error])

  // Poll pool data from KV — 1s constant (KV latency ~1-5ms)
  const fetchPoolRef = useRef<() => Promise<void>>(() => Promise.resolve())

  const fetchPool = useCallback(async () => {
    try {
      // Cache-busting + session ID for active user heartbeat
      const sid = sessionIdRef.current
      const res = await fetch(`/api/round?_=${Date.now()}${sid ? `&sid=${sid}` : ''}`, { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      if (!data.ok) return

      // Validate roundId — discard data from a different round
      const apiRoundId = parseInt(String(data.round?.id ?? '').replace('round-', ''), 10)
      if (!apiRoundId || apiRoundId !== lastRoundIdRef.current) return

      // Server is authoritative: it merges on-chain + KV optimistic data.
      // Use server values directly (they already include our optimistic bet via KV).
      // Only keep local max for the brief window between local optimistic update
      // and the next server poll that reflects it.
      const qUp = data.round?.pool?.qUp ?? 0
      const qDown = data.round?.pool?.qDown ?? 0
      setPool(prev => {
        // Server sees all bets from all clients via KV.
        // Keep local max only if it's from our own un-synced optimistic update.
        const up = Math.max(qUp, prev?.totalUp ?? 0)
        const down = Math.max(qDown, prev?.totalDown ?? 0)
        const { priceUp, priceDown } = calcSeededPrices(up, down)
        return { totalUp: up, totalDown: down, priceUp, priceDown }
      })

      // Extract jackpot data from poll response
      if (data.jackpot) {
        setJackpot(data.jackpot)
      }

      // Trade tape from polling with dedup — generous 30s window to handle latency/clock skew
      if (Array.isArray(data.recentTrades)) {
        const cutoff = Date.now() - 30000
        for (const t of data.recentTrades) {
          if (t.ts > cutoff && !shownTradeIdsRef.current.has(t.id)) {
            shownTradeIdsRef.current.add(t.id)
            pushTradeTape(t.side, Math.round(t.amount))
          }
        }
      }

      // Open price via polling (canonical from server KV)
      if (data.openPrice && typeof data.openPrice === 'number' && data.openPrice > 0 && !openPriceRef.current) {
        openPriceRef.current = data.openPrice
        try { localStorage.setItem(`opv3_${apiRoundId}`, String(data.openPrice)) } catch {}
        setRound(prev => prev ? { ...prev, priceAtStart: data.openPrice } : prev)
      }

      // Broadcast active user count to AppHeader via CustomEvent
      if (typeof data.activeUsers === 'number' && data.activeUsers > 0) {
        window.dispatchEvent(new CustomEvent('predix:active-users', { detail: data.activeUsers }))
      }

      // Log Redis connectivity status (dev only)
      if (typeof data.kvConnected === 'boolean' && !data.kvConnected) {
        console.warn('[sync] Server KV NOT connected — cross-device sync disabled')
      }
    } catch { /* ignore */ }
  }, [pushTradeTape])

  // Keep ref in sync so the round-transition effect can call fetchPool without a dep
  useEffect(() => { fetchPoolRef.current = fetchPool }, [fetchPool])

  useEffect(() => {
    if (!round) return
    let cancelled = false

    const poll = async () => {
      if (cancelled) return
      await fetchPool()
      if (cancelled) return
      setTimeout(poll, 1000)
    }
    poll()
    return () => { cancelled = true }
  }, [roundId, fetchPool])

  // Fetch recent round outcomes from Pyth 1-min candle data
  // Re-runs on round change + delayed retry (candle may not be available instantly)
  useEffect(() => {
    let cancelled = false
    const fetchHistory = async () => {
      try {
        const currentRoundId = Math.floor(Date.now() / 60000)
        const from = (currentRoundId - 6) * 60
        const to = currentRoundId * 60
        const res = await fetch(`/api/pyth-price?from=${from}&to=${to}`)
        if (!res.ok || cancelled) return
        const data = await res.json()
        if (cancelled || !data.ok) return

        const timestamps: number[] = data.timestamps || []
        const opens: number[] = data.open || []
        const closes: number[] = data.close || []

        if (timestamps.length === 0) return

        const results: { id: string; outcome: 'UP' | 'DOWN' }[] = []
        for (let i = 0; i < timestamps.length; i++) {
          const roundId = Math.floor(timestamps[i] / 60)
          if (roundId >= currentRoundId) continue
          results.push({
            id: String(roundId),
            outcome: closes[i] > opens[i] ? 'UP' : 'DOWN',
          })
        }

        setRecentRounds(results.slice(-5))
      } catch { /* ignore */ }
    }
    fetchHistory()
    // Retry after 3s — Pyth candle for the just-ended round may not be ready immediately
    const retryId = setTimeout(fetchHistory, 3000)
    return () => { cancelled = true; clearTimeout(retryId) }
  }, [roundId])

  // Estado de allowance (verifica no blockchain via API)
  // Inicializa do cache para evitar flash do overlay de approval em page reload
  const [tradingEnabled, setTradingEnabled] = useState<boolean | null>(() => {
    if (typeof localStorage === 'undefined') return null
    try {
      const data = getLocalStorage()
      const addr = data?.addresses?.stx?.[0]?.address
      if (addr) {
        const cacheKey = `bitpredix_trading_enabled_${addr}_${BITPREDIX_CONTRACT}`
        if (localStorage.getItem(cacheKey) === 'true') return true
      }
    } catch {}
    return null
  })
  const [checkingAllowance, setCheckingAllowance] = useState(false)
  const [tokenBalance, setTokenBalance] = useState(0) // USD (already divided by 1e6)
  const [canMint, setCanMint] = useState(false)
  const [mintingTokens, setMintingTokens] = useState(false)
  const mintSubmittedRef = useRef(0)

  // Verifica allowance no blockchain
  const checkAllowance = useCallback(async (addr: string) => {
    if (!addr || !BITPREDIX_CONTRACT) {
      setTradingEnabled(false)
      return
    }

    const cacheKey = `bitpredix_trading_enabled_${addr}_${BITPREDIX_CONTRACT}`
    const cachedEnabled = localStorage.getItem(cacheKey) === 'true'

    setCheckingAllowance(true)
    try {
      const response = await fetch(`/api/allowance-status?address=${encodeURIComponent(addr)}`)
      const data = await response.json()

      // Fetch balance + canMint in parallel (non-blocking)
      fetch(`/api/mint-status?address=${encodeURIComponent(addr)}`)
        .then(r => r.json())
        .then(d => {
          if (d.ok) {
            if (d.balance) {
              setTokenBalance(Number(d.balance) / 1e6)
              window.dispatchEvent(new CustomEvent('bitpredix:balance-updated', { detail: { balance: d.balance } }))
            }
            if (d.canMint !== true || !mintSubmittedRef.current) setCanMint(d.canMint === true)
          }
        })
        .catch(() => {})

      console.log('[MarketCardV4] Allowance check:', data)

      if (data.ok) {
        if (data.hasAllowance === true) {
          setTradingEnabled(true)
          localStorage.setItem(cacheKey, 'true')
        } else if (cachedEnabled) {
          // Blockchain diz sem allowance mas cache diz que tem
          // Provável que a tx de approve ainda não confirmou (testnet ~30-60s)
          // Mantém trading habilitado pelo cache
          console.log('[MarketCardV4] Blockchain says no allowance but cache says enabled, trusting cache')
          setTradingEnabled(true)
        } else {
          setTradingEnabled(false)
        }
      } else {
        // API falhou - usa localStorage como fallback
        setTradingEnabled(cachedEnabled)
      }
    } catch {
      // Erro de rede - usa localStorage como fallback
      setTradingEnabled(cachedEnabled)
    } finally {
      setCheckingAllowance(false)
    }
  }, [])

  // Busca endereco da carteira
  useEffect(() => {
    const refreshAddress = () => {
      if (!isConnected()) {
        setStxAddress(null)
        setTradingEnabled(false)
        return
      }
      const data = getLocalStorage()
      const addr = data?.addresses?.stx?.[0]?.address ?? null

      if (addr !== stxAddress) {
        setStxAddress(addr)
        if (addr) {
          // Usa cache do localStorage imediatamente para evitar flicker
          const cacheKey = `bitpredix_trading_enabled_${addr}_${BITPREDIX_CONTRACT}`
          if (localStorage.getItem(cacheKey) === 'true') {
            setTradingEnabled(true)
          }
          // Depois verifica no blockchain
          checkAllowance(addr)
        }
      }
    }
    refreshAddress()
    const interval = setInterval(refreshAddress, 2500)
    return () => clearInterval(interval)
  }, [stxAddress, checkAllowance])

  // Atualiza saldo do token após apostas/claims
  useEffect(() => {
    const refreshBalance = () => {
      if (!stxAddress) return
      fetch(`/api/mint-status?address=${encodeURIComponent(stxAddress)}`)
        .then(r => r.json())
        .then(d => {
          if (d.ok) {
            if (d.balance) {
              setTokenBalance(Number(d.balance) / 1e6)
              window.dispatchEvent(new CustomEvent('bitpredix:balance-updated', { detail: { balance: d.balance } }))
            }
            if (d.canMint !== true || !mintSubmittedRef.current) setCanMint(d.canMint === true)
          }
        })
        .catch(() => {})
    }
    window.addEventListener('bitpredix:balance-changed', refreshBalance)
    return () => window.removeEventListener('bitpredix:balance-changed', refreshBalance)
  }, [stxAddress])

  // Adiciona pontos ao historico de precos BTC (mantém últimos 5 min)
  useEffect(() => {
    if (!round || !currentPrice) return
    const timeSec = Math.floor(Date.now() / 1000)
    setBtcPriceHistory(prev => {
      let next: BtcPricePoint[]
      const last = prev[prev.length - 1]
      if (last && last.time === timeSec) {
        next = [...prev.slice(0, -1), { time: timeSec, price: currentPrice }]
      } else {
        next = [...prev, { time: timeSec, price: currentPrice }]
      }
      // Cap at 300 entries (~5 min at 1/s) to prevent unbounded growth
      if (next.length > 300) next = next.slice(-300)
      return next
    })
  }, [currentPrice, round])

  // Helper para obter publicKey com fallback
  async function requirePublicKey(): Promise<string> {
    const saved = getSavedPublicKey()
    if (saved) return saved
    // Fallback: pedir para a wallet (pode abrir popup)
    const res = await request('stx_getAddresses', { network: 'testnet' })
    const entry = (res as any)?.addresses?.find(
      (a: any) => a.address?.startsWith('ST') || a.address?.startsWith('SP')
    )
    if (!entry?.publicKey) throw new Error('Could not get public key from wallet. Please reconnect.')
    savePublicKey(entry.publicKey)
    return entry.publicKey
  }

  // Habilita trading (approve de valor alto, uma vez só)
  const enableTrading = async () => {
    if (!stxAddress) {
      setError('Connect wallet first')
      return
    }

    setTrading(true)
    setError(null)

    const [tokenAddr, tokenName] = TOKEN_CONTRACT.split('.')
    const [bitpredixAddr, bitpredixName] = BITPREDIX_CONTRACT.split('.')
    if (!tokenAddr || !tokenName || !bitpredixAddr || !bitpredixName) {
      setError('Token contract not configured')
      setTrading(false)
      return
    }

    try {
      const publicKey = await requirePublicKey()
      await sponsoredContractCall({
        contractAddress: tokenAddr,
        contractName: tokenName,
        functionName: 'approve',
        functionArgs: [
          contractPrincipalCV(bitpredixAddr, bitpredixName),
          uintCV(MAX_APPROVE_AMOUNT)
        ],
        publicKey,
      })
      const key = `bitpredix_trading_enabled_${stxAddress}_${BITPREDIX_CONTRACT}`
      localStorage.setItem(key, 'true')
      setTradingEnabled(true)
    } catch (e) {
      if (e instanceof Error && e.message !== 'Cancelled') {
        setError(e.message)
      }
    } finally {
      setTrading(false)
    }
  }

  // Mint test tokens (onboarding step after approval)
  const mintTokens = async () => {
    const [tokenAddr, tokenName] = TOKEN_CONTRACT.split('.')
    if (!tokenAddr || !tokenName) {
      setError('Token contract not configured')
      return
    }
    setMintingTokens(true)
    setError(null)
    try {
      const publicKey = await requirePublicKey()
      await sponsoredContractCall({
        contractAddress: tokenAddr,
        contractName: tokenName,
        functionName: 'mint',
        functionArgs: [],
        publicKey,
      })
      mintSubmittedRef.current = Date.now()
      setCanMint(false)
      window.dispatchEvent(new CustomEvent('bitpredix:balance-changed'))
    } catch (e) {
      if (e instanceof Error && e.message !== 'Cancelled') {
        setError(e.message)
      }
    } finally {
      setMintingTokens(false)
    }
  }

  // Valida e executa a aposta direto (wallet já serve de confirmação)
  const buy = async (side: Side) => {
    const v = parseFloat(amount)
    if (isNaN(v) || v <= 0) {
      setError('Enter a valid amount')
      return
    }
    if (v < MIN_BET_USD) {
      setError(`Min. $${MIN_BET_USD} to predict`)
      return
    }
    if (!round) {
      setError('No active round')
      return
    }
    if (Date.now() >= round.tradingClosesAt) {
      setError('Predictions closed for this round')
      return
    }
    if (!stxAddress) {
      setError('Connect wallet first')
      return
    }
    if (!tradingEnabled) {
      setError('Enable predictions first (click button below)')
      return
    }
    setTrading(true)
    setError(null)

    // GATEWAY: place-bet goes through the gateway contract, not predixv2 directly
    const [gwAddr, gwName] = GATEWAY_CONTRACT.split('.')
    if (!gwAddr || !gwName) {
      setError('Gateway contract not configured')
      setTrading(false)
      return
    }

    const amountMicro = Math.round(v * 1e6) // 6 decimais

    // Calculate early flag BEFORE calling sponsoredContractCall
    const roundStartMs = (round.id) * 60 * 1000
    const isEarly = Date.now() - roundStartMs < 20_000

    try {
      const publicKey = await requirePublicKey()
      const txid = await sponsoredContractCall({
        contractAddress: gwAddr,
        contractName: gwName,
        functionName: 'place-bet',
        functionArgs: [
          uintCV(round.id),
          stringAsciiCV(side),
          uintCV(amountMicro),
          boolCV(isEarly),
        ],
        publicKey,
      })
      console.log('Bet sponsored & broadcast:', txid)

      if (isEarly) {
        setIsEarlyBet(true)
      }

      // Sucesso — acumula apostas no round atual (functional updater to avoid stale closure)
      setRoundBets(prev => {
        const base = (prev?.roundId === round.id) ? prev : { roundId: round.id, up: 0, down: 0 }
        return {
          roundId: round.id,
          up: base.up + (side === 'UP' ? v : 0),
          down: base.down + (side === 'DOWN' ? v : 0),
        }
      })
      setAmount('')

      // Use txid as tradeId for dedup — sponsor already wrote to KV with this ID,
      // so pool-update will be a no-op (dedup hit). This prevents double-counting.
      const tradeId = txid
      shownTradeIdsRef.current.add(tradeId)

      // Show own bet in trade tape immediately
      pushTradeTape(side, Math.round(v))

      // Optimistic pool update — reflect bet instantly in UI
      setPool(prev => {
        const up = (prev?.totalUp ?? 0) + (side === 'UP' ? v : 0)
        const down = (prev?.totalDown ?? 0) + (side === 'DOWN' ? v : 0)
        const { priceUp, priceDown } = calcSeededPrices(up, down)
        return { totalUp: up, totalDown: down, priceUp, priceDown }
      })

      // Notify server so ALL clients see this bet via KV polling
      const poolPayload = JSON.stringify({ roundId: round.id, side, amountMicro, tradeId })
      const postPool = () => fetch('/api/pool-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: poolPayload,
      })
      postPool().catch(() => {
        setTimeout(() => postPool().catch(() => {}), 1000)
      })

      // Dispara evento para atualizar saldo em outros componentes
      window.dispatchEvent(new CustomEvent('bitpredix:balance-changed'))

    } catch (e) {
      if (e instanceof Error && e.message !== 'Cancelled') {
        setError(e.message)
      }
    } finally {
      setTrading(false)
    }
  }

  const PRESETS = [1, 5, 10, 50, 100] as const

  const now = Date.now()
  const isTradingOpen = round && now < round.tradingClosesAt
  const canTrade = isTradingOpen && stxAddress && !trading
  const inputsEnabled = stxAddress && tradingEnabled && isTradingOpen && !trading

  // Delta entre preço atual e preço de abertura
  const priceDelta = currentPrice && openPriceRef.current
    ? currentPrice - openPriceRef.current
    : null

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/80 overflow-hidden">
      {/* Header */}
      <div className="px-3 sm:px-5 py-2.5 sm:py-3 border-b border-zinc-800 flex items-center gap-2 sm:gap-3">
        {/* Pair */}
        <div className="flex items-center gap-1.5 shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="https://cdn.jsdelivr.net/npm/cryptocurrency-icons@0.18.1/svg/color/btc.svg"
            alt="BTC"
            className="w-5 h-5 sm:w-6 sm:h-6"
          />
          <span className="text-sm sm:text-base font-semibold text-zinc-200">BTC/USD</span>
        </div>

        {/* Prices: Open → Current + Delta */}
        <div className="flex items-center gap-1 sm:gap-1.5 flex-1 min-w-0 justify-center">
          <span className="font-mono text-xs text-zinc-500 hidden sm:inline">
            ${round?.priceAtStart?.toLocaleString('en-US', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2
            }) ?? '—'}
          </span>
          <span className="text-zinc-600 text-xs hidden sm:inline">→</span>
          <span className="font-mono text-sm sm:text-base font-bold text-bitcoin">
            <BtcPrice price={currentPrice} loading={priceLoading} error={priceError} />
          </span>
          {priceDelta !== null && (
            <span className={`shrink-0 text-[10px] sm:text-xs font-mono font-medium px-1.5 py-0.5 rounded-md ${
              priceDelta >= 0 ? 'text-up bg-up/10' : 'text-down bg-down/10'
            }`}>
              {priceDelta >= 0 ? '+' : '-'}${Math.abs(priceDelta).toFixed(2)}
            </span>
          )}
        </div>

        {/* Countdown */}
        {round ? (
          <Countdown
            endsAt={round.endsAt}
            serverTimeSkew={0}
            onEnd={() => {}}
            onTick={() => {}}
            className="text-base sm:text-xl font-bold text-amber-400 leading-none tabular-nums shrink-0"
          />
        ) : (
          <span className="text-base sm:text-xl font-bold font-mono text-zinc-600 leading-none shrink-0">—</span>
        )}
      </div>

      <div className="px-3 pt-3 pb-2 sm:p-6">
        {/* Status Bar — premium terminal-style notification system */}
        {(() => {
          /* ── Jackpot money-bag badge (reused across all states) ── */
          const JackpotBadge = jackpot ? (
            <div className={`shrink-0 relative ml-auto pl-2 w-10 h-10 flex items-center justify-center ${earlySecsLeft > 0 ? 'animate-jackpot-glow' : ''}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/moneybag.png" alt="" className="w-9 h-9 object-contain select-none pointer-events-none" draggable={false} />
              {/* Value centered on the bag body */}
              <span className="absolute top-1/2 left-1/2 -translate-x-[20%] translate-y-[35%] font-mono text-[9px] font-black text-zinc-900 leading-none whitespace-nowrap drop-shadow-[0_0_2px_rgba(251,191,36,0.6)]">
                ${jackpot.balance >= 1000
                  ? `${(jackpot.balance / 1000).toFixed(1)}k`
                  : jackpot.balance.toFixed(0)}
              </span>
            </div>
          ) : null

          return (
            <div className="mb-3 animate-status-in">
              {/* Fixed-height container — never changes size across states */}
              <div className="h-11 relative overflow-hidden rounded-lg flex items-center">
                {roundResult ? (
                  /* ── WIN / LOSS ── */
                  <div
                    className={`absolute inset-0 flex items-center gap-2 px-3 ${
                      roundResult.won
                        ? 'bg-up/[0.07] border border-up/20 rounded-lg'
                        : 'bg-down/[0.07] border border-down/20 rounded-lg'
                    }`}
                  >
                    <div className={`absolute left-0 top-0 bottom-0 w-[3px] ${roundResult.won ? 'bg-up' : 'bg-down'}`} />
                    <span className={`text-sm font-bold shrink-0 ${roundResult.won ? 'text-up' : 'text-down'}`}>
                      {roundResult.won ? '✓' : '✗'}
                    </span>
                    <span className={`font-bold text-sm shrink-0 ${roundResult.won ? 'text-up' : 'text-down'}`}>
                      {roundResult.won ? 'Won' : 'Lost'}
                    </span>
                    {roundResult.netPnL !== null && (
                      <span className={`font-mono text-sm font-bold ${roundResult.won ? 'text-up' : 'text-down'}`}>
                        {roundResult.netPnL >= 0 ? '+' : '−'}${Math.abs(roundResult.netPnL).toFixed(2)}
                      </span>
                    )}
                    <div className="flex-1" />
                    <button
                      onClick={() => setRoundResult(null)}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium shrink-0 transition-all active:scale-95 ${
                        roundResult.won
                          ? 'bg-up/20 text-up hover:bg-up/30'
                          : 'bg-down/20 text-down hover:bg-down/30'
                      }`}
                    >
                      OK
                    </button>
                    {JackpotBadge}
                  </div>
                ) : error ? (
                  /* ── ERROR ── */
                  <div className="absolute inset-0 flex items-center gap-2 px-3 bg-red-500/[0.07] border border-red-500/20 rounded-lg">
                    <div className="absolute left-0 top-0 bottom-0 w-[3px] bg-red-500" />
                    <span className="text-red-400 text-sm shrink-0">!</span>
                    <span className="flex-1 text-xs text-red-300 truncate">{error}</span>
                    <button
                      onClick={() => setError(null)}
                      className="px-2.5 py-1 rounded-md bg-red-500/15 hover:bg-red-500/25 text-red-300 text-xs font-medium shrink-0 transition-all active:scale-95"
                    >
                      Dismiss
                    </button>
                    {JackpotBadge}
                  </div>
                ) : trading ? (
                  /* ── AWAITING WALLET ── */
                  <div className="absolute inset-0 flex items-center gap-2 px-3 bg-amber-500/[0.06] border border-amber-500/20 rounded-lg">
                    <div className="absolute left-0 top-0 bottom-0 w-[3px] bg-amber-400" />
                    <div className="h-4 w-4 rounded-full border-2 border-amber-400/60 border-t-amber-400 animate-spin shrink-0" />
                    <span className="text-sm text-amber-200 font-medium flex-1">Awaiting wallet...</span>
                    {JackpotBadge}
                  </div>
                ) : roundBets && roundBets.roundId === round?.id && (roundBets.up > 0 || roundBets.down > 0) ? (
                  /* ── ACTIVE BETS ── */
                  <div className={`absolute inset-0 flex items-center gap-2 px-3 rounded-lg ${
                    earlySecsLeft > 0
                      ? 'bg-yellow-500/[0.04] border border-yellow-500/20'
                      : 'bg-zinc-800/60 border border-zinc-700/40'
                  }`}>
                    <div className={`absolute left-0 top-0 bottom-0 w-[3px] ${earlySecsLeft > 0 ? 'bg-yellow-500' : 'bg-bitcoin'}`} />
                    {roundBets.up > 0 && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-up/10 text-up text-xs font-mono font-medium shrink-0">
                        ▲ ${roundBets.up}
                      </span>
                    )}
                    {roundBets.down > 0 && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-down/10 text-down text-xs font-mono font-medium shrink-0">
                        ▼ ${roundBets.down}
                      </span>
                    )}
                    {earlySecsLeft > 0 ? (
                      <span className="text-[10px] text-yellow-400/80 font-medium truncate">
                        Predict more for bigger Jackpot share — {earlySecsLeft}s
                      </span>
                    ) : isEarlyBet ? (
                      <span className="px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-400 text-[9px] font-bold uppercase tracking-wider shrink-0">
                        Jackpot
                      </span>
                    ) : null}
                    <div className="flex-1" />
                    {JackpotBadge}
                  </div>
                ) : isTradingOpen ? (
                  /* ── MARKET OPEN ── */
                  <div className={`absolute inset-0 flex items-center gap-2 px-3 rounded-lg ${
                    earlySecsLeft > 0 && jackpot
                      ? 'bg-yellow-500/[0.04] border border-yellow-500/20'
                      : 'bg-zinc-800/40 border border-zinc-700/30'
                  }`}>
                    <div className={`absolute left-0 top-0 bottom-0 w-[3px] ${
                      earlySecsLeft > 0 && jackpot ? 'bg-yellow-500' : 'bg-up/60'
                    }`} />
                    <div className="relative flex items-center justify-center w-2 h-2 shrink-0">
                      <span className={`absolute w-2 h-2 rounded-full animate-ping ${earlySecsLeft > 0 && jackpot ? 'bg-yellow-400/40' : 'bg-up/40'}`} />
                      <span className={`w-1.5 h-1.5 rounded-full ${earlySecsLeft > 0 && jackpot ? 'bg-yellow-400' : 'bg-up'}`} />
                    </div>
                    {earlySecsLeft > 0 && jackpot ? (
                      <span className="text-sm text-yellow-200 font-bold flex-1 truncate">
                        Predict now for Jackpot — {earlySecsLeft}s
                      </span>
                    ) : (
                      <span className="text-sm text-zinc-300 font-medium flex-1">Market open</span>
                    )}
                    {JackpotBadge}
                  </div>
                ) : (
                  /* ── TRADING CLOSED ── */
                  <div className="absolute inset-0 flex items-center gap-2 px-3 bg-zinc-800/40 border border-zinc-700/30 rounded-lg">
                    <div className="absolute left-0 top-0 bottom-0 w-[3px] bg-amber-500/60" />
                    <div className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                    <span className="text-sm text-amber-400/90 flex-1">Next round starting...</span>
                    {JackpotBadge}
                  </div>
                )}
              </div>
            </div>
          )
        })()}

        {/* BTC Price Chart (full width, Polymarket style) */}
        <div className="relative mb-3 sm:mb-4 rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
          {round && (
            <BtcPriceChart
              data={btcPriceHistory}
              openPrice={openPriceRef.current}
              roundStartAt={round.startAt}
              roundEndsAt={round.endsAt}
            />
          )}
          {/* Recent rounds overlay — opacity fades from oldest (left) to newest (right) */}
          {recentRounds.length > 0 && (
            <div className="absolute top-1.5 left-1.5 sm:top-2 sm:left-2 z-10 flex items-center gap-1 sm:gap-1.5 px-1.5 sm:px-2 py-0.5 sm:py-1 rounded sm:rounded-md bg-zinc-900/70 backdrop-blur-sm border border-zinc-800/50">
              {recentRounds.map((r, i) => {
                const opacity = 0.3 + (0.7 * (i / Math.max(recentRounds.length - 1, 1)))
                return (
                  <span
                    key={r.id}
                    style={{ opacity }}
                    className={`text-[8px] sm:text-[10px] font-mono font-bold leading-none ${
                      r.outcome === 'UP' ? 'text-up' : 'text-down'
                    }`}
                    title={`${recentRounds.length - i} min ago · ${r.outcome}`}
                  >
                    {r.outcome === 'UP' ? '▲' : '▼'}
                  </span>
                )
              })}
              <span className="text-[7px] sm:text-[8px] text-zinc-500 leading-none ml-0.5">now</span>
            </div>
          )}
          {/* Trade tape — live bet feed (bottom-left) */}
          <TradeTape items={tradeTape} />
        </div>

        {/* Trading Controls */}
        {(() => {
          const needsApproval = stxAddress && !checkingAllowance && tradingEnabled === false
          const isChecking = stxAddress && checkingAllowance
          const needsMint = stxAddress && tradingEnabled === true && tokenBalance === 0 && canMint
          const showOverlay = needsApproval || isChecking || needsMint
          return (
            <div className="relative">
              {/* Trading controls — always rendered to lock the height; invisible when overlay active */}
              <div className={showOverlay ? 'invisible' : ''}>
                <div className="space-y-3 sm:space-y-4">
                  <div className="flex items-center gap-1">
                    <div className="relative w-[72px] sm:w-20 shrink-0">
                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-500 text-xs pointer-events-none">$</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        placeholder="0"
                        value={amount}
                        onChange={(e) => {
                          const v = e.target.value
                          if (v === '' || tokenBalance <= 0) { setAmount(v); return }
                          const n = parseFloat(v)
                          if (!isNaN(n) && n > tokenBalance) { setAmount(String(Math.floor(tokenBalance))); return }
                          setAmount(v)
                        }}
                        disabled={!inputsEnabled}
                        className="w-full font-mono pl-5 pr-1 py-2 rounded-lg bg-zinc-800/80 border border-zinc-700 text-zinc-100 text-xs sm:text-sm placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-bitcoin/50 focus:border-bitcoin disabled:opacity-40 disabled:cursor-not-allowed"
                      />
                    </div>
                    {PRESETS.map((d) => (
                      <button
                        key={d}
                        type="button"
                        disabled={!inputsEnabled}
                        onClick={() => {
                          const next = (parseFloat(amount) || 0) + d
                          setAmount(String(tokenBalance > 0 ? Math.min(next, Math.floor(tokenBalance)) : next))
                        }}
                        className="flex-1 sm:flex-none min-w-0 sm:px-3 py-2 rounded-lg font-mono text-xs transition disabled:opacity-40 disabled:cursor-not-allowed bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700"
                      >
                        ${d}
                      </button>
                    ))}
                    {tokenBalance > 0 && (
                      <button
                        type="button"
                        disabled={!inputsEnabled}
                        onClick={() => setAmount(String(Math.floor(tokenBalance)))}
                        className={`flex-1 sm:flex-none min-w-0 sm:px-3 py-2 rounded-lg font-mono text-xs transition disabled:opacity-40 disabled:cursor-not-allowed ${
                          amount === String(Math.floor(tokenBalance))
                            ? 'bg-bitcoin/30 text-bitcoin border border-bitcoin/50'
                            : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700'
                        }`}
                      >
                        Max
                      </button>
                    )}
                  </div>

                  {(() => {
                    const upPct = (pool?.priceUp ?? 0.5) * 100
                    const realTotal = (pool?.totalUp ?? 0) + (pool?.totalDown ?? 0)
                    return (
                      <div className="space-y-1">
                        <div className="h-1.5 rounded-full overflow-hidden flex bg-zinc-800">
                          <div className="bg-up/70 transition-all duration-500" style={{ width: `${upPct}%` }} />
                          <div className="bg-down/70 transition-all duration-500" style={{ width: `${100 - upPct}%` }} />
                        </div>
                        <div className="flex justify-between text-[10px] text-zinc-500 font-mono">
                          <span>{Math.round(upPct)}% UP</span>
                          <span>${realTotal.toLocaleString('en-US', { maximumFractionDigits: 0 })} pool</span>
                          <span>{Math.round(100 - upPct)}% DOWN</span>
                        </div>
                      </div>
                    )
                  })()}

                  <div className="grid grid-cols-2 gap-2 sm:gap-3">
                    <button
                      onClick={() => buy('UP')}
                      disabled={!canTrade}
                      className="flex items-center justify-center rounded-xl bg-up py-2.5 sm:py-3 text-white transition hover:bg-up/90 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <span className="text-base sm:text-lg font-bold leading-tight tracking-wide">UP</span>
                    </button>
                    <button
                      onClick={() => buy('DOWN')}
                      disabled={!canTrade}
                      className="flex items-center justify-center rounded-xl bg-down py-2.5 sm:py-3 text-white transition hover:bg-down/90 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <span className="text-base sm:text-lg font-bold leading-tight tracking-wide">DOWN</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* Onboarding overlay — approval or mint step */}
              {showOverlay && (
                <div className="absolute inset-0 flex flex-col justify-between">
                  <div className="flex items-center gap-2.5">
                    {needsMint ? (
                      <div className="w-7 h-7 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center shrink-0">
                        <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                        </svg>
                      </div>
                    ) : (
                      <div className="w-7 h-7 rounded-lg bg-bitcoin/10 border border-bitcoin/20 flex items-center justify-center shrink-0">
                        <svg className="w-3.5 h-3.5 text-bitcoin" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" />
                        </svg>
                      </div>
                    )}
                    <div className="min-w-0">
                      {needsMint ? (
                        <>
                          <p className="text-xs sm:text-sm font-medium text-zinc-200 leading-tight">Get test tokens</p>
                          <p className="text-[11px] text-zinc-500 leading-tight mt-0.5">Mint free TUSDC to start predicting</p>
                        </>
                      ) : (
                        <>
                          <p className="text-xs sm:text-sm font-medium text-zinc-200 leading-tight">Approve TUSDC to predict</p>
                          <p className="text-[11px] text-zinc-500 leading-tight mt-0.5">One-time contract approval</p>
                        </>
                      )}
                    </div>
                  </div>

                  {needsMint ? (
                    <button
                      onClick={mintTokens}
                      disabled={mintingTokens}
                      className="w-full flex flex-col items-center justify-center rounded-xl bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 py-2.5 sm:py-3 hover:bg-emerald-500/30 hover:border-emerald-500/60 disabled:opacity-50 disabled:cursor-not-allowed transition"
                    >
                      {mintingTokens ? (
                        <span className="flex items-center gap-2 text-sm font-semibold">
                          <span className="h-4 w-4 border-2 border-emerald-500/40 border-t-emerald-400 rounded-full animate-spin" />
                          Awaiting wallet...
                        </span>
                      ) : (
                        <>
                          <span className="text-base sm:text-lg font-bold leading-tight tracking-wide">Mint TUSDC</span>
                          <span className="text-[11px] sm:text-xs font-mono opacity-70 leading-tight">free test tokens</span>
                        </>
                      )}
                    </button>
                  ) : needsApproval ? (
                    <button
                      onClick={enableTrading}
                      disabled={trading}
                      className="w-full flex flex-col items-center justify-center rounded-xl bg-bitcoin/20 border border-bitcoin/40 text-bitcoin py-2.5 sm:py-3 hover:bg-bitcoin/30 hover:border-bitcoin/60 disabled:opacity-50 disabled:cursor-not-allowed transition"
                    >
                      {trading ? (
                        <span className="flex items-center gap-2 text-sm font-semibold">
                          <span className="h-4 w-4 border-2 border-bitcoin/40 border-t-bitcoin rounded-full animate-spin" />
                          Awaiting wallet...
                        </span>
                      ) : (
                        <>
                          <span className="text-base sm:text-lg font-bold leading-tight tracking-wide">Approve & Start</span>
                          <span className="text-[11px] sm:text-xs font-mono opacity-70 leading-tight">enable predictions</span>
                        </>
                      )}
                    </button>
                  ) : (
                    <div className="w-full flex flex-col items-center justify-center rounded-xl border border-zinc-800 py-2.5 sm:py-3">
                      <span className="flex items-center gap-2 text-sm text-zinc-500">
                        <span className="h-4 w-4 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
                        Checking approval...
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })()}
      </div>
    </div>
  )
}
