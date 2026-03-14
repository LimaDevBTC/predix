import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const revalidate = 0

import { HIRO_API as HIRO_TESTNET, hiroHeaders } from '@/lib/hiro'
const TOKEN_CONTRACT = process.env.NEXT_PUBLIC_TEST_USDCX_CONTRACT_ID || 'ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK.test-usdcx'
const BITPREDIX_CONTRACT = process.env.NEXT_PUBLIC_BITPREDIX_CONTRACT_ID || 'ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK.predixv2'
const FETCH_TIMEOUT = 15000

/**
 * Verifica o allowance de um usuário para o contrato BitPredix
 * Lê diretamente o map 'allowances' do contrato test-usdcx
 *
 * GET /api/allowance-status?address=<stx_address>
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const address = searchParams.get('address')

  console.log('[allowance-status] Checking allowance for:', address)

  if (!address) {
    return NextResponse.json(
      { error: 'Missing address parameter', ok: false },
      { status: 400 }
    )
  }

  const [tokenAddr, tokenName] = TOKEN_CONTRACT.split('.')
  if (!tokenAddr || !tokenName) {
    return NextResponse.json(
      { error: 'Invalid token contract ID', ok: false },
      { status: 500 }
    )
  }

  try {
    const { tupleCV, standardPrincipalCV, contractPrincipalCV, cvToHex, hexToCV, cvToJSON } = await import('@stacks/transactions')

    // Formato do key: tuple { owner: principal, spender: principal }
    const [spenderAddr, spenderName] = BITPREDIX_CONTRACT.split('.')
    const keyCV = tupleCV({
      owner: standardPrincipalCV(address),
      spender: contractPrincipalCV(spenderAddr, spenderName)
    })
    const keyHex = cvToHex(keyCV)

    console.log('[allowance-status] Map key:', keyHex)
    console.log('[allowance-status] URL:', `${HIRO_TESTNET}/v2/map_entry/${tokenAddr}/${tokenName}/allowances`)

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT)

    const mapResponse = await fetch(
      `${HIRO_TESTNET}/v2/map_entry/${tokenAddr}/${tokenName}/allowances`,
      {
        method: 'POST',
        headers: hiroHeaders(),
        body: `"${keyHex}"`,
        signal: controller.signal
      }
    )

    clearTimeout(timeoutId)

    console.log('[allowance-status] Response status:', mapResponse.status)

    if (!mapResponse.ok) {
      const errorText = await mapResponse.text()
      console.error('[allowance-status] Map read failed:', mapResponse.status, errorText)
      return NextResponse.json(
        { error: `Hiro API error: ${mapResponse.status}`, ok: false },
        { status: 502 }
      )
    }

    const mapData = await mapResponse.json()
    console.log('[allowance-status] map_entry response:', JSON.stringify(mapData))

    // Helper para extrair valor uint de cvToJSON
    function extractUintValue(cvJson: Record<string, unknown>): string {
      if (!cvJson) return '0'
      // Caso 1: { type: 'uint', value: '123' }
      if (cvJson.type === 'uint' && cvJson.value != null) {
        return String(cvJson.value)
      }
      // Caso 2: { type: 'some', value: { type: 'uint', value: '123' } }
      if (cvJson.type === 'some' && cvJson.value != null) {
        const inner = cvJson.value as Record<string, unknown>
        if (typeof inner === 'object' && inner?.type === 'uint') {
          return String(inner.value ?? '0')
        }
        return String(inner?.value ?? inner ?? '0')
      }
      // Caso 3: { type: '(response ...)', success: true, value: { type: 'uint', value: '...' } }
      if ((cvJson.success === true || cvJson.type === 'ok') && cvJson.value != null) {
        const inner = cvJson.value as Record<string, unknown>
        if (typeof inner === 'object' && inner?.type === 'uint') {
          return String(inner.value ?? '0')
        }
        return String(inner?.value ?? inner ?? '0')
      }
      // Caso 4: valor direto
      if (cvJson.value != null) {
        const v = cvJson.value
        if (typeof v === 'object' && (v as Record<string, unknown>)?.value != null) {
          return String((v as Record<string, unknown>).value)
        }
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') {
          return String(v)
        }
      }
      return '0'
    }

    // Se o map entry existe, parsea o valor
    if (mapData.data) {
      const cv = hexToCV(mapData.data)
      const json = cvToJSON(cv) as Record<string, unknown>
      console.log('[allowance-status] Parsed map value:', JSON.stringify(json))

      const allowance = extractUintValue(json)
      const allowanceNum = BigInt(allowance)
      console.log('[allowance-status] Final allowance:', allowance, 'hasAllowance:', allowanceNum > BigInt(0))

      return NextResponse.json({
        allowance,
        hasAllowance: allowanceNum > BigInt(0),
        ok: true
      })
    }

    // Map entry não existe = allowance 0
    console.log('[allowance-status] No map entry found, allowance = 0')
    return NextResponse.json({
      allowance: '0',
      hasAllowance: false,
      ok: true
    })

  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      console.error('[allowance-status] Request timeout')
      return NextResponse.json(
        { error: 'Request timeout', ok: false },
        { status: 504 }
      )
    }

    console.error('[allowance-status] Error:', e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to check allowance', ok: false },
      { status: 500 }
    )
  }
}
