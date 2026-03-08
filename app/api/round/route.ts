import { getOrCreateCurrentRound } from '@/lib/rounds'
import { fetchBtcPriceUsd } from '@/lib/btc-price'
import { getPriceUp, getPriceDown } from '@/lib/amm'
import { getOptimisticPool, getRecentTrades, getOpenPrice } from '@/lib/pool-store'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const ROUND_DURATION_MS = 60 * 1000
const HIRO_TESTNET = 'https://api.testnet.hiro.so'
const BITPREDIX_ID = process.env.NEXT_PUBLIC_BITPREDIX_CONTRACT_ID

// Virtual seed liquidity for display pricing (must match frontend constant)
const VIRTUAL_SEED = 500 * 1e6 // $500 in micro-units (6 decimals)

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
  return NextResponse.json({
    round: null,
    priceUp: 0.5,
    priceDown: 0.5,
    serverNow: Date.now(),
    onChainNoRound: true,
    ok: true,
  })
}

/** GET: obter rodada atual e preços. Em modo on-chain (BITPREDIX_ID) lê do contrato; senão usa memória. */
export async function GET() {
  try {
    if (BITPREDIX_ID && BITPREDIX_ID.includes('.')) {
      try {
        const [contractAddress, contractName] = parseContractId(BITPREDIX_ID)
        const roundId = Math.floor(Date.now() / 1000 / 60)
        const { uintCV, tupleCV, cvToHex, deserializeCV } = await import('@stacks/transactions')
        const keyHex = cvToHex(tupleCV({ 'round-id': uintCV(roundId) }))
        const res = await fetch(
          `${HIRO_TESTNET}/v2/map_entry/${contractAddress}/${contractName}/rounds?proof=0&tip=latest`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(keyHex),
            cache: 'no-store',
          }
        )
        const json = (await res.json()) as { data?: string }
        if (!res.ok || !json.data) {
          return emptyRoundResponse()
        }
        const cv = deserializeCV(json.data) as unknown as { type?: string; value?: { data: Record<string, { value?: bigint | string }> }; data?: Record<string, { value?: bigint | string }> }
        // map_entry devolve (some tuple) quando a chave existe; (none) quando não existe.
        const tuple = (cv?.type === 'some' && cv?.value) ? cv.value : cv
        const d = tuple?.data ?? cv?.data
        if (!d) {
          return emptyRoundResponse()
        }
        const u = (k: string) => Number(d[k]?.value ?? 0)
        // Campos do contrato v5: total-up, total-down, price-start, price-end, resolved
        // Tempos são derivados do roundId (não armazenados no mapa)
        const startAt = roundId * 60 * 1000
        const onChainUp = u('total-up')
        const onChainDown = u('total-down')
        // Merge with optimistic cache — max() so unconfirmed bets are visible to all clients
        const [optimistic, recentTrades, serverOpenPrice] = await Promise.all([
          getOptimisticPool(roundId),
          getRecentTrades(roundId),
          getOpenPrice(roundId),
        ])
        const totalUp = Math.max(onChainUp, optimistic.up)
        const totalDown = Math.max(onChainDown, optimistic.down)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const resolved = (d['resolved'] as any)?.value === true || String(d['resolved']?.value) === 'true'
        const round = {
          id: `round-${roundId}`,
          startAt,
          endsAt: (roundId + 1) * 60 * 1000,
          tradingClosesAt: startAt + 55 * 1000,
          priceAtStart: u('price-start') / 100,
          priceAtEnd: u('price-end') > 0 ? u('price-end') / 100 : undefined,
          outcome: resolved ? (u('price-end') > u('price-start') ? 'UP' : 'DOWN') : undefined,
          status: resolved ? 'resolved' : 'open',
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
        return NextResponse.json({
          round: roundToJson(round),
          priceUp: pu,
          priceDown: pd,
          serverNow: Date.now(),
          recentTrades,
          openPrice: serverOpenPrice,
          ok: true,
        })
      } catch {
        return emptyRoundResponse()
      }
    }

    const result = await getOrCreateCurrentRound(fetchBtcPriceUsd)
    const { round, resolvedRound } = result
    const priceUp = getPriceUp(round.pool)
    const priceDown = getPriceDown(round.pool)
    return NextResponse.json({
      round: roundToJson(round),
      resolvedRound: resolvedRound ? roundToJson(resolvedRound) : undefined,
      priceUp,
      priceDown,
      serverNow: Date.now(),
      ok: true,
    })
  } catch (e) {
    return NextResponse.json(
      { error: 'Failed to load round', ok: false },
      { status: 500 }
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
      return NextResponse.json(
        { error: 'side must be UP or DOWN', ok: false },
        { status: 400 }
      )
    }
    const amount = typeof amountUsd === 'number' ? amountUsd : parseFloat(String(amountUsd ?? ''))
    if (isNaN(amount) || amount <= 0) {
      return NextResponse.json(
        { error: 'amountUsd must be a positive number', ok: false },
        { status: 400 }
      )
    }

    const { executeTrade, getOrCreateCurrentRound, getRound } = await import('@/lib/rounds')
    const round = roundId
      ? getRound(roundId)
      : (await getOrCreateCurrentRound(await import('@/lib/btc-price').then((m) => m.fetchBtcPriceUsd))).round
    if (!round) {
      return NextResponse.json({ error: 'Round not found', ok: false }, { status: 404 })
    }

    const result = executeTrade(round.id, side, amount)
    if (!result.success) {
      return NextResponse.json(
        { error: result.error ?? 'Execution error', ok: false },
        { status: 400 }
      )
    }

    const priceUp = getPriceUp(round.pool)
    const priceDown = getPriceDown(round.pool)
    return NextResponse.json({
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
    return NextResponse.json(
      { error: 'Error processing trade', ok: false },
      { status: 500 }
    )
  }
}
