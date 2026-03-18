/**
 * Agent Registration — POST /api/agent/register
 *
 * Agents prove wallet ownership via Stacks message signature,
 * receive an API key (pk_live_...) shown exactly once.
 */

import { NextRequest, NextResponse } from 'next/server'
import { generateAgentKey, getAgentByWallet } from '@/lib/agent-keys'
import {
  publicKeyFromSignatureRsv,
  publicKeyToAddress,
  AddressVersion,
  hashMessage,
} from '@/lib/agent-signature'

export const dynamic = 'force-dynamic'

// Rate limit: 5 registrations per hour per IP (in-memory, resets on cold start)
const regAttempts = new Map<string, { count: number; resetAt: number }>()

function checkRegRateLimit(ip: string): boolean {
  const now = Date.now()
  const entry = regAttempts.get(ip)
  if (!entry || now > entry.resetAt) {
    regAttempts.set(ip, { count: 1, resetAt: now + 3600_000 })
    return true
  }
  if (entry.count >= 5) return false
  entry.count++
  return true
}

export async function POST(req: NextRequest) {
  try {
    const ip =
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      req.headers.get('x-real-ip') ||
      'unknown'

    if (!checkRegRateLimit(ip)) {
      return NextResponse.json(
        { ok: false, error: 'Too many registration attempts. Try again later.' },
        { status: 429 },
      )
    }

    const body = await req.json()
    const { wallet, signature, message, name, description } = body as {
      wallet?: string
      signature?: string
      message?: string
      name?: string
      description?: string
    }

    // Validate required fields
    if (!wallet || !signature || !message) {
      return NextResponse.json(
        { ok: false, error: 'Missing required fields: wallet, signature, message' },
        { status: 400 },
      )
    }

    // Validate wallet format
    if (!/^S[TPM][A-Z0-9]{38,}$/.test(wallet)) {
      return NextResponse.json(
        { ok: false, error: 'Invalid Stacks address format' },
        { status: 400 },
      )
    }

    // Validate message format and timestamp
    const msgMatch = message.match(/^Predix Agent Registration (\d+)$/)
    if (!msgMatch) {
      return NextResponse.json(
        { ok: false, error: 'Message must be: "Predix Agent Registration {unix_timestamp_seconds}"' },
        { status: 400 },
      )
    }

    const msgTimestamp = parseInt(msgMatch[1])
    const nowSec = Math.floor(Date.now() / 1000)
    if (Math.abs(nowSec - msgTimestamp) > 300) {
      return NextResponse.json(
        { ok: false, error: 'Message timestamp expired (must be within 5 minutes)' },
        { status: 400 },
      )
    }

    // Validate name/description lengths
    if (name && name.length > 32) {
      return NextResponse.json(
        { ok: false, error: 'Name must be 32 chars or less' },
        { status: 400 },
      )
    }
    if (description && description.length > 200) {
      return NextResponse.json(
        { ok: false, error: 'Description must be 200 chars or less' },
        { status: 400 },
      )
    }

    // Verify signature: recover public key → derive address → compare with wallet
    let recoveredAddress: string
    try {
      const messageHash = hashMessage(message)
      const pubKey = publicKeyFromSignatureRsv(messageHash, signature)
      recoveredAddress = publicKeyToAddress(
        pubKey,
        // Testnet addresses start with ST, mainnet with SP
        wallet.startsWith('ST') ? AddressVersion.TestnetSingleSig : AddressVersion.MainnetSingleSig,
      )
    } catch {
      return NextResponse.json(
        { ok: false, error: 'Invalid signature' },
        { status: 400 },
      )
    }

    if (recoveredAddress !== wallet) {
      return NextResponse.json(
        { ok: false, error: 'Signature does not match wallet address' },
        { status: 400 },
      )
    }

    // Check if wallet already registered — re-register regenerates key
    const existing = await getAgentByWallet(wallet)
    if (existing) {
      // Valid signature proves ownership — regenerate key so auto-register always works
      const { revokeAgentKey } = await import('@/lib/agent-keys')
      await revokeAgentKey(existing.keyHash)
      const result = await generateAgentKey(wallet, name || existing.name, description || existing.description)

      return NextResponse.json({
        ok: true,
        apiKey: result.key,
        prefix: result.prefix,
        wallet,
        tier: existing.tier,
        limits: { requestsPerMinute: existing.tier === 'verified' ? 120 : 30 },
        regenerated: true,
      })
    }

    // Generate new key
    const result = await generateAgentKey(wallet, name, description)

    if (result.isExisting) {
      return NextResponse.json({
        ok: true,
        message: 'Wallet already registered.',
        prefix: result.prefix,
        wallet,
        tier: 'free' as const,
        limits: { requestsPerMinute: 30 },
      })
    }

    return NextResponse.json({
      ok: true,
      apiKey: result.key,
      prefix: result.prefix,
      wallet,
      tier: 'free' as const,
      limits: { requestsPerMinute: 30 },
    })
  } catch (err) {
    console.error('[agent/register] Error:', err)
    return NextResponse.json(
      { ok: false, error: 'Registration failed' },
      { status: 500 },
    )
  }
}
