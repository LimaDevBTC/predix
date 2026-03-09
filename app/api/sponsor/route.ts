import { NextRequest, NextResponse } from 'next/server'
import {
  deserializeTransaction,
  sponsorTransaction,
  broadcastTransaction,
  PayloadType,
} from '@stacks/transactions'
import { generateWallet, getStxAddress } from '@stacks/wallet-sdk'
import {
  getSponsorNonce,
  setSponsorNonce,
  clearSponsorNonce,
  acquireSponsorLock,
  releaseSponsorLock,
  addOptimisticBet,
} from '@/lib/pool-store'

// Contratos permitidos para sponsorship
const ALLOWED_CONTRACTS = [
  process.env.NEXT_PUBLIC_BITPREDIX_CONTRACT_ID || 'ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK.predixv1',
  process.env.NEXT_PUBLIC_TEST_USDCX_CONTRACT_ID || 'ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK.test-usdcx',
]

// Funcoes permitidas
const ALLOWED_FUNCTIONS = [
  'place-bet',
  'claim-round-side',
  'approve',
  'mint',
]

// Cache da private key + address do sponsor (derivada uma vez)
let sponsorKeyCache: string | null = null
let sponsorAddressCache: string | null = null

async function getSponsorPrivateKey(): Promise<string> {
  if (sponsorKeyCache) return sponsorKeyCache

  const mnemonic = process.env.ORACLE_MNEMONIC
  if (!mnemonic) throw new Error('ORACLE_MNEMONIC not configured')

  const wallet = await generateWallet({ secretKey: mnemonic, password: '' })
  const account = wallet.accounts[0]
  sponsorKeyCache = account.stxPrivateKey
  sponsorAddressCache = getStxAddress({ account, network: 'testnet' })
  return sponsorKeyCache
}

// In-memory lock fallback (for local dev without Redis)
const g = globalThis as unknown as { __sponsorLock?: Promise<void> }
g.__sponsorLock ??= Promise.resolve()

