import { getOrCreateCurrentRound } from '@/lib/rounds'
import { fetchBtcPriceUsd } from '@/lib/btc-price'
import { getPriceUp, getPriceDown } from '@/lib/amm'
import { getOptimisticPool, getRecentTrades, getOpenPrice, heartbeatAndCount, getOptimisticEarlyBets } from '@/lib/pool-store'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

const ROUND_DURATION_MS = 60 * 1000
import { HIRO_API as HIRO_TESTNET, hiroHeaders } from '@/lib/hiro'
const BITPREDIX_ID = process.env.NEXT_PUBLIC_BITPREDIX_CONTRACT_ID

// Virtual seed liquidity for display pricing (must match frontend constant)
const VIRTUAL_SEED = 100 * 1e6 // $100 in micro-units (6 decimals)

// ---------------------------------------------------------------------------
// Hiro on-chain cache — on-chain data changes only on tx confirmation (~30s),
// so caching for 5s is safe and prevents the slow Hiro call from blocking polls.
// ---------------------------------------------------------------------------
let hiroCache: { roundId: number; up: number; down: number; resolved: boolean; priceStart: number; priceEnd: number; ts: number } | null = null
const HIRO_CACHE_TTL_MS = 5000

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

/** Fetch on-chain round data from Hiro (with 5s cache). */
async function getOnChainData(roundId: number): Promise<{ up: number; down: number; resolved: boolean; priceStart: number; priceEnd: number }> {
  // Return cached if fresh
  if (hiroCache && hiroCache.roundId === roundId && Date.now() - hiroCache.ts < HIRO_CACHE_TTL_MS) {
    return hiroCache
  }

  try {
    const [contractAddress, contractName] = parseContractId(BITPREDIX_ID!)
    const { uintCV, tupleCV, cvToHex, deserializeCV } = await import('@stacks/transactions')
    const keyHex = cvToHex(tupleCV({ 'round-id': uintCV(roundId) }))
    const res = await fetch(
      `${HIRO_TESTNET}/v2/map_entry/${contractAddress}/${contractName}/rounds?proof=0&tip=latest`,
      {
        method: 'POST',
        headers: hiroHeaders(),
        body: JSON.stringify(keyHex),
        cache: 'no-store',
        signal: AbortSignal.timeout(4000), // don't let Hiro block us > 4s
      }
    )
    const json = (await res.json()) as { data?: string }
    if (!res.ok || !json.data) {
      return { up: 0, down: 0, resolved: false, priceStart: 0, priceEnd: 0 }
    }
    const cv = deserializeCV(json.data) as unknown as { type?: string; value?: { data: Record<string, { value?: bigint | string }> }; data?: Record<string, { value?: bigint | string }> }
    const tuple = (cv?.type === 'some' && cv?.value) ? cv.value : cv
    const d = tuple?.data ?? cv?.data
    if (!d) {
      return { up: 0, down: 0, resolved: false, priceStart: 0, priceEnd: 0 }
    }
    const u = (k: string) => Number(d[k]?.value ?? 0)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolved = (d['resolved'] as any)?.value === true || String(d['resolved']?.value) === 'true'
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

// Cache para jackpot balance (muda a cada claim, cache 5s)
let jackpotCache: { balance: number; earlyUp: number; earlyDown: number; roundId: number; ts: number } | null = null

async function getJackpotData(roundId: number): Promise<{ balance: number; earlyUp: number; earlyDown: number }> {
  if (jackpotCache && jackpotCache.roundId === roundId && Date.now() - jackpotCache.ts < HIRO_CACHE_TTL_MS) {
    return jackpotCache
  }

  try {
    const [contractAddress, contractName] = parseContractId(BITPREDIX_ID!)
    const { deserializeCV, uintCV, cvToHex } = await import('@stacks/transactions')

    // 1. Fetch jackpot balance
    const balRes = await fetch(
      `${HIRO_TESTNET}/v2/contracts/call-read/${contractAddress}/${contractName}/get-jackpot-balance`,
      {
        method: 'POST',
        headers: { ...hiroHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: contractAddress, arguments: [] }),
        cache: 'no-store',
        signal: AbortSignal.timeout(4000),
      }
    )
    const balJson = await balRes.json() as { okay: boolean; result?: string }
    let balance = 0
    if (balJson.okay && balJson.result) {
      const cv = deserializeCV(balJson.result) as unknown as { value?: bigint }
      balance = Number(cv?.value ?? 0)
    }

    // 2. Fetch round-jackpot
    const rjRes = await fetch(
      `${HIRO_TESTNET}/v2/contracts/call-read/${contractAddress}/${contractName}/get-round-jackpot`,
      {
        method: 'POST',
        headers: { ...hiroHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: contractAddress, arguments: [cvToHex(uintCV(roundId))] }),
        cache: 'no-store',
        signal: AbortSignal.timeout(4000),
      }
    )
    const rjJson = await rjRes.json() as { okay: boolean; result?: string }
    let earlyUp = 0, earlyDown = 0
    if (rjJson.okay && rjJson.result) {
      const cv = deserializeCV(rjJson.result) as unknown as { data?: Record<string, { value?: bigint }> }
      earlyUp = Number(cv?.data?.['early-up']?.value ?? 0)
      earlyDown = Number(cv?.data?.['early-down']?.value ?? 0)
    }

    const result = { balance, earlyUp, earlyDown, roundId, ts: Date.now() }
    jackpotCache = result
    return result
  } catch (err) {
    console.warn('[round] Jackpot data fetch failed:', (err as Error).message)
    if (jackpotCache) return jackpotCache
    return { balance: 0, earlyUp: 0, earlyDown: 0 }
  }
}

/** GET: obter rodada atual e precos. */
export async function GET(request: NextRequest) {
  try {
    const sid = request.nextUrl.searchParams.get('sid') || ''

    if (BITPREDIX_ID && BITPREDIX_ID.includes('.')) {
      const roundId = Math.floor(Date.now() / 1000 / 60)

      // Fetch KV (fast, ~1-5ms) and on-chain (slow, cached) in parallel
      const [optimistic, recentTrades, serverOpenPrice, onChain, activeUsers, jackpotOnChain, jackpotKV] = await Promise.all([
        getOptimisticPool(roundId),
        getRecentTrades(roundId),
        getOpenPrice(roundId),
        getOnChainData(roundId),
        sid ? heartbeatAndCount(sid) : Promise.resolve(0),
        getJackpotData(roundId),
        getOptimisticEarlyBets(roundId),
      ])

      const totalUp = Math.max(onChain.up, optimistic.up)
      const totalDown = Math.max(onChain.down, optimistic.down)

      const startAt = roundId * 60 * 1000
      const round = {
        id: `round-${roundId}`,
        startAt,
        endsAt: (roundId + 1) * 60 * 1000,
        tradingClosesAt: startAt + 55 * 1000,
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
      const effUp = VIRTUAL_SEED + totalUp
      const effDown = VIRTUAL_SEED + totalDown
      const pu = effUp / (effUp + effDown)
      const pd = 1 - pu
      return noCacheJson({
        round: roundToJson(round),
        priceUp: pu,
        priceDown: pd,
        serverNow: Date.now(),
        recentTrades,
        openPrice: serverOpenPrice,
        activeUsers,
        kvConnected: optimistic._kvConnected ?? true,
        jackpot: {
          balance: jackpotOnChain.balance / 1e6,
          earlyUp: Math.max(jackpotOnChain.earlyUp, jackpotKV.earlyUp) / 1e6,
          earlyDown: Math.max(jackpotOnChain.earlyDown, jackpotKV.earlyDown) / 1e6,
        },
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
