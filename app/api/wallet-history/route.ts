import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const revalidate = 0

import { HIRO_API, hiroHeaders } from '@/lib/hiro'
const DEPLOYER = 'ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK'
const FETCH_TIMEOUT = 15000

/**
 * GET /api/wallet-history?address=ST1...&limit=50&offset=0
 * Returns all contract-call transactions from this wallet to our protocol contracts.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const address = searchParams.get('address')
  const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 50)
  const offset = parseInt(searchParams.get('offset') || '0')

  if (!address) {
    return NextResponse.json({ error: 'Missing address parameter', ok: false }, { status: 400 })
  }

  const url = `${HIRO_API}/extended/v1/address/${address}/transactions?limit=${limit}&offset=${offset}`

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT)

    const response = await fetch(url, {
      headers: hiroHeaders(),
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      return NextResponse.json(
        { error: `Hiro API error: ${response.status}`, ok: false },
        { status: 502 }
      )
    }

    const data = await response.json()

    // Filter for contract calls to our deployer's contracts
    const protocolTxs = (data.results || []).filter(
      (tx: Record<string, unknown>) =>
        tx.tx_type === 'contract_call' &&
        typeof tx.contract_call === 'object' &&
        tx.contract_call !== null &&
        (tx.contract_call as Record<string, string>).contract_id?.startsWith(DEPLOYER + '.')
    )

    return NextResponse.json({
      ok: true,
      total: data.total,
      limit: data.limit,
      offset: data.offset,
      results: protocolTxs,
    })
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      return NextResponse.json({ error: 'Request timeout', ok: false }, { status: 504 })
    }
    console.error('[wallet-history] Network error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Network error', ok: false }, { status: 503 })
  }
}
