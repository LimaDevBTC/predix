import { NextRequest, NextResponse } from 'next/server'
import { withAgentAuth } from '@/lib/agent-auth'
import { getRoundState, getRoundBettorValidity, getProjectedJackpot } from '@/lib/pool-store'
// Server-safe Pyth price fetch (can't import lib/pyth.ts — has React hooks)
const PYTH_BTC_USD_FEED = 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43'
async function fetchBtcPrice(): Promise<number | null> {
  try {
    const res = await fetch(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${PYTH_BTC_USD_FEED}&encoding=base64&parsed=true`, { signal: AbortSignal.timeout(4000) })
    if (!res.ok) return null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await res.json() as any
    const p = data.parsed?.[0]?.price
    if (!p) return null
    return Number(p.price) * Math.pow(10, p.expo)
  } catch { return null }
}
import { getRoundHistory } from '@/lib/round-indexer'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

const VIRTUAL_SEED = 100 * 1e6
const FEE_BPS = 300

import { BITPREDIX_CONTRACT, splitContractId } from '@/lib/config'
import { HIRO_API, hiroHeaders, disableApiKey } from '@/lib/hiro'

// On-chain round data (same as market endpoint)
async function getOnChainRound(roundId: number) {
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
    if (!res.ok || !json.data) return { up: 0, down: 0, resolved: false }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cv = deserializeCV(json.data) as any
    const tuple = (cv?.type === 'some' && cv?.value) ? cv.value : cv
    // v7 @stacks/transactions: tuple fields are under .value, not .data
    const d = tuple?.value ?? tuple?.data ?? cv?.value ?? cv?.data
    if (!d) return { up: 0, down: 0, resolved: false }
    const u = (k: string) => Number(d[k]?.value ?? 0)
    const resolvedField = d['resolved']
    const resolved = resolvedField?.type === 'true' || resolvedField?.value === true || String(resolvedField?.value) === 'true'
    return { up: u('total-up'), down: u('total-down'), resolved }
  } catch {
    return { up: 0, down: 0, resolved: false }
  }
}

export const GET = (req: NextRequest) =>
  withAgentAuth(req, async () => {
    try {
    const now = Date.now()
    const roundId = Math.floor(now / 1000 / 60)
    const endsAt = (roundId + 1) * 60 * 1000
    const secondsRemaining = Math.max(0, Math.round((endsAt - now) / 1000))
    const tradingOpen = (endsAt - now) > 10_000

    const [roundState, onChain, validity, projectedJackpot, pythPrice, history] = await Promise.all([
      getRoundState(roundId),
      getOnChainRound(roundId),
      getRoundBettorValidity(roundId),
      getProjectedJackpot(),
      fetchBtcPrice(),
      getRoundHistory({ page: 1, pageSize: 10 }).catch(() => ({ rounds: [], total: 0, hasMore: false })),
    ])

    const totalUp = Math.max(onChain.up, roundState.up)
    const totalDown = Math.max(onChain.down, roundState.down)
    const totalVolume = totalUp + totalDown

    // Odds with virtual seed
    const effUp = VIRTUAL_SEED + totalUp
    const effDown = VIRTUAL_SEED + totalDown
    const oddsUp = effUp / (effUp + effDown)

    // Payout multipliers
    const feeMul = 1 - FEE_BPS / 10000
    const payoutUp = totalVolume > 0 ? (totalVolume / (totalUp || 1)) * feeMul : 2 * feeMul
    const payoutDown = totalVolume > 0 ? (totalVolume / (totalDown || 1)) * feeMul : 2 * feeMul

    // Pool imbalance signal
    const imbalanceRatio = totalUp > 0 && totalDown > 0
      ? Math.max(totalUp / totalDown, totalDown / totalUp)
      : 1
    const favoredSide = totalUp < totalDown ? 'UP' : totalDown < totalUp ? 'DOWN' : null

    // Price direction signal
    const openPrice = roundState.openPrice
    const currentPrice = pythPrice ?? null
    const priceChangePct = openPrice && currentPrice
      ? ((currentPrice - openPrice) / openPrice) * 100
      : null
    const priceDirection = priceChangePct !== null
      ? (priceChangePct > 0 ? 'UP' : priceChangePct < 0 ? 'DOWN' : null)
      : null

    // Volume level
    const volumeLevel = totalVolume === 0 ? 'empty'
      : totalVolume < 5 * 1e6 ? 'low'
      : totalVolume < 50 * 1e6 ? 'medium'
      : 'high'

    // Recent outcomes
    const recentOutcomes = history.rounds
      .filter(r => r.resolved && r.outcome)
      .slice(0, 10)
      .map(r => r.outcome as string)

    // Streak
    let streak = { side: recentOutcomes[0] ?? null, length: 0 }
    for (const o of recentOutcomes) {
      if (o === streak.side) streak.length++
      else break
    }

    return NextResponse.json({
      ok: true,
      round: {
        id: roundId,
        tradingOpen,
        secondsRemaining,
      },
      signals: {
        poolImbalance: {
          favoredSide,
          imbalanceRatio: Math.round(imbalanceRatio * 100) / 100,
          payoutUp: Math.round(payoutUp * 100) / 100,
          payoutDown: Math.round(payoutDown * 100) / 100,
          description: favoredSide
            ? `${favoredSide} pool is underweight — higher potential payout (${favoredSide === 'UP' ? payoutUp.toFixed(2) : payoutDown.toFixed(2)}x)`
            : 'Pools are balanced',
        },
        priceDirection: {
          side: priceDirection,
          changePct: priceChangePct !== null ? Math.round(priceChangePct * 10000) / 10000 : null,
          openPrice,
          currentPrice,
          description: priceDirection
            ? `BTC ${priceDirection === 'UP' ? 'up' : 'down'} ${Math.abs(priceChangePct!).toFixed(4)}% in current round`
            : 'No price movement data',
        },
        volume: {
          totalUsd: totalVolume / 1e6,
          level: volumeLevel,
          uniqueWallets: validity.uniqueWallets,
          hasCounterparty: validity.hasCounterparty,
        },
        jackpot: {
          balanceUsd: Math.max(0, projectedJackpot) / 1e6,
          earlyWindowOpen: (now - roundId * 60 * 1000) < 20_000,
        },
      },
      recentOutcomes,
      streak,
    }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    })
    } catch (err) {
      console.error('[agent/opportunities] Error:', err)
      return NextResponse.json({ ok: false, error: 'Failed to compute opportunities' }, { status: 500 })
    }
  })