export async function POST(req: NextRequest) {
  // Try Redis lock first; fall back to in-memory promise chain
  const gotRedisLock = await acquireSponsorLock(3000)

  let releaseLock: () => void = () => {}
  if (!gotRedisLock) {
    // In-memory serialization fallback
    const prevLock = g.__sponsorLock!
    g.__sponsorLock = new Promise<void>(resolve => { releaseLock = resolve })
    await prevLock
  }

  try {
    const { txHex } = await req.json()

    if (!txHex || typeof txHex !== 'string') {
      return NextResponse.json({ error: 'Missing or invalid txHex' }, { status: 400 })
    }

    // 1. Deserializa a transacao
    const transaction = deserializeTransaction(txHex)

    // 2. Valida que e um contract-call para contratos permitidos
    const payload = transaction.payload
    if (payload.payloadType !== PayloadType.ContractCall) {
      return NextResponse.json({ error: 'Only contract calls are allowed' }, { status: 400 })
    }

    // PayloadType.ContractCall payloads have contractAddress, contractName, functionName
    const contractPayload = payload as {
      payloadType: number
      contractAddress: { hash160: string; type: number; version: number }
      contractName: { content: string; lengthPrefixBytes: number; maxLengthBytes: number; type: number }
      functionName: { content: string; lengthPrefixBytes: number; maxLengthBytes: number; type: number }
    }

    if (!('contractName' in payload) || !('functionName' in payload)) {
      return NextResponse.json({ error: 'Only contract calls are allowed' }, { status: 400 })
    }

    const contractName = contractPayload.contractName.content
    const functionName = contractPayload.functionName.content

    const allowedNames = ALLOWED_CONTRACTS.map(c => c.split('.')[1])
    if (!allowedNames.includes(contractName)) {
      return NextResponse.json(
        { error: `Contract ${contractName} not allowed for sponsorship` },
        { status: 403 }
      )
    }

    if (!ALLOWED_FUNCTIONS.includes(functionName)) {
      return NextResponse.json(
        { error: `Function ${functionName} not allowed for sponsorship` },
        { status: 403 }
      )
    }

    // 3. Sponsora a transacao (with tracked nonce if available)
    const sponsorPrivateKey = await getSponsorPrivateKey()

    // Detect if origin == sponsor (deployer betting on their own account).
    // In this case, ONE tx consumes TWO nonces from the same account:
    // the origin nonce (user) AND the sponsor nonce.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const originAuth = (transaction.auth as any)?.spendingCondition ?? (transaction.auth as any)?.originCondition
    const originSignerHash = originAuth?.signer as string | undefined

    let isSelfSponsored = false
    if (originSignerHash && sponsorAddressCache) {
      try {
        const { c32addressDecode } = await import('c32check')
        const [, sponsorHash] = c32addressDecode(sponsorAddressCache)
        isSelfSponsored = originSignerHash.toLowerCase() === sponsorHash.toLowerCase()
      } catch { /* fall through — treat as not self-sponsored */ }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sponsorOpts: any = {
      transaction,
      sponsorPrivateKey,
      fee: BigInt(50000), // 0.05 STX
      network: 'testnet',
    }

    // --- Determine initial sponsor nonce ---
    let sponsorNonce: bigint | undefined

    if (isSelfSponsored) {
      const originNonce = BigInt(originAuth?.nonce ?? 0)
      sponsorNonce = originNonce + BigInt(1)
      console.log(`[sponsor] Self-sponsored: origin nonce=${originNonce}, sponsor nonce=${sponsorNonce}`)
    } else {
      const tracked = await getSponsorNonce()
      if (tracked) {
        sponsorNonce = tracked.nonce
        console.log(`[sponsor] Using KV tracked nonce: ${sponsorNonce}`)
      }
      // If no tracked nonce, sponsorTransaction will auto-fetch; we'll correct via retry if needed
    }

    // --- Sponsor + Broadcast with retry on nonce errors ---
    const MAX_RETRIES = 3
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let lastResult: any = null

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const opts: any = { ...sponsorOpts }
      if (sponsorNonce !== undefined) {
        opts.sponsorNonce = sponsorNonce
      }

      const sponsoredTx = await sponsorTransaction(opts)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const auth = sponsoredTx.auth as any
      const usedOriginNonce = auth.spendingCondition?.nonce
      const usedSponsorNonce = auth.sponsorSpendingCondition?.nonce
      console.log(`[sponsor] Attempt ${attempt}: origin=${usedOriginNonce}, sponsor=${usedSponsorNonce}, self=${isSelfSponsored}`)

      const result = await broadcastTransaction({ transaction: sponsoredTx, network: 'testnet' })

      // Check for broadcast errors
      if ('error' in result) {
        const r = result as Record<string, unknown>
        const reason = r.reason as string
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const reasonData = r.reason_data as any

        // Retry on nonce errors — use the expected nonce from the error
        if ((reason === 'BadNonce' || reason === 'ConflictingNonceInMempool') && attempt < MAX_RETRIES) {
          if (reasonData?.expected != null) {
            sponsorNonce = BigInt(reasonData.expected)
            console.log(`[sponsor] Nonce error (${reason}), retrying with nonce=${sponsorNonce}`)
            continue
          }
          // ConflictingNonceInMempool doesn't always have expected — try incrementing
          if (sponsorNonce !== undefined) {
            sponsorNonce += BigInt(1)
            console.log(`[sponsor] Nonce conflict, retrying with nonce=${sponsorNonce}`)
            continue
          }
        }

        // Non-retryable error
        await clearSponsorNonce()
        console.error('[sponsor] Broadcast rejected:', JSON.stringify(result))
        return NextResponse.json(
          { error: r.error, reason, reason_data: reasonData },
          { status: 400 }
        )
      }

      // Success!
      if ('txid' in result) {
        console.log('[sponsor] Broadcast OK:', result.txid)

        // Track next sponsor nonce
        try {
          const finalSponsorNonce = BigInt(usedSponsorNonce ?? 0)
          await setSponsorNonce(finalSponsorNonce + BigInt(1))
        } catch {
          await clearSponsorNonce()
        }

        // Optimistic KV write for place-bet
        if (functionName === 'place-bet') {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const funcArgs = (payload as any).functionArgs
            if (Array.isArray(funcArgs) && funcArgs.length >= 3) {
              const roundId = Number(funcArgs[0]?.value ?? 0)
              const side = String(funcArgs[1]?.value ?? '').toUpperCase()
              const amountMicro = Number(funcArgs[2]?.value ?? 0)
              if (roundId > 0 && (side === 'UP' || side === 'DOWN') && amountMicro > 0) {
                await addOptimisticBet(roundId, side as 'UP' | 'DOWN', amountMicro, result.txid)
                console.log(`[sponsor] KV optimistic: round=${roundId} ${side} $${(amountMicro / 1e6).toFixed(2)} txid=${result.txid}`)
              }
            }
          } catch (kvErr) {
            console.warn('[sponsor] KV optimistic write failed (non-fatal):', kvErr)
          }
        }

        return NextResponse.json({ txid: result.txid })
      }

      lastResult = result
      break
    }

    // Exhausted retries or unexpected result
    await clearSponsorNonce()
    console.error('[sponsor] Unexpected broadcast result:', lastResult)
    return NextResponse.json({ error: 'Unexpected broadcast result' }, { status: 500 })
  } catch (err: unknown) {
    await clearSponsorNonce()
    console.error('[sponsor] Error:', err)
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  } finally {
    if (gotRedisLock) {
      await releaseSponsorLock()
    } else {
      releaseLock()
    }
  }
}
