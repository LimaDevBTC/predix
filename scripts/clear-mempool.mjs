#!/usr/bin/env node
/**
 * Clear stuck mempool — fills missing nonce gaps with minimal STX transfers
 * so the chain can process the entire tx queue.
 *
 * Usage:
 *   ORACLE_MNEMONIC="your mnemonic" node scripts/clear-mempool.mjs
 *
 * What it does:
 *   1. Reads nonce state from Hiro API
 *   2. Finds missing nonces between last_executed and last_mempool
 *   3. Submits 1-uSTX self-transfers at each missing nonce
 *   4. Waits for confirmation
 */

import { makeSTXTokenTransfer, broadcastTransaction } from '@stacks/transactions'
import { STACKS_TESTNET } from '@stacks/network'
import { generateWallet, getStxAddress } from '@stacks/wallet-sdk'

const HIRO_API = 'https://api.testnet.hiro.so'

async function main() {
  const mnemonic = process.env.ORACLE_MNEMONIC
  if (!mnemonic) {
    console.error('ERROR: ORACLE_MNEMONIC env var required')
    process.exit(1)
  }

  // 1. Derive wallet
  const wallet = await generateWallet({ secretKey: mnemonic, password: '' })
  const account = wallet.accounts[0]
  const privateKey = account.stxPrivateKey
  const address = getStxAddress({ account, network: 'testnet' })
  console.log(`Wallet: ${address}`)

  // 2. Get nonce state
  const nonceRes = await fetch(`${HIRO_API}/extended/v1/address/${address}/nonces`)
  const nonceData = await nonceRes.json()
  console.log('Nonce state:', JSON.stringify(nonceData, null, 2))

  const { last_executed_tx_nonce, last_mempool_tx_nonce, detected_missing_nonces, detected_mempool_nonces } = nonceData

  if (!detected_missing_nonces || detected_missing_nonces.length === 0) {
    console.log('No missing nonces detected. Checking if mempool has stuck txs...')

    if (detected_mempool_nonces && detected_mempool_nonces.length > 0) {
      console.log(`${detected_mempool_nonces.length} txs in mempool (nonces ${detected_mempool_nonces[0]}-${detected_mempool_nonces[detected_mempool_nonces.length - 1]})`)
      console.log('No gaps to fill — txs should process when testnet mines user txs.')
    } else {
      console.log('Mempool is clean.')
    }
    return
  }

  console.log(`\nLast executed nonce: ${last_executed_tx_nonce}`)
  console.log(`Last mempool nonce: ${last_mempool_tx_nonce}`)
  console.log(`Missing nonces: ${detected_missing_nonces.join(', ')}`)
  console.log(`Mempool nonces: ${detected_mempool_nonces.length}`)

  // 3. Fill each missing nonce with a 1-uSTX transfer to burn address
  // NOTE: Stacks rejects self-transfers (TransferRecipientCannotEqualSender)
  const BURN_ADDRESS = 'ST000000000000000000002AMW42H'
  console.log(`\nFilling ${detected_missing_nonces.length} missing nonce(s)...\n`)

  for (const nonce of detected_missing_nonces.sort((a, b) => a - b)) {
    console.log(`Nonce ${nonce}: submitting 1-uSTX transfer to burn address...`)

    try {
      const tx = await makeSTXTokenTransfer({
        recipient: BURN_ADDRESS,
        amount: BigInt(1),  // 1 micro-STX
        senderKey: privateKey,
        network: STACKS_TESTNET,
        fee: BigInt(500000),  // 0.5 STX (high enough to not get dropped)
        nonce: BigInt(nonce),
        memo: `nonce-fill-${nonce}`,
      })

      const result = await broadcastTransaction({ transaction: tx, network: 'testnet' })

      if ('txid' in result) {
        console.log(`  OK: ${result.txid}`)
      } else {
        console.log(`  FAILED:`, JSON.stringify(result))
      }
    } catch (e) {
      console.error(`  ERROR:`, e.message)
    }
  }

  // 4. Re-check nonce state
  console.log('\nRe-checking nonce state...')
  const recheck = await (await fetch(`${HIRO_API}/extended/v1/address/${address}/nonces`)).json()
  console.log('Updated:', JSON.stringify({
    last_executed: recheck.last_executed_tx_nonce,
    last_mempool: recheck.last_mempool_tx_nonce,
    possible_next: recheck.possible_next_nonce,
    missing: recheck.detected_missing_nonces,
    mempool_count: recheck.detected_mempool_nonces?.length ?? 0,
  }))

  console.log('\nDone. Stuck txs should process once testnet mines the queue.')
}

main().catch(e => { console.error(e); process.exit(1) })
