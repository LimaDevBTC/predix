import { NextRequest, NextResponse } from 'next/server'
import {
  deserializeTransaction,
  sponsorTransaction,
  PayloadType,
} from '@stacks/transactions'
import { generateWallet, getStxAddress } from '@stacks/wallet-sdk'
import { NETWORK_NAME, BITPREDIX_CONTRACT, GATEWAY_CONTRACT, TOKEN_CONTRACT } from '@/lib/config'

// Force Node.js runtime (not Edge) — Buffer + full Node APIs available
export const runtime = 'nodejs'

const HIRO_API = NETWORK_NAME === 'mainnet'
  ? 'https://api.mainnet.hiro.so'
  : 'https://api.testnet.hiro.so'
import {
  getSponsorNonce,
  setSponsorNonce,
  clearSponsorNonce,
  acquireSponsorLock,
  releaseSponsorLock,
  addOptimisticBet,
  trackRoundWithBets,
  trackBettorSide,
  addOptimisticEarlyBet,
  pushEarlyBet,
} from '@/lib/pool-store'
import { recordEarlyBet, isEarlyBet } from '@/lib/jackpot'
import { alert } from '@/lib/alerting'
import { dispatchWebhookEvent } from '@/lib/agent-webhooks'

// Contracts allowed for sponsorship (fail-fast — no fallbacks)
const ALLOWED_CONTRACTS = [BITPREDIX_CONTRACT, GATEWAY_CONTRACT, TOKEN_CONTRACT]

// Functions allowed — NO claim functions (settlement is sponsor-only via cron)
const ALLOWED_FUNCTIONS = [
  'place-bet',
  'resolve-and-distribute',
  'approve',
  'mint',
]

// Fee from env (default 50000 = 0.05 STX)
const SPONSOR_FEE = BigInt(process.env.SPONSOR_TX_FEE || '50000')

// Body size limit
const MAX_BODY_SIZE = 100 * 1024 // 100KB

// Rate limiting (in-memory, reset on redeploy — good enough for serverless)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_MAX = 10
const RATE_LIMIT_WINDOW_MS = 60_000

function checkRateLimit(walletHash: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(walletHash)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(walletHash, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return true
  }
  entry.count++
  return entry.count <= RATE_LIMIT_MAX
}

// Cache sponsor private key + address
let sponsorKeyCache: string | null = null
let sponsorAddressCache: string | null = null

async function getSponsorPrivateKey(): Promise<string> {
  if (sponsorKeyCache) return sponsorKeyCache

  const mnemonic = process.env.SPONSOR_MNEMONIC || process.env.ORACLE_MNEMONIC
  if (!mnemonic) throw new Error('SPONSOR_MNEMONIC not configured')

  const wallet = await generateWallet({ secretKey: mnemonic, password: '' })
  const account = wallet.accounts[0]
  sponsorKeyCache = account.stxPrivateKey
  sponsorAddressCache = getStxAddress({ account, network: NETWORK_NAME })
  return sponsorKeyCache
}

// In-memory lock fallback (for local dev without Redis)
const g = globalThis as unknown as { __sponsorLock?: Promise<void> }
g.__sponsorLock ??= Promise.resolve()

