import { request } from '@stacks/connect'
import { makeUnsignedContractCall, ClarityValue, PostConditionMode } from '@stacks/transactions'
import { NETWORK_NAME } from './config'

const PUBLIC_KEY_STORAGE = 'stx_public_key'

/** Retorna a publicKey salva do user ou null */
export function getSavedPublicKey(): string | null {
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem(PUBLIC_KEY_STORAGE)
}

/** Salva a publicKey no localStorage */
export function savePublicKey(publicKey: string): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(PUBLIC_KEY_STORAGE, publicKey)
  }
}

// ---------------------------------------------------------------------------
// Nonce tracking — prevents ConflictingNonceInMempool when placing multiple
// bets in rapid succession (before previous txs confirm on-chain).
// ---------------------------------------------------------------------------
const nonceTracker = new Map<string, { nonce: bigint; ts: number }>()
const NONCE_TTL_MS = 120_000 // expire after 2 min (Stacks testnet blocks ~10-60s)

/**
 * Builds unsigned sponsored tx client-side, wallet signs via stx_signTransaction,
 * then sends to /api/sponsor for sponsoring + broadcast.
 *
 * The wallet receives the EXACT hex we built (no re-serialization on its side),
 * just adds the origin signature.
 */
export async function sponsoredContractCall(params: {
  contractAddress: string
  contractName: string
  functionName: string
  functionArgs: ClarityValue[]
  publicKey: string
}): Promise<string> {
  // Check for tracked nonce from a recent successful broadcast
  const tracked = nonceTracker.get(params.publicKey)
  const pendingNonce = (tracked && Date.now() - tracked.ts < NONCE_TTL_MS)
    ? tracked.nonce
    : undefined

  // 1. Build unsigned tx with sponsored=true and fee=0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const txOptions: any = {
    contractAddress: params.contractAddress,
    contractName: params.contractName,
    functionName: params.functionName,
    functionArgs: params.functionArgs,
    publicKey: params.publicKey,
    network: NETWORK_NAME,
    fee: 0,
    sponsored: true,
    postConditionMode: PostConditionMode.Allow,
  }
  if (pendingNonce !== undefined) {
    txOptions.nonce = pendingNonce
  }

  let unsignedTx
  try {
    unsignedTx = await makeUnsignedContractCall(txOptions)
  } catch (err) {
    const msg = (err as Error).message || String(err)
    if (msg.toLowerCase().includes('fetch') || msg.toLowerCase().includes('network')) {
      throw new Error('Network error building transaction. Please try again.')
    }
    throw err
  }
  const txHex = unsignedTx.serialize()

  // 2. Ask wallet to sign via stx_signTransaction
  // Preserve @stacks/connect session state
  const CONNECT_KEY = '@stacks/connect'
  const savedSession = localStorage.getItem(CONNECT_KEY)

  const result = await request('stx_signTransaction', {
    transaction: txHex,
    broadcast: false,
  })
  const signedHex = result.transaction

  // Restore session if wallet overwrote it
  if (savedSession && localStorage.getItem(CONNECT_KEY) !== savedSession) {
    localStorage.setItem(CONNECT_KEY, savedSession)
  }

  // 3. Send to /api/sponsor for sponsoring + broadcast
  const res = await fetch('/api/sponsor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: signedHex }),
  })

  const data = await res.json()

  if (!res.ok || data.error) {
    nonceTracker.delete(params.publicKey)
    throw new Error(data.error || `Sponsor failed (${res.status})`)
  }

  // Track next expected nonce
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const usedNonce = BigInt((unsignedTx.auth as any).spendingCondition?.nonce ?? 0)
    nonceTracker.set(params.publicKey, { nonce: usedNonce + BigInt(1), ts: Date.now() })
  } catch {
    nonceTracker.delete(params.publicKey)
  }

  return data.txid
}
