import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const revalidate = 0

import { HIRO_API, hiroHeaders } from '@/lib/hiro'
const FETCH_TIMEOUT = 10000 // 10 seconds

/**
 * Proxy for Stacks read-only contract calls
 * Avoids CORS issues by fetching server-side
 *
 * POST body: { contractId, functionName, args, sender }
 */
export async function POST(req: Request) {
  let body: { contractId?: string; functionName?: string; args?: string[]; sender?: string }

  try {
    body = await req.json()
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body', ok: false },
      { status: 400 }
    )
  }

  const { contractId, functionName, args, sender } = body

  if (!contractId || !functionName) {
    return NextResponse.json(
      { error: 'Missing contractId or functionName', ok: false },
      { status: 400 }
    )
  }

  const [contractAddr, contractName] = contractId.split('.')
  if (!contractAddr || !contractName) {
    return NextResponse.json(
      { error: 'Invalid contractId format', ok: false },
      { status: 400 }
    )
  }

  const url = `${HIRO_API}/v2/contracts/call-read/${contractAddr}/${contractName}/${functionName}`

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT)

    const response = await fetch(url, {
      method: 'POST',
      headers: hiroHeaders(),
      body: JSON.stringify({
        sender: sender || contractAddr,
        arguments: args || []
      }),
      signal: controller.signal
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      console.error(`[stacks-read] Hiro API error: ${response.status}`)
      return NextResponse.json(
        { error: `Hiro API error: ${response.status}`, ok: false },
        { status: 502 }
      )
    }

    const data = await response.json()
    return NextResponse.json({ ...data, ok: true })
  } catch (e) {
    // Check if it's a timeout/abort error
    if (e instanceof Error && e.name === 'AbortError') {
      console.error('[stacks-read] Request timeout')
      return NextResponse.json(
        { error: 'Request timeout - Hiro API unavailable', ok: false },
        { status: 504 }
      )
    }

    // Network error (DNS, connection refused, etc)
    console.error('[stacks-read] Network error:', e instanceof Error ? e.message : e)
    return NextResponse.json(
      { error: 'Network error - unable to reach Hiro API', ok: false },
      { status: 503 }
    )
  }
}
