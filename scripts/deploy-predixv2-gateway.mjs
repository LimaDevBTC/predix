/**
 * Script para deploy do predixv2-gateway na testnet Stacks
 *
 * IMPORTANTE: Deploy predixv2 PRIMEIRO. O gateway faz contract-call? para predixv2.
 *
 * Uso: ORACLE_MNEMONIC="..." node scripts/deploy-predixv2-gateway.mjs
 */

import { readFileSync } from 'fs'
import txPkg from '@stacks/transactions'
const {
  makeContractDeploy,
  AnchorMode,
  PostConditionMode,
} = txPkg
import netPkg from '@stacks/network'
const { STACKS_TESTNET } = netPkg
import walletPkg from '@stacks/wallet-sdk'
const { generateWallet, getStxAddress } = walletPkg

const MNEMONIC = process.env.ORACLE_MNEMONIC
if (!MNEMONIC) {
  console.error('ORACLE_MNEMONIC not set')
  console.error('Usage: ORACLE_MNEMONIC="..." node scripts/deploy-predixv2-gateway.mjs')
  process.exit(1)
}

const CONTRACT_NAME = 'predixv2-gateway'
const CONTRACT_PATH = './contracts/predixv2-gateway.clar'

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function main() {
  console.log('Deploying predixv2-gateway to Stacks testnet...\n')

  // 1. Gera wallet a partir da mnemonic
  console.log('Generating wallet from mnemonic...')
  const wallet = await generateWallet({
    secretKey: MNEMONIC,
    password: '',
  })
  const account = wallet.accounts[0]
  const privateKey = account.stxPrivateKey

  const address = getStxAddress({ account, network: 'testnet' })
  console.log(`   Address: ${address}`)

  // 2. Le o codigo do contrato
  console.log(`Reading contract from ${CONTRACT_PATH}...`)
  const codeBody = readFileSync(CONTRACT_PATH, 'utf8')
  console.log(`   Contract size: ${codeBody.length} bytes`)

  // 3. Busca o nonce atual
  console.log('Fetching current nonce...')
  const nonceData = await fetchJson(`https://api.testnet.hiro.so/extended/v1/address/${address}/nonces`)
  const nonce = nonceData.possible_next_nonce
  console.log(`   Nonce: ${nonce}`)

  // 4. Cria a transacao de deploy (sem clarityVersion - SDK usa default da rede)
  console.log('Creating deploy transaction...')
  const network = STACKS_TESTNET

  const txOptions = {
    contractName: CONTRACT_NAME,
    codeBody,
    senderKey: privateKey,
    network,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Allow,
    fee: 200000n, // 0.2 STX
    nonce: BigInt(nonce),
  }

  const transaction = await makeContractDeploy(txOptions)
  const txId = transaction.txid()
  console.log(`   TX ID: ${txId}`)

  // 5. Broadcast via fetch (Node.js native)
  console.log('Broadcasting transaction...')

  const hexTx = transaction.serialize()
  const binaryTx = Buffer.from(hexTx, 'hex')
  console.log(`   Transaction size: ${binaryTx.length} bytes`)

  const broadcastRes = await fetch('https://api.testnet.hiro.so/v2/transactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: binaryTx,
  })
  const broadcastText = await broadcastRes.text()
  console.log(`   Broadcast response (${broadcastRes.status}): ${broadcastText.slice(0, 200)}`)

  let broadcastData
  try {
    broadcastData = JSON.parse(broadcastText)
  } catch {
    broadcastData = { txid: broadcastText.trim().replace(/"/g, '') }
  }

  if (broadcastData.error) {
    console.error('Broadcast failed:', broadcastData.error)
    console.error('   Reason:', broadcastData.reason)
    if (broadcastData.reason_data) {
      console.error('   Details:', JSON.stringify(broadcastData.reason_data, null, 2))
    }
    process.exit(1)
  }

  console.log('\nTransaction broadcasted!')
  console.log(`   TX ID: ${txId}`)
  console.log(`   Explorer: https://explorer.hiro.so/txid/${txId}?chain=testnet`)
  console.log(`   Contract ID: ${address}.${CONTRACT_NAME}`)

  console.log('\nWaiting for confirmation (10-30 min on testnet)...')

  // 6. Poll para confirmar
  let confirmed = false
  let attempts = 0
  const maxAttempts = 60

  while (!confirmed && attempts < maxAttempts) {
    await new Promise(r => setTimeout(r, 30000))
    attempts++

    try {
      const statusData = await fetchJson(`https://api.testnet.hiro.so/extended/v1/tx/${txId}`)

      if (statusData.tx_status === 'success') {
        confirmed = true
        console.log('\nContract deployed successfully!')
        console.log(`   Contract ID: ${address}.${CONTRACT_NAME}`)
      } else if (statusData.tx_status === 'abort_by_response' || statusData.tx_status === 'abort_by_post_condition') {
        console.error('\nTransaction aborted:', statusData.tx_status)
        if (statusData.tx_result) {
          console.error('   Result:', statusData.tx_result)
        }
        process.exit(1)
      } else {
        console.log(`   [${attempts}/${maxAttempts}] Status: ${statusData.tx_status || 'pending'}...`)
      }
    } catch (e) {
      console.log(`   [${attempts}/${maxAttempts}] Checking...`)
    }
  }

  if (!confirmed) {
    console.log('\nTimed out waiting for confirmation.')
    console.log('   The transaction may still be pending. Check the explorer.')
  }
}

main().catch(console.error)
