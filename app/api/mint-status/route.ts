import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const CONTRACT_ID = process.env.NEXT_PUBLIC_TEST_USDCX_CONTRACT_ID || 'ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK.test-usdcx'
import { HIRO_API as HIRO_TESTNET, hiroHeaders } from '@/lib/hiro'

// Cache server-side para evitar 429 da Hiro API
// Key: address, Value: { data, timestamp }
const cache = new Map<string, { data: Record<string, unknown>; timestamp: number }>()
const CACHE_TTL_MS = 15_000 // 15s — polling do client é 30s, cache garante que não repete

function parseContractId(id: string): [string, string] {
  const i = id.lastIndexOf('.')
  if (i < 0) throw new Error(`Invalid contract id: ${id}`)
  return [id.slice(0, i), id.slice(i + 1)]
}

async function callContract(contractId: string, functionName: string, args: string[], sender: string) {
  const [contractAddress, contractName] = parseContractId(contractId)

  const response = await fetch(`${HIRO_TESTNET}/v2/contracts/call-read/${contractAddress}/${contractName}/${functionName}`, {
    method: 'POST',
    headers: hiroHeaders(),
    body: JSON.stringify({ sender, arguments: args })
  })

  if (!response.ok) {
    throw new Error(`Hiro API error: ${response.status}`)
  }

  return response.json()
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const address = searchParams.get('address')

  if (!address || typeof address !== 'string' || address.length === 0) {
    return NextResponse.json(
      { error: 'Missing or invalid address', ok: false },
      { status: 400 }
    )
  }

  // nocache=1 força refresh (usado após mint para pegar dados frescos)
  const nocache = searchParams.get('nocache') === '1'
  if (nocache) {
    cache.delete(address)
  } else {
    const cached = cache.get(address)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return NextResponse.json(cached.data)
    }
  }

  try {
    const { standardPrincipalCV, cvToHex, hexToCV, cvToJSON } = await import('@stacks/transactions')
    const argHex = cvToHex(standardPrincipalCV(address))

    console.log(`[mint-status] Checking for address: ${address}`)

    // Busca minted e balance em paralelo
    const [mintedResult, balanceResult] = await Promise.allSettled([
      callContract(CONTRACT_ID, 'get-minted', [argHex], address),
      callContract(CONTRACT_ID, 'get-balance', [argHex], address)
    ])

    // Helper para extrair valor uint de cvToJSON (que pode retornar formatos diferentes)
    function extractUintValue(cvJson: Record<string, unknown>): string {
      if (!cvJson) return '0'
      // Caso 1: { type: 'uint', value: '123' }
      if (cvJson.type === 'uint' && cvJson.value != null) {
        return String(cvJson.value)
      }
      // Caso 2: { type: '(response ...)', success: true, value: { type: 'uint', value: '123' } }
      if ((cvJson.success === true || cvJson.type === 'ok') && cvJson.value != null) {
        const inner = cvJson.value as Record<string, unknown>
        if (typeof inner === 'object' && inner?.type === 'uint') {
          return String(inner.value ?? '0')
        }
        return String(inner?.value ?? inner ?? '0')
      }
      // Caso 3: valor direto
      if (cvJson.value != null) {
        const v = cvJson.value
        if (typeof v === 'object' && (v as Record<string, unknown>)?.value != null) {
          return String((v as Record<string, unknown>).value)
        }
        return String(v)
      }
      return '0'
    }

    // Parse minted
    // IMPORTANTE: canMint default = false (safe default)
    // Só permite mint quando confirmamos explicitamente que minted === 0
    let minted = BigInt(0)
    let canMint = false

    if (mintedResult.status === 'fulfilled') {
      const json = mintedResult.value as { okay?: boolean; result?: string; cause?: string }
      console.log('[mint-status] get-minted raw response:', JSON.stringify(json))

      if (json.okay && typeof json.result === 'string') {
        const cv = hexToCV(json.result)
        const cvJson = cvToJSON(cv) as Record<string, unknown>
        console.log('[mint-status] get-minted parsed:', JSON.stringify(cvJson))

        const mintedStr = extractUintValue(cvJson)
        minted = mintedStr === '0' ? BigInt(0) : BigInt(mintedStr)
        canMint = minted === BigInt(0)

        console.log(`[mint-status] minted=${minted}, canMint=${canMint}`)
      } else {
        console.error('[mint-status] get-minted response not okay or missing result:', json.okay, json.cause)
      }
    } else {
      console.error('[mint-status] get-minted failed:', mintedResult.reason)
    }

    // Parse balance
    let balance = '0'
    let balanceConfirmed = false
    if (balanceResult.status === 'fulfilled') {
      const jBalance = balanceResult.value as { okay?: boolean; result?: string; cause?: string }
      console.log('[mint-status] get-balance raw response:', JSON.stringify(jBalance))

      if (jBalance.okay && typeof jBalance.result === 'string') {
        try {
          const cvBal = hexToCV(jBalance.result)
          const cvBalJson = cvToJSON(cvBal) as Record<string, unknown>
          console.log('[mint-status] get-balance parsed:', JSON.stringify(cvBalJson))

          balance = extractUintValue(cvBalJson)
          balanceConfirmed = true
          console.log('[mint-status] extracted balance:', balance)
        } catch (e) {
          console.error('[mint-status] balance parse error:', e)
          balance = '0'
        }
      } else {
        console.log('[mint-status] get-balance not okay or no result:', jBalance.okay, jBalance.cause)
      }
    } else {
      console.error('[mint-status] get-balance failed:', balanceResult.reason)
    }

    console.log(`[mint-status] Final result: minted=${minted}, canMint=${canMint}, balance=${balance}, balanceConfirmed=${balanceConfirmed}`)

    const responseData = {
      minted: String(minted),
      canMint,
      balance,
      balanceConfirmed,
      ok: true,
    }

    // Salva no cache apenas se ao menos uma chamada teve sucesso
    if (mintedResult.status === 'fulfilled' || balanceResult.status === 'fulfilled') {
      cache.set(address, { data: responseData, timestamp: Date.now() })
    }

    return NextResponse.json(responseData)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'get-minted failed'
    console.error('[mint-status] Error:', msg)
    return NextResponse.json(
      { error: msg, ok: false },
      { status: 502 }
    )
  }
}
