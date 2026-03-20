import { NextRequest, NextResponse } from 'next/server'
import { BITPREDIX_CONTRACT, TOKEN_CONTRACT, splitContractId } from '@/lib/config'
import { HIRO_API, hiroHeaders, disableApiKey } from '@/lib/hiro'
import { withAgentAuth } from '@/lib/agent-auth'

export const dynamic = 'force-dynamic'

async function callReadOnly(functionName: string, args: string[]): Promise<unknown> {
  const [addr, name] = splitContractId(BITPREDIX_CONTRACT)
  let res = await fetch(
    `${HIRO_API}/v2/contracts/call-read/${addr}/${name}/${functionName}`,
    {
      method: 'POST',
      headers: { ...hiroHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: addr, arguments: args }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    }
  )
  if (res.status === 429) {
    disableApiKey()
    res = await fetch(
      `${HIRO_API}/v2/contracts/call-read/${addr}/${name}/${functionName}`,
      {
        method: 'POST',
        headers: { ...hiroHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: addr, arguments: args }),
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
      }
    )
  }
  const json = await res.json()
  if (!json.okay || !json.result) return null

  const { hexToCV, cvToJSON } = await import('@stacks/transactions')
  return cvToJSON(hexToCV(json.result))
}

async function getBalance(address: string): Promise<number> {
  try {
    const [tokenAddr, tokenName] = splitContractId(TOKEN_CONTRACT)
    const { cvToHex, standardPrincipalCV } = await import('@stacks/transactions')
    const balanceUrl = `${HIRO_API}/v2/contracts/call-read/${tokenAddr}/${tokenName}/get-balance`
    const balanceBody = JSON.stringify({ sender: tokenAddr, arguments: [cvToHex(standardPrincipalCV(address))] })
    let res = await fetch(balanceUrl, {
      method: 'POST',
      headers: { ...hiroHeaders(), 'Content-Type': 'application/json' },
      body: balanceBody,
      cache: 'no-store',
      signal: AbortSignal.timeout(6000),
    })
    if (res.status === 429) {
      disableApiKey()
      res = await fetch(balanceUrl, {
        method: 'POST',
        headers: { ...hiroHeaders(), 'Content-Type': 'application/json' },
        body: balanceBody,
        cache: 'no-store',
        signal: AbortSignal.timeout(6000),
      })
    }
    const json = await res.json()
    if (!json.okay || !json.result) return 0
    const { hexToCV, cvToJSON } = await import('@stacks/transactions')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cv = cvToJSON(hexToCV(json.result)) as any
    return Number(cv?.value?.value ?? 0) / 1e6
  } catch {
    return 0
  }
}

