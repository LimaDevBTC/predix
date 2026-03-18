/**
 * Stacks transaction signing utilities.
 * Private key never leaves the agent's machine.
 */

import {
  deserializeTransaction,
  createStacksPrivateKey,
  pubKeyfromPrivKey,
  publicKeyToHex,
  TransactionSigner,
  signMessageHashRsv,
} from '@stacks/transactions'
import crypto from 'crypto'
import { getStxAddress } from '@stacks/wallet-sdk'

export function getPublicKey(privateKeyHex: string): string {
  const pk = createStacksPrivateKey(privateKeyHex)
  return publicKeyToHex(pubKeyfromPrivKey(pk))
}

export function getAddress(privateKeyHex: string, network: 'testnet' | 'mainnet' = 'testnet'): string {
  return getStxAddress({
    account: {
      stxPrivateKey: privateKeyHex,
      dataPrivateKey: '',
      appsKey: '',
      salt: '',
      index: 0,
    } as Parameters<typeof getStxAddress>[0]['account'],
    network,
  })
}

export function signTransaction(txHex: string, privateKeyHex: string): string {
  const tx = deserializeTransaction(txHex)
  const signer = new TransactionSigner(tx)
  signer.signOrigin(createStacksPrivateKey(privateKeyHex))
  return tx.serialize()
}

function hashMessage(message: string): string {
  const prefix = '\x17Stacks Signed Message:\n'
  const msgBytes = Buffer.from(message, 'utf8')
  const lenBytes = msgBytes.length < 0xfd
    ? Buffer.from([msgBytes.length])
    : Buffer.from([0xfd, msgBytes.length & 0xff, (msgBytes.length >> 8) & 0xff])
  const full = Buffer.concat([Buffer.from(prefix, 'utf8'), lenBytes, msgBytes])
  return crypto.createHash('sha256').update(full).digest('hex')
}

export function signMessage(message: string, privateKeyHex: string): string {
  const messageHash = hashMessage(message)
  return signMessageHashRsv({ messageHash, privateKey: privateKeyHex })
}
