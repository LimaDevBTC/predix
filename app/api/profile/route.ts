import { NextResponse } from 'next/server'
import { getWalletProfile } from '@/lib/round-indexer'
import { HIRO_API, hiroHeaders } from '@/lib/hiro'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 60

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const address = searchParams.get('address')

  if (!address) {
    return NextResponse.json({ error: 'address required', ok: false }, { status: 400 })
  }

  const page = Math.max(1, parseInt(searchParams.get('page') || '1'))
  const pageSize = Math.min(50, Math.max(1, parseInt(searchParams.get('pageSize') || '20')))

  try {
    const profile = await getWalletProfile(address, page, pageSize)

    let balance = 0
    try {
      const CONTRACT_ADDRESS = 'ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK'
      const { cvToHex, standardPrincipalCV, hexToCV, cvToJSON } = await import('@stacks/transactions')
      const res = await fetch(
        `${HIRO_API}/v2/contracts/call-read/${CONTRACT_ADDRESS}/test-usdcx/get-balance`,
        {
          method: 'POST',
          headers: hiroHeaders(),
          body: JSON.stringify({
            sender: CONTRACT_ADDRESS,
            arguments: [cvToHex(standardPrincipalCV(address))],
          }),
        }
      )
      if (res.ok) {
        const data = await res.json()
        if (data.result) {
          const cv = hexToCV(data.result)
          const json = cvToJSON(cv)
          balance = Number(json.value?.value ?? 0) / 1e6
        }
      }
    } catch { /* balance stays 0 */ }

    return NextResponse.json({ ok: true, profile, balance })
  } catch (e) {
    console.error('[profile] Error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Failed to load profile', ok: false }, { status: 500 })
  }
}