export async function POST(req: NextRequest) {
  // Body size check
  const contentLength = parseInt(req.headers.get('content-length') || '0', 10)
  if (contentLength > MAX_BODY_SIZE) {
    return NextResponse.json({ error: 'Request too large' }, { status: 413 })
  }

  // Try Redis lock first; fall back to in-memory promise chain
  const gotRedisLock = await acquireSponsorLock(3000)

  let releaseLock: () => void = () => {}
  if (!gotRedisLock) {
    const prevLock = g.__sponsorLock!
    g.__sponsorLock = new Promise<void>(resolve => { releaseLock = resolve })
    await prevLock
  }

  try {
    const { txHex } = await req.json()

    if (!txHex || typeof txHex !== 'string') {
      return NextResponse.json({ error: 'Missing or invalid txHex' }, { status: 400 })
    }

    // Body size double-check on txHex
    if (txHex.length > MAX_BODY_SIZE * 2) { // hex = 2 chars per byte
      return NextResponse.json({ error: 'Transaction too large' }, { status: 413 })
    }

    // 1. Deserialize transaction
    console.log(`[sponsor] Received txHex (${txHex.length} chars): ${txHex.slice(0, 80)}...`)
    const transaction = deserializeTransaction(txHex)

    // 2. Validate contract-call to allowed contracts
    const payload = transaction.payload
    if (payload.payloadType !== PayloadType.ContractCall) {
      return NextResponse.json({ error: 'Only contract calls are allowed' }, { status: 400 })
    }

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

    // Rate limiting by wallet
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const originAuth = (transaction.auth as any)?.spendingCondition ?? (transaction.auth as any)?.originCondition
    const originSignerHash = originAuth?.signer as string | undefined

    if (originSignerHash && !checkRateLimit(originSignerHash)) {
      return NextResponse.json(
        { error: 'Rate limit exceeded (max 10 txs/min)', reason: 'rate_limited' },
        { status: 429 }
      )
    }

    // --- TIMING ENFORCEMENT for place-bet ---
    if (functionName === 'place-bet') {
      const now = Date.now()
      const currentRoundId = Math.floor(now / 1000 / 60)
      const roundEndMs = (currentRoundId + 1) * 60 * 1000
      const msUntilEnd = roundEndMs - now
      const CUTOFF_MS = 10_000 // 10 seconds

      if (msUntilEnd <= CUTOFF_MS) {
        console.log(`[sponsor] REJECTED place-bet: ${(msUntilEnd / 1000).toFixed(1)}s until round end (cutoff=${CUTOFF_MS / 1000}s)`)
        return NextResponse.json(
          { error: 'Trading window closed', reason: 'too_late', secondsLeft: Math.round(msUntilEnd / 1000) },
          { status: 403 }
        )
      }
    }

    // 3. Sponsor the transaction
    const sponsorPrivateKey = await getSponsorPrivateKey()

    // Block deployer from placing bets (self-sponsored = 2 nonces from same account)
    let isSelfSponsored = false
    if (originSignerHash && sponsorAddressCache) {
      try {
        const { c32addressDecode } = await import('c32check')
        const [, sponsorHash] = c32addressDecode(sponsorAddressCache)
        isSelfSponsored = originSignerHash.toLowerCase() === sponsorHash.toLowerCase()
      } catch { /* treat as not self-sponsored */ }
    }

    if (isSelfSponsored) {
      return NextResponse.json(
        { error: 'Deployer wallet cannot place bets (use a different wallet)' },
        { status: 403 }
      )
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sponsorOpts: any = {
      transaction,
      sponsorPrivateKey,
      fee: SPONSOR_FEE,
      network: NETWORK_NAME,
    }

    // Determine initial sponsor nonce
    let sponsorNonce: bigint | undefined
    const tracked = await getSponsorNonce()
    if (tracked) {
      sponsorNonce = tracked.nonce
      console.log(`[sponsor] Using KV tracked nonce: ${sponsorNonce}`)
    }

    // Sponsor + Broadcast with retry on nonce errors
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

      // Debug: compare wallet hex vs re-serialized hex vs sponsored hex
      const walletReserialize = transaction.serialize()
      const sponsoredHex = sponsoredTx.serialize()

      // Find first diff between wallet input and round-tripped
      let diffPos = -1
      for (let i = 0; i < Math.max(txHex.length, walletReserialize.length); i++) {
        if (txHex[i] !== walletReserialize[i]) { diffPos = i; break }
      }
      // Find first diff between wallet input and sponsored
      let diffPosSponsor = -1
      for (let i = 0; i < Math.max(txHex.length, sponsoredHex.length); i++) {
        if (txHex[i] !== sponsoredHex[i]) { diffPosSponsor = i; break }
      }

      const debugInfo = {
        walletHexLen: txHex.length,
        resLen: walletReserialize.length,
        sponsoredLen: sponsoredHex.length,
        walletMatchesReserialize: txHex === walletReserialize,
        diffPos,
        diffContext: diffPos >= 0 ? {
          wallet:   txHex.slice(Math.max(0, diffPos - 20), diffPos + 40),
          reserial: walletReserialize.slice(Math.max(0, diffPos - 20), diffPos + 40),
        } : null,
        diffPosSponsor,
        // Return FULL wallet hex and sponsored hex (only ~624 chars each)
        walletHexFull: txHex,
        sponsoredHexFull: sponsoredHex,
        originNonce: String(usedOriginNonce),
        sponsorNonce: String(usedSponsorNonce),
      }
      console.log(`[sponsor] diffPos=${diffPos} diffPosSponsor=${diffPosSponsor}`)

      let result: Record<string, unknown>
      try {
        const broadcastRes = await fetch(`${HIRO_API}/v2/transactions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: Buffer.from(sponsoredHex, 'hex'),
        })
        const responseText = await broadcastRes.text()

        // Successful broadcast returns a JSON-encoded txid string: "0xabcd..."
        const trimmed = responseText.replace(/^"|"$/g, '').trim()
        if (broadcastRes.ok && /^0x[0-9a-f]{64}$/i.test(trimmed)) {
          result = { txid: trimmed }
        } else {
          try {
            result = JSON.parse(responseText)
          } catch {
            if (attempt < MAX_RETRIES) {
              await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
              continue
            }
            // Return debug info with the error
            return NextResponse.json(
              { error: trimmed || `Broadcast failed (HTTP ${broadcastRes.status})`, debug: debugInfo },
              { status: 400 }
            )
          }
        }
      } catch (broadcastErr) {
        const msg = broadcastErr instanceof Error ? broadcastErr.message : String(broadcastErr)
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
          continue
        }
        return NextResponse.json(
          { error: `Failed to broadcast: ${msg}`, debug: debugInfo },
          { status: 500 }
        )
      }

      // Check for broadcast errors
      if ('error' in result) {
        const r = result as Record<string, unknown>
        const reason = r.reason as string
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const reasonData = r.reason_data as any

        if ((reason === 'BadNonce' || reason === 'ConflictingNonceInMempool') && attempt < MAX_RETRIES) {
          if (reasonData?.expected != null) {
            sponsorNonce = BigInt(reasonData.expected)
            console.log(`[sponsor] Nonce error (${reason}), retrying with nonce=${sponsorNonce}`)
            continue
          }
          if (sponsorNonce !== undefined) {
            sponsorNonce += BigInt(1)
            console.log(`[sponsor] Nonce conflict, retrying with nonce=${sponsorNonce}`)
            continue
          }
        }

        await clearSponsorNonce()
        console.error('[sponsor] Broadcast rejected:', JSON.stringify(result))
        return NextResponse.json(
          { error: r.error, reason, reason_data: reasonData, debug: debugInfo },
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
                await addOptimisticBet(roundId, side as 'UP' | 'DOWN', amountMicro, result.txid as string)
                await trackRoundWithBets(roundId)
                console.log(`[sponsor] KV optimistic: round=${roundId} ${side} $${(amountMicro / 1e6).toFixed(2)} txid=${result.txid}`)

                // Dispatch webhook event (fire and forget)
                dispatchWebhookEvent('bet.confirmed', {
                  roundId,
                  side,
                  amountUsd: amountMicro / 1e6,
                  txid: result.txid,
                }).catch(() => {})

                // Track wallet per side for counterparty validation
                if (originSignerHash) {
                  await trackBettorSide(roundId, originSignerHash.toLowerCase(), side as 'UP' | 'DOWN')
                }

                // Track early bet for jackpot (off-chain determination)
                const now = Date.now()
                const roundStartMs = roundId * 60 * 1000
                const betTimestampS = Math.floor(now / 1000)
                const roundStartS = Math.floor(roundStartMs / 1000)
                if (isEarlyBet(betTimestampS, roundStartS) && originSignerHash) {
                  const earlyBetInfo = {
                    user: originSignerHash.toLowerCase(),
                    side: side as 'UP' | 'DOWN',
                    amountUsd: amountMicro / 1e6,
                    roundId: roundId.toString(),
                    betTimestampS,
                    roundStartS,
                  }
                  await Promise.all([
                    recordEarlyBet(earlyBetInfo),
                    addOptimisticEarlyBet(roundId, side as 'UP' | 'DOWN', amountMicro),
                    pushEarlyBet(roundId, earlyBetInfo),
                  ])
                  console.log(`[sponsor] Jackpot early bet tracked: round=${roundId} ${side} $${(amountMicro / 1e6).toFixed(2)}`)
                }
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
    await alert('CRITICAL', 'Sponsor broadcast failed after retries', { lastResult })
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
