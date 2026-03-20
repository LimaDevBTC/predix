import { getOrCreateCurrentRound } from '@/lib/rounds'
import { fetchBtcPriceUsd } from '@/lib/btc-price'
import { getPriceUp, getPriceDown } from '@/lib/amm'
import { getRoundState, getRecentTrades, heartbeatAndCount, getRoundBettorValidity, getLastResolvedRound } from '@/lib/pool-store'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

const ROUND_DURATION_MS = 60 * 1000
import { HIRO_API as HIRO_TESTNET, hiroHeaders, disableApiKey } from '@/lib/hiro'
import { BITPREDIX_CONTRACT } from '@/lib/config'
import { getJackpotBalance } from '@/lib/jackpot'
const BITPREDIX_ID = BITPREDIX_CONTRACT


// ---------------------------------------------------------------------------
// Hiro on-chain cache — on-chain data changes only on tx confirmation (~30s),
// so caching for 5s is safe and prevents the slow Hiro call from blocking polls.
// ---------------------------------------------------------------------------
let hiroCache: { roundId: number; up: number; down: number; resolved: boolean; priceStart: number; priceEnd: number; ts: number } | null = null
const HIRO_CACHE_TTL_MS = 10_000

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
  'Pragma': 'no-cache',
  'Expires': '0',
} as const

function noCacheJson(data: object, status = 200) {
  return NextResponse.json(data, { status, headers: NO_CACHE_HEADERS })
}

function roundToJson(r: { id: string; startAt: number; endsAt: number; tradingClosesAt?: number; priceAtStart: number; priceAtEnd?: number; outcome?: string; status: string; pool: object }) {
  const endsAt = r.startAt + ROUND_DURATION_MS
  return {
    id: r.id,
    startAt: r.startAt,
    endsAt,
    tradingClosesAt: r.tradingClosesAt ?? endsAt,
    priceAtStart: r.priceAtStart,
    priceAtEnd: r.priceAtEnd,
    outcome: r.outcome,
    status: r.status,
    pool: r.pool,
  }
}

function parseContractId(id: string): [string, string] {
  const i = id.lastIndexOf('.')
  if (i < 0) throw new Error(`Invalid contract id: ${id}`)
  return [id.slice(0, i), id.slice(i + 1)]
}

function emptyRoundResponse() {
  return noCacheJson({
    round: null,
    priceUp: 0.5,
    priceDown: 0.5,
    serverNow: Date.now(),
    onChainNoRound: true,
    ok: true,
  })
}

