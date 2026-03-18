/**
 * Local transaction signing for agents
 *
 * Signs unsigned sponsored transactions with the agent's private key.
 * Private key never leaves the agent's machine.
 */

import {
  deserializeTransaction,
  createStacksPrivateKey,
  pubKeyfromPrivKey,
  publicKeyToString,
  TransactionSigner,
  signMessageHashRsv,
} from '@stacks/transactions'
import crypto from 'crypto'

/**
 * Derive compressed public key hex from a private key hex string.
 */
export function getPublicKey(privateKey: string): string {
  const pk = createStacksPrivateKey(privateKey)
  return publicKeyToString(pubKeyfromPrivKey(pk))
}

/**
 * Sign an unsigned sponsored transaction hex with the given private key.
 * Returns the signed transaction hex ready for /api/sponsor.
 */
export function signTransaction(unsignedTxHex: string, privateKey: string): string {
  const tx = deserializeTransaction(unsignedTxHex)
  const signer = new TransactionSigner(tx)
  signer.signOrigin(createStacksPrivateKey(privateKey))
  return tx.serialize()
}

/**
 * Hash a message the same way Stacks wallets do (matching server-side verification).
 */
function hashMessage(message: string): string {
  const prefix = '\x17Stacks Signed Message:\n'
  const msgBytes = Buffer.from(message, 'utf8')
  const lenBytes = msgBytes.length < 0xfd
    ? Buffer.from([msgBytes.length])
    : Buffer.from([0xfd, msgBytes.length & 0xff, (msgBytes.length >> 8) & 0xff])
  const full = Buffer.concat([Buffer.from(prefix, 'utf8'), lenBytes, msgBytes])
  return crypto.createHash('sha256').update(full).digest('hex')
}

/**
 * Sign a message with the agent's private key (Stacks message format).
 * Returns RSV hex signature compatible with /api/agent/register.
 */
export function signMessage(message: string, privateKey: string): string {
  const messageHash = hashMessage(message)
  return signMessageHashRsv({ messageHash, privateKey })
}
