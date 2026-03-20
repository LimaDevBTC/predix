import { NextRequest, NextResponse } from 'next/server'
import { withAgentAuth } from '@/lib/agent-auth'
import { getRoundState, getRecentTrades, getRoundBettorValidity, getProjectedJackpot } from '@/lib/pool-store'
// Direct Pyth fetch (can't import from lib/pyth.ts — it has React hooks which break server routes)
const PYTH_BTC_USD_FEED = 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43'
const HERMES_URL = 'https://hermes.pyth.network'

async function fetchBtcPrice(): Promise<number | null> {
  try {
    const url = `${HERMES_URL}/v2/updates/price/latest?ids[]=${PYTH_BTC_USD_FEED}&encoding=base64&parsed=true`
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
    if (!res.ok) return null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await res.json() as any
    const p = data.parsed?.[0]?.price
    if (!p) return null
    return Number(p.price) * Math.pow(10, p.expo)
  } catch { return null }
}

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

import { BITPREDIX_CONTRACT, GATEWAY_CONTRACT, TOKEN_CONTRACT, NETWORK_NAME, splitContractId } from '@/lib/config'
import { HIRO_API, hiroHeaders, disableApiKey } from '@/lib/hiro'

const VIRTUAL_SEED = 100 * 1e6 // $100 virtual seed liquidity (micro-units)
const FEE_BPS = 300

// On-chain round data (cached 5s)
let onChainCache: { roundId: number; up: number; down: number; resolved: boolean; priceStart: number; priceEnd: number; ts: number } | null = null

async function getOnChainRound(roundId: number) {
  if (onChainCache && onChainCache.roundId === roundId && Date.now() - onChainCache.ts < 5000) {
    return onChainCache
  }
  try {
    const [addr, name] = splitContractId(BITPREDIX_CONTRACT)
    const { uintCV, tupleCV, cvToHex, deserializeCV } = await import('@stacks/transactions')
    const keyHex = cvToHex(tupleCV({ 'round-id': uintCV(roundId) }))
    let res = await fetch(
      `${HIRO_API}/v2/map_entry/${addr}/${name}/rounds?proof=0&tip=latest`,
      { method: 'POST', headers: hiroHeaders(), body: JSON.stringify(keyHex), cache: 'no-store', signal: AbortSignal.timeout(4000) }
    )
    if (res.status === 429) {
      disableApiKey()
      res = await fetch(
        `${HIRO_API}/v2/map_entry/${addr}/${name}/rounds?proof=0&tip=latest`,
        { method: 'POST', headers: hiroHeaders(), body: JSON.stringify(keyHex), cache: 'no-store', signal: AbortSignal.timeout(4000) }
      )
    }
    const json = (await res.json()) as { data?: string }
    if (!res.ok || !json.data) return { roundId, up: 0, down: 0, resolved: false, priceStart: 0, priceEnd: 0, ts: Date.now() }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cv = deserializeCV(json.data) as any
    const tuple = (cv?.type === 'some' && cv?.value) ? cv.value : cv
    // v7 @stacks/transactions: tuple fields are under .value, not .data
    const d = tuple?.value ?? tuple?.data ?? cv?.value ?? cv?.data
    if (!d) return { roundId, up: 0, down: 0, resolved: false, priceStart: 0, priceEnd: 0, ts: Date.now() }

    const u = (k: string) => Number(d[k]?.value ?? 0)
    const resolvedField = d['resolved']
    const resolved = resolvedField?.type === 'true' || resolvedField?.value === true || String(resolvedField?.value) === 'true'
    const result = { roundId, up: u('total-up'), down: u('total-down'), resolved, priceStart: u('price-start'), priceEnd: u('price-end'), ts: Date.now() }
    onChainCache = result
    return result
  } catch {
    if (onChainCache && onChainCache.roundId === roundId) return onChainCache
    return { roundId, up: 0, down: 0, resolved: false, priceStart: 0, priceEnd: 0, ts: Date.now() }
  }
}

export const GET = (req: NextRequest) =>
  withAgentAuth(req, async () => {
    try {
    const now = Date.now()
    const roundId = Math.floor(now / 1000 / 60)
    const startAt = roundId * 60 * 1000
    const endsAt = (roundId + 1) * 60 * 1000
    const secondsRemaining = Math.max(0, Math.round((endsAt - now) / 1000))
    const tradingOpen = (endsAt - now) > 10_000 // sponsor cutoff is 10s

    const [roundState, recentTrades, onChain, bettorValidity, projectedJackpot, pythPrice] = await Promise.all([
      getRoundState(roundId),
      getRecentTrades(roundId),
      getOnChainRound(roundId),
      getRoundBettorValidity(roundId),
      getProjectedJackpot(),
      fetchBtcPrice(),
    ])

    const totalUp = Math.max(onChain.up, roundState.up)
    const totalDown = Math.max(onChain.down, roundState.down)
    const totalVolume = totalUp + totalDown

    // Odds with virtual seed
    const effUp = VIRTUAL_SEED + totalUp
    const effDown = VIRTUAL_SEED + totalDown
    const oddsUp = effUp / (effUp + effDown)
    const oddsDown = 1 - oddsUp

    // Effective payout multiplier per side (what you get per $1 bet)
    const feeMultiplier = 1 - FEE_BPS / 10000
    const effectivePayoutUp = totalVolume > 0
      ? ((totalUp + totalDown) / (totalUp || 1)) * feeMultiplier
      : 2 * feeMultiplier
    const effectivePayoutDown = totalVolume > 0
      ? ((totalUp + totalDown) / (totalDown || 1)) * feeMultiplier
      : 2 * feeMultiplier

    return NextResponse.json({
      ok: true,
      timestamp: now,
      round: {
        id: roundId,
        startAt,
        endsAt,
        secondsRemaining,
        tradingOpen,
        status: onChain.resolved ? 'resolved' : 'open',
        openPrice: roundState.openPrice || null,
        currentPrice: pythPrice ?? null,
        priceChangePct: roundState.openPrice && pythPrice
          ? ((pythPrice - roundState.openPrice) / roundState.openPrice) * 100
          : null,
        pool: {
          totalUp: totalUp / 1e6,
          totalDown: totalDown / 1e6,
          totalVolume: totalVolume / 1e6,
          oddsUp: Math.round(oddsUp * 1000) / 1000,
          oddsDown: Math.round(oddsDown * 1000) / 1000,
        },
        effectivePayoutUp: Math.round(effectivePayoutUp * 100) / 100,
        effectivePayoutDown: Math.round(effectivePayoutDown * 100) / 100,
        recentTrades,
        hasCounterparty: bettorValidity.hasCounterparty,
        uniqueWallets: bettorValidity.uniqueWallets,
        jackpot: {
          balance: Math.max(0, projectedJackpot) / 1e6,
          earlyUp: Math.max(0, roundState.earlyUp) / 1e6,
          earlyDown: Math.max(0, roundState.earlyDown) / 1e6,
        },
      },
      contract: {
        id: BITPREDIX_CONTRACT,
        gateway: GATEWAY_CONTRACT,
        token: TOKEN_CONTRACT,
        minBetUsd: 1,
        feeBps: FEE_BPS,
        roundDurationSec: 60,
        network: NETWORK_NAME,
      },
    }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    })
    } catch (err) {
      console.error('[agent/market] Error:', err)
      return NextResponse.json({ ok: false, error: 'Failed to fetch market data' }, { status: 500 })
    }
  })