/** Fetch on-chain round data from Hiro (with 5s cache, invalidated on settlement signal). */
async function getOnChainData(roundId: number): Promise<{ up: number; down: number; resolved: boolean; priceStart: number; priceEnd: number }> {
  // Return cached if fresh — BUT invalidate if cron just resolved a round
  if (hiroCache && hiroCache.roundId === roundId && Date.now() - hiroCache.ts < HIRO_CACHE_TTL_MS) {
    // Check if cron signaled a resolution (cheap KV read, ~5ms)
    if (!hiroCache.resolved) {
      const lastResolved = await getLastResolvedRound()
      if (lastResolved && lastResolved >= roundId) {
        // Cache is stale — cron resolved this round, force fresh read
        hiroCache = null
      } else {
        return hiroCache
      }
    } else {
      return hiroCache
    }
  }

  try {
    const [contractAddress, contractName] = parseContractId(BITPREDIX_ID!)
    const { uintCV, tupleCV, cvToHex, deserializeCV } = await import('@stacks/transactions')
    const keyHex = cvToHex(tupleCV({ 'round-id': uintCV(roundId) }))
    let res = await fetch(
      `${HIRO_TESTNET}/v2/map_entry/${contractAddress}/${contractName}/rounds?proof=0&tip=latest`,
      {
        method: 'POST',
        headers: hiroHeaders(),
        body: JSON.stringify(keyHex),
        cache: 'no-store',
        signal: AbortSignal.timeout(4000), // don't let Hiro block us > 4s
      }
    )
    // Monthly quota exhausted — disable key and retry without it
    if (res.status === 429) {
      disableApiKey()
      res = await fetch(
        `${HIRO_TESTNET}/v2/map_entry/${contractAddress}/${contractName}/rounds?proof=0&tip=latest`,
        { method: 'POST', headers: hiroHeaders(), body: JSON.stringify(keyHex), cache: 'no-store', signal: AbortSignal.timeout(4000) }
      )
    }
    const json = (await res.json()) as { data?: string }
    if (!res.ok || !json.data) {
      return { up: 0, down: 0, resolved: false, priceStart: 0, priceEnd: 0 }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cv = deserializeCV(json.data) as any
    const tuple = (cv?.type === 'some' && cv?.value) ? cv.value : cv
    // v7 @stacks/transactions: tuple fields are under .value, not .data
    const d = tuple?.value ?? tuple?.data ?? cv?.value ?? cv?.data
    if (!d) {
      return { up: 0, down: 0, resolved: false, priceStart: 0, priceEnd: 0 }
    }
    const u = (k: string) => Number(d[k]?.value ?? 0)
    // v7: booleans have .type 'true'/'false', not .value
    const resolvedField = d['resolved']
    const resolved = resolvedField?.type === 'true' || resolvedField?.value === true || String(resolvedField?.value) === 'true'
    const result = { roundId, up: u('total-up'), down: u('total-down'), resolved, priceStart: u('price-start'), priceEnd: u('price-end'), ts: Date.now() }
    hiroCache = result
    return result
  } catch (err) {
    console.warn('[round] Hiro fetch failed, using KV only:', (err as Error).message)
    // Return stale cache if available, otherwise zeros
    if (hiroCache && hiroCache.roundId === roundId) return hiroCache
    return { up: 0, down: 0, resolved: false, priceStart: 0, priceEnd: 0 }
  }
}

// Jackpot is 100% off-chain in predixv3 — read from Redis
// Cache last known balance so Hiro failures don't flash $0 on clients
let lastKnownJackpotBalance = 0
async function getJackpotData(_roundId: number): Promise<{ balance: number; earlyUp: number; earlyDown: number }> {
  try {
    const balance = await getJackpotBalance()
    if (balance > 0) lastKnownJackpotBalance = balance
    return { balance: balance > 0 ? balance : lastKnownJackpotBalance, earlyUp: 0, earlyDown: 0 }
  } catch {
    return { balance: lastKnownJackpotBalance, earlyUp: 0, earlyDown: 0 }
  }
}

/** GET: obter rodada atual e precos. */
export async function GET(request: NextRequest) {
  try {
    const sid = request.nextUrl.searchParams.get('sid') || ''

    if (BITPREDIX_ID && BITPREDIX_ID.includes('.')) {
      const roundId = Math.floor(Date.now() / 1000 / 60)

      // Fetch KV (single HGETALL for pool+open+early) and on-chain (slow, cached) in parallel
      const [roundState, recentTrades, onChain, activeUsers, jackpotData, bettorValidity] = await Promise.all([
        getRoundState(roundId),
        getRecentTrades(roundId),
        getOnChainData(roundId),
        sid ? heartbeatAndCount(sid) : Promise.resolve(0),
        getJackpotData(roundId),
        getRoundBettorValidity(roundId),
      ])

      const totalUp = Math.max(onChain.up, roundState.up)
      const totalDown = Math.max(onChain.down, roundState.down)

      // Jackpot balance is off-chain (Redis) — no projection needed
      // The cron resolver credits jackpot after settlement

      const startAt = roundId * 60 * 1000
      const round = {
        id: `round-${roundId}`,
        startAt,
        endsAt: (roundId + 1) * 60 * 1000,
        tradingClosesAt: startAt + 50 * 1000,
        priceAtStart: onChain.priceStart / 100,
        priceAtEnd: onChain.priceEnd > 0 ? onChain.priceEnd / 100 : undefined,
        outcome: onChain.resolved ? (onChain.priceEnd > onChain.priceStart ? 'UP' : 'DOWN') : undefined,
        status: onChain.resolved ? 'resolved' : 'open',
        pool: {
          qUp: totalUp / 1e6,
          qDown: totalDown / 1e6,
          volumeTraded: (totalUp + totalDown) / 1e6,
        } as { qUp: number; qDown: number; volumeTraded: number },
      }
      const total = totalUp + totalDown
      const pu = total > 0 ? totalUp / total : 0.5
      const pd = 1 - pu
      return noCacheJson({
        round: roundToJson(round),
        priceUp: pu,
        priceDown: pd,
        serverNow: Date.now(),
        recentTrades,
        openPrice: roundState.openPrice,
        activeUsers,
        kvConnected: roundState._kvConnected ?? true,
        jackpot: {
          balance: jackpotData.balance / 1e6,
          earlyUp: roundState.earlyUp / 1e6,
          earlyDown: roundState.earlyDown / 1e6,
        },
        hasCounterparty: bettorValidity.hasCounterparty,
        uniqueWallets: bettorValidity.uniqueWallets,
        ok: true,
      })
    }

    const result = await getOrCreateCurrentRound(fetchBtcPriceUsd)
    const { round, resolvedRound } = result
    const priceUp = getPriceUp(round.pool)
    const priceDown = getPriceDown(round.pool)
    return noCacheJson({
      round: roundToJson(round),
      resolvedRound: resolvedRound ? roundToJson(resolvedRound) : undefined,
      priceUp,
      priceDown,
      serverNow: Date.now(),
      ok: true,
    })
  } catch (e) {
    return noCacheJson(
      { error: 'Failed to load round', ok: false },
      500
    )
  }
}

/** POST: comprar shares (body: { side: 'UP'|'DOWN', amountUsd: number }) */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { side, amountUsd, roundId } = body as {
      side?: 'UP' | 'DOWN'
      amountUsd?: number
      roundId?: string
    }

    if (!side || !['UP', 'DOWN'].includes(side)) {
      return noCacheJson(
        { error: 'side must be UP or DOWN', ok: false },
        400
      )
    }
    const amount = typeof amountUsd === 'number' ? amountUsd : parseFloat(String(amountUsd ?? ''))
    if (isNaN(amount) || amount <= 0) {
      return noCacheJson(
        { error: 'amountUsd must be a positive number', ok: false },
        400
      )
    }

    const { executeTrade, getOrCreateCurrentRound, getRound } = await import('@/lib/rounds')
    const round = roundId
      ? getRound(roundId)
      : (await getOrCreateCurrentRound(await import('@/lib/btc-price').then((m) => m.fetchBtcPriceUsd))).round
    if (!round) {
      return noCacheJson({ error: 'Round not found', ok: false }, 404)
    }

    const result = executeTrade(round.id, side, amount)
    if (!result.success) {
      return noCacheJson(
        { error: result.error ?? 'Execution error', ok: false },
        400
      )
    }

    const priceUp = getPriceUp(round.pool)
    const priceDown = getPriceDown(round.pool)
    return noCacheJson({
      success: true,
      roundId: round.id,
      side,
      sharesReceived: result.sharesReceived,
      pricePerShare: result.pricePerShare,
      priceUp,
      priceDown,
      pool: round.pool,
      serverNow: Date.now(),
      ok: true,
    })
  } catch (e) {
    return noCacheJson(
      { error: 'Error processing trade', ok: false },
      500
    )
  }
}
