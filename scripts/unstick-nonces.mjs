/**
 * Unstick nonce gap by sending resolve-and-distribute for an already-resolved
 * round at the specific missing nonces. The tx will abort_by_response on-chain
 * but still consume the nonce, unblocking all subsequent pending txs.
 *
 * Usage:
 *   ORACLE_MNEMONIC="..." node scripts/unstick-nonces.mjs
 *
 * Optional:
 *   NONCES="4791,4792"  -- comma-separated missing nonces (auto-detected if omitted)
 */

import txPkg from '@stacks/transactions'
const { makeContractCall, PostConditionMode, uintCV } = txPkg
import netPkg from '@stacks/network'
const { STACKS_TESTNET } = netPkg
import walletPkg from '@stacks/wallet-sdk'
const { generateWallet, getStxAddress } = walletPkg

const MNEMONIC = process.env.ORACLE_MNEMONIC
if (!MNEMONIC) {
  console.error('ORACLE_MNEMONIC not set')
  process.exit(1)
}

const HIRO_API = process.env.HIRO_API || 'https://api.testnet.hiro.so'
const GATEWAY_CONTRACT = 'ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK.gatewayv7'
const TX_FEE = 50000n

// An already-resolved round — will abort_by_response but consume the nonce
const DUMMY_ROUND_ID = 29567167
const DUMMY_PRICE_START = 7001714
const DUMMY_PRICE_END = 6996060

async function main() {
  const wallet = await generateWallet({ secretKey: MNEMONIC, password: '' })
  const account = wallet.accounts[0]
  const privateKey = account.stxPrivateKey
  const address = getStxAddress({ account, network: 'testnet' })
  console.log(`Sponsor: ${address}`)

  // Detect missing nonces if not provided
  let missingNonces
  if (process.env.NONCES) {
    missingNonces = process.env.NONCES.split(',').map(Number)
  } else {
    const res = await fetch(`${HIRO_API}/extended/v1/address/${address}/nonces`)
    const data = await res.json()
    missingNonces = data.detected_missing_nonces || []
    console.log(`Auto-detected missing nonces: ${JSON.stringify(missingNonces)}`)
    console.log(`Last executed: ${data.last_executed_tx_nonce}, next: ${data.possible_next_nonce}`)
    console.log(`Mempool nonces: ${JSON.stringify(data.detected_mempool_nonces)}`)
  }

  if (missingNonces.length === 0) {
    console.log('No missing nonces detected. Nothing to do.')
    return
  }

  const [contractAddress, contractName] = GATEWAY_CONTRACT.split('.')

  for (const nonce of missingNonces.sort((a, b) => a - b)) {
    console.log(`\nSending dummy resolve-and-distribute at nonce ${nonce}...`)

    const tx = await makeContractCall({
      contractAddress,
      contractName,
      functionName: 'resolve-and-distribute',
      functionArgs: [
        uintCV(DUMMY_ROUND_ID),
        uintCV(DUMMY_PRICE_START),
        uintCV(DUMMY_PRICE_END),
      ],
      senderKey: privateKey,
      network: STACKS_TESTNET,
      postConditionMode: PostConditionMode.Allow,
      fee: TX_FEE,
      nonce: BigInt(nonce),
    })

    const hexTx = tx.serialize()
    const binaryTx = Buffer.from(hexTx, 'hex')

    const broadcastRes = await fetch(`${HIRO_API}/v2/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: binaryTx,
    })
    const text = await broadcastRes.text()

    let result
    try { result = JSON.parse(text) } catch { result = { txid: text.trim().replace(/"/g, '') } }

    if (result.error) {
      console.error(`  FAILED: ${result.error} — ${result.reason}`)
      if (result.reason === 'ConflictingNonceInMempool') {
        console.log('  Nonce already in mempool — may already be unsticking')
      }
    } else {
      const txid = result.txid || result
      console.log(`  OK: txid=${txid}`)
    }
  }

  console.log('\nDone. The 19 pending txs should start mining once these confirm (~10-30s).')
  console.log('Monitor at: https://explorer.hiro.so/address/ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK?chain=testnet')
}

main().catch(err => { console.error(err); process.exit(1) })