export const GET = (req: NextRequest) =>
  withAgentAuth(req, async () => {
    const address = req.nextUrl.searchParams.get('address')
  if (!address) {
    return NextResponse.json({ ok: false, error: 'address query param required' }, { status: 400 })
  }

  try {
    const { cvToHex, standardPrincipalCV, uintCV, stringAsciiCV, tupleCV } = await import('@stacks/transactions')

    // Fetch pending rounds and balance in parallel
    const [pendingResult, balance] = await Promise.all([
      callReadOnly('get-user-pending-rounds', [cvToHex(standardPrincipalCV(address))]),
      getBalance(address),
    ])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pendingRoundIds: number[] = ((pendingResult as any)?.value?.value?.map((v: any) => Number(v.value)) ?? [])

    // Current round
    const currentRoundId = Math.floor(Date.now() / 1000 / 60)

    // For each pending round, fetch bets + round data
    const pendingRounds = await Promise.all(
      pendingRoundIds.slice(0, 20).map(async (roundId) => {
        try {
          // Fetch round data + UP bet + DOWN bet in parallel
          const roundKeyHex = cvToHex(tupleCV({ 'round-id': uintCV(roundId) }))
          const upKeyHex = cvToHex(tupleCV({ 'round-id': uintCV(roundId), user: standardPrincipalCV(address), side: stringAsciiCV('UP') }))
          const downKeyHex = cvToHex(tupleCV({ 'round-id': uintCV(roundId), user: standardPrincipalCV(address), side: stringAsciiCV('DOWN') }))

          const [addr, name] = splitContractId(BITPREDIX_CONTRACT)
          const fetchMap = async (mapName: string, keyHex: string) => {
            let res = await fetch(
              `${HIRO_API}/v2/map_entry/${addr}/${name}/${mapName}?proof=0&tip=latest`,
              { method: 'POST', headers: hiroHeaders(), body: JSON.stringify(keyHex), cache: 'no-store', signal: AbortSignal.timeout(6000) }
            )
            if (res.status === 429) {
              disableApiKey()
              res = await fetch(
                `${HIRO_API}/v2/map_entry/${addr}/${name}/${mapName}?proof=0&tip=latest`,
                { method: 'POST', headers: hiroHeaders(), body: JSON.stringify(keyHex), cache: 'no-store', signal: AbortSignal.timeout(6000) }
              )
            }
            const json = await res.json()
            if (!json.data) return null
            const { deserializeCV } = await import('@stacks/transactions')
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const cv = deserializeCV(json.data) as any
            if (cv?.type === 'none') return null
            const tuple = (cv?.type === 'some' && cv?.value) ? cv.value : cv
            // v7 @stacks/transactions: tuple fields are under .value, not .data
            return tuple?.value ?? tuple?.data ?? null
          }

          const [roundData, upBet, downBet] = await Promise.all([
            fetchMap('rounds', roundKeyHex),
            fetchMap('bets', upKeyHex),
            fetchMap('bets', downKeyHex),
          ])

          const resolvedField = roundData?.['resolved']
          const resolved = resolvedField?.type === 'true' || resolvedField?.value === true || String(resolvedField?.value) === 'true'
          const totalUp = Number(roundData?.['total-up']?.value ?? 0)
          const totalDown = Number(roundData?.['total-down']?.value ?? 0)
          const priceStart = Number(roundData?.['price-start']?.value ?? 0)
          const priceEnd = Number(roundData?.['price-end']?.value ?? 0)
          const outcome = resolved ? (priceEnd > priceStart ? 'UP' : priceEnd < priceStart ? 'DOWN' : 'TIE') : null

          const parseBet = (bet: Record<string, { value?: unknown }> | null) => {
            if (!bet) return null
            const amount = Number(bet['amount']?.value ?? 0)
            if (amount === 0) return null
            return { amount: amount / 1e6 }
          }

          const up = parseBet(upBet)
          const down = parseBet(downBet)

          // Estimate payout for winning side
          let estimatedPayout: number | null = null
          if (resolved && outcome) {
            const totalPool = totalUp + totalDown
            const feeMul = 1 - 300 / 10000
            if (outcome === 'UP' && up) {
              estimatedPayout = (up.amount * 1e6 / (totalUp || 1)) * totalPool / 1e6 * feeMul
            } else if (outcome === 'DOWN' && down) {
              estimatedPayout = (down.amount * 1e6 / (totalDown || 1)) * totalPool / 1e6 * feeMul
            }
          }

          const won = resolved && (
            (outcome === 'UP' && !!up) ||
            (outcome === 'DOWN' && !!down) ||
            (outcome === 'TIE' && (!!up || !!down))
          )

          return {
            roundId,
            up,
            down,
            resolved,
            outcome,
            estimatedPayout: estimatedPayout ? Math.round(estimatedPayout * 100) / 100 : null,
            won: !!won,
          }
        } catch {
          return { roundId, up: null, down: null, resolved: false, outcome: null, estimatedPayout: null, won: false }
        }
      })
    )

    // Active round bets (if user has a bet in current round)
    let activeRound = null
    try {
      const { deserializeCV } = await import('@stacks/transactions')
      const [addr, name] = splitContractId(BITPREDIX_CONTRACT)
      const fetchBet = async (side: string) => {
        const keyHex = cvToHex(tupleCV({ 'round-id': uintCV(currentRoundId), user: standardPrincipalCV(address), side: stringAsciiCV(side) }))
        const res = await fetch(
          `${HIRO_API}/v2/map_entry/${addr}/${name}/bets?proof=0&tip=latest`,
          { method: 'POST', headers: hiroHeaders(), body: JSON.stringify(keyHex), cache: 'no-store', signal: AbortSignal.timeout(4000) }
        )
        const json = await res.json()
        if (!json.data) return null
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cv = deserializeCV(json.data) as any
        if (cv?.type === 'none') return null
        const tuple = (cv?.type === 'some' && cv?.value) ? cv.value : cv
        // v7 @stacks/transactions: tuple fields are under .value, not .data
        const d = tuple?.value ?? tuple?.data
        const amount = Number(d?.['amount']?.value ?? 0)
        return amount > 0 ? { amount: amount / 1e6 } : null
      }
      const [upBet, downBet] = await Promise.all([fetchBet('UP'), fetchBet('DOWN')])
      if (upBet || downBet) {
        activeRound = { roundId: currentRoundId, up: upBet, down: downBet }
      }
    } catch { /* ignore */ }

    return NextResponse.json({
      ok: true,
      address,
      balanceUsd: Math.round(balance * 100) / 100,
      pendingRounds: pendingRounds.filter(r => r.up || r.down),
      activeRound,
    })
    } catch (err) {
      console.error('[agent/positions] Error:', err)
      return NextResponse.json({ ok: false, error: 'Failed to fetch positions' }, { status: 500 })
    }
  }, { requireAuth: true })
