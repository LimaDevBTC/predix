/**
 * Deploy predixv3 + gatewayv2 to Stacks testnet + run setup calls.
 *
 * PREREQUISITE: test-usdcx already deployed at same deployer address.
 *
 * Sequence:
 *   1. ASCII scan both contracts
 *   2. Deploy predixv3 (wait for confirmation)
 *   3. Deploy gatewayv2 (wait for confirmation)
 *   4. Call predixv8.set-initial-price(btc-price)   -- bootstrap price bounds
 *   5. Call predixv8.set-fee-recipient(deployer)     -- deployer = fee recipient
 *   6. Call gatewayv7.set-sponsor(deployer)          -- deployer = sponsor
 *   7. Call predixv8.seed-jackpot(200000000)         -- $200 USDCx jackpot seed
 *
 * Usage:
 *   ORACLE_MNEMONIC="..." node scripts/deploy-predixv8.mjs
 *
 * Optional env vars:
 *   SKIP_DEPLOY=1     -- skip deploy, only run setup calls (if contracts already deployed)
 *   SKIP_SETUP=1      -- skip setup calls, only deploy contracts
 *   HIRO_API=https://api.testnet.hiro.so
 */

import { readFileSync } from 'fs'
import txPkg from '@stacks/transactions'
const {
  makeContractDeploy,
  makeContractCall,
  AnchorMode,
  PostConditionMode,
  uintCV,
  standardPrincipalCV,
  contractPrincipalCV,
} = txPkg
import netPkg from '@stacks/network'
const { STACKS_TESTNET } = netPkg
import walletPkg from '@stacks/wallet-sdk'
const { generateWallet, getStxAddress } = walletPkg

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MNEMONIC = process.env.ORACLE_MNEMONIC
if (!MNEMONIC) {
  console.error('ORACLE_MNEMONIC not set')
  console.error('Usage: ORACLE_MNEMONIC="..." node scripts/deploy-predixv8.mjs')
  process.exit(1)
}

const HIRO_API = process.env.HIRO_API || 'https://api.testnet.hiro.so'
const SKIP_DEPLOY = process.env.SKIP_DEPLOY === '1'
const SKIP_SETUP = process.env.SKIP_SETUP === '1'
const DEPLOY_FEE = 200000n   // 0.2 STX
const CALL_FEE = 50000n      // 0.05 STX
const NETWORK = STACKS_TESTNET

const CONTRACTS = [
  { name: 'predixv8', path: './contracts/predixv8.clar' },
  { name: 'gatewayv7', path: './contracts/gatewayv7.clar' },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
  return res.json()
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

function asciiScan(filePath) {
  const content = readFileSync(filePath, 'utf8')
  const issues = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    for (let j = 0; j < lines[i].length; j++) {
      const code = lines[i].charCodeAt(j)
      if (code > 127) {
        issues.push({ line: i + 1, col: j + 1, char: lines[i][j], code })
      }
    }
  }
  return issues
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

async function initWallet() {
  const wallet = await generateWallet({ secretKey: MNEMONIC, password: '' })
  const account = wallet.accounts[0]
  return {
    privateKey: account.stxPrivateKey,
    address: getStxAddress({ account, network: 'testnet' }),
  }
}

async function getNonce(address) {
  const data = await fetchJson(`${HIRO_API}/extended/v1/address/${address}/nonces`)
  return data.possible_next_nonce
}

// ---------------------------------------------------------------------------
// Deploy a single contract
// ---------------------------------------------------------------------------

async function deployContract(name, path, privateKey, address, nonce) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Deploying ${name}...`)
  console.log(`${'='.repeat(60)}`)

  const codeBody = readFileSync(path, 'utf8')
  console.log(`   Contract size: ${codeBody.length} bytes`)

  const transaction = await makeContractDeploy({
    contractName: name,
    codeBody,
    senderKey: privateKey,
    network: NETWORK,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Allow,
    fee: DEPLOY_FEE,
    nonce: BigInt(nonce),
  })

  const txId = transaction.txid()
  console.log(`   TX ID: ${txId}`)

  // Broadcast
  const hexTx = transaction.serialize()
  const binaryTx = Buffer.from(hexTx, 'hex')
  console.log(`   TX size: ${binaryTx.length} bytes`)

  const res = await fetch(`${HIRO_API}/v2/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: binaryTx,
  })
  const text = await res.text()
  console.log(`   Broadcast (${res.status}): ${text.slice(0, 200)}`)

  let data
  try { data = JSON.parse(text) } catch { data = { txid: text.trim().replace(/"/g, '') } }

  if (data.error) {
    console.error(`\n   DEPLOY FAILED: ${data.error}`)
    console.error(`   Reason: ${data.reason}`)
    if (data.reason_data) console.error(`   Details:`, JSON.stringify(data.reason_data, null, 2))
    process.exit(1)
  }

  console.log(`   Explorer: https://explorer.hiro.so/txid/${txId}?chain=testnet`)
  console.log(`   Contract: ${address}.${name}`)

  // Wait for confirmation
  console.log(`   Waiting for confirmation...`)
  let confirmed = false
  for (let i = 1; i <= 60; i++) {
    await sleep(30000)
    try {
      const status = await fetchJson(`${HIRO_API}/extended/v1/tx/${txId}`)
      if (status.tx_status === 'success') {
        confirmed = true
        console.log(`   CONFIRMED at block ${status.block_height}`)
        break
      } else if (status.tx_status?.startsWith('abort')) {
        console.error(`\n   ABORTED: ${status.tx_status}`)
        if (status.tx_result) console.error(`   Result:`, status.tx_result)
        process.exit(1)
      } else {
        console.log(`   [${i}/60] ${status.tx_status || 'pending'}...`)
      }
    } catch {
      console.log(`   [${i}/60] checking...`)
    }
  }

  if (!confirmed) {
    console.error('   Timed out. Check explorer manually.')
    process.exit(1)
  }

  return nonce + 1
}

// ---------------------------------------------------------------------------
// Contract call helper
// ---------------------------------------------------------------------------

async function callContract(address, contractName, functionName, args, privateKey, nonce) {
  console.log(`\n   Calling ${contractName}.${functionName}...`)

  const transaction = await makeContractCall({
    contractAddress: address,
    contractName,
    functionName,
    functionArgs: args,
    senderKey: privateKey,
    network: NETWORK,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Allow,
    fee: CALL_FEE,
    nonce: BigInt(nonce),
  })

  const txId = transaction.txid()
  const hexTx = transaction.serialize()
  const binaryTx = Buffer.from(hexTx, 'hex')

  const res = await fetch(`${HIRO_API}/v2/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: binaryTx,
  })
  const text = await res.text()

  let data
  try { data = JSON.parse(text) } catch { data = { txid: text.trim().replace(/"/g, '') } }

  if (data.error) {
    console.error(`   CALL FAILED: ${data.error} -- ${data.reason}`)
    if (data.reason_data) console.error(`   Details:`, JSON.stringify(data.reason_data, null, 2))
    return { ok: false, nonce }
  }

  console.log(`   TX: ${txId}`)
  console.log(`   Explorer: https://explorer.hiro.so/txid/${txId}?chain=testnet`)

  // Wait for confirmation (shorter timeout for calls)
  for (let i = 1; i <= 40; i++) {
    await sleep(15000)
    try {
      const status = await fetchJson(`${HIRO_API}/extended/v1/tx/${txId}`)
      if (status.tx_status === 'success') {
        console.log(`   CONFIRMED`)
        return { ok: true, nonce: nonce + 1 }
      } else if (status.tx_status?.startsWith('abort')) {
        console.error(`   ABORTED: ${status.tx_status}`)
        if (status.tx_result) console.error(`   Result:`, JSON.stringify(status.tx_result))
        return { ok: false, nonce: nonce + 1 }
      } else {
        console.log(`   [${i}/40] ${status.tx_status || 'pending'}...`)
      }
    } catch {
      console.log(`   [${i}/40] checking...`)
    }
  }

  console.warn('   Timed out waiting for call confirmation.')
  return { ok: false, nonce: nonce + 1 }
}

// ---------------------------------------------------------------------------
// Fetch current BTC price from Pyth
// ---------------------------------------------------------------------------

async function fetchBtcPrice() {
  console.log('   Fetching BTC price from Pyth...')
  const res = await fetch('https://hermes.pyth.network/v2/updates/price/latest?ids[]=e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43')
  const data = await res.json()
  const p = data.parsed?.[0]?.price
  if (!p?.price || p?.expo === undefined) throw new Error('Could not fetch BTC price from Pyth')
  const priceUsd = parseFloat(p.price) * Math.pow(10, p.expo)
  const priceCents = Math.round(priceUsd * 100)
  console.log(`   BTC price: $${priceUsd.toFixed(2)} (${priceCents} cents)`)
  return priceCents
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('='.repeat(60))
  console.log('  PREDIX v3 + GATEWAY v2 -- TESTNET DEPLOY')
  console.log('='.repeat(60))

  const { privateKey, address } = await initWallet()
  console.log(`\nDeployer: ${address}`)
  console.log(`Hiro API: ${HIRO_API}`)

  // Step 0: ASCII scan
  console.log('\n--- ASCII Scan ---')
  let hasIssues = false
  for (const c of CONTRACTS) {
    const issues = asciiScan(c.path)
    if (issues.length > 0) {
      hasIssues = true
      console.error(`   ${c.path}: ${issues.length} non-ASCII characters found!`)
      for (const issue of issues.slice(0, 5)) {
        console.error(`      Line ${issue.line}, Col ${issue.col}: '${issue.char}' (U+${issue.code.toString(16).padStart(4, '0')})`)
      }
    } else {
      console.log(`   ${c.path}: OK (pure ASCII)`)
    }
  }
  if (hasIssues) {
    console.error('\nFix non-ASCII characters before deploying!')
    process.exit(1)
  }

  let nonce = await getNonce(address)
  console.log(`Current nonce: ${nonce}`)

  // Step 1-2: Deploy contracts
  if (!SKIP_DEPLOY) {
    for (const c of CONTRACTS) {
      nonce = await deployContract(c.name, c.path, privateKey, address, nonce)
    }
    console.log('\n--- Both contracts deployed! ---')
    console.log(`   predixv3:  ${address}.predixv3`)
    console.log(`   gatewayv2: ${address}.gatewayv2`)
  } else {
    console.log('\n--- SKIP_DEPLOY=1: Skipping contract deployment ---')
  }

  // Step 3-7: Setup calls
  if (!SKIP_SETUP) {
    console.log('\n--- Running setup calls ---')
    console.log(`   Using deployer wallet for all roles: ${address}`)

    // Refresh nonce
    nonce = await getNonce(address)

    // 3. set-gateway-bootstrap (predixv3 -- one-shot, no timelock)
    //    Points predixv3 to the just-deployed gatewayv2
    const gatewayPrincipal = contractPrincipalCV(address, 'gatewayv7')
    const r0 = await callContract(address, 'predixv8', 'set-gateway-bootstrap', [gatewayPrincipal], privateKey, nonce)
    if (r0.ok) {
      console.log(`   [1/5] set-gateway-bootstrap(${address}.gatewayv2) -- OK`)
    } else {
      console.warn(`   [1/5] set-gateway-bootstrap FAILED (may already be set)`)
    }
    nonce = r0.nonce

    // 4. set-initial-price (predixv3, deployer-only, one-shot)
    const btcPrice = await fetchBtcPrice()
    const r1 = await callContract(address, 'predixv8', 'set-initial-price', [uintCV(btcPrice)], privateKey, nonce)
    if (r1.ok) {
      console.log(`   [2/5] set-initial-price(${btcPrice}) -- OK`)
    } else {
      console.warn(`   [2/5] set-initial-price FAILED (may already be set -- one-shot)`)
    }
    nonce = r1.nonce

    // 5. set-fee-recipient (predixv3, deployer-only)
    //    Using deployer wallet as fee-recipient (same wallet for testnet)
    const r2 = await callContract(address, 'predixv8', 'set-fee-recipient', [standardPrincipalCV(address)], privateKey, nonce)
    if (r2.ok) {
      console.log(`   [3/5] set-fee-recipient(${address}) -- OK`)
    } else {
      console.warn(`   [3/5] set-fee-recipient FAILED`)
    }
    nonce = r2.nonce

    // 6. set-sponsor on gateway (gatewayv2, deployer-only)
    //    Using deployer wallet as sponsor (same wallet for testnet)
    const r3 = await callContract(address, 'gatewayv7', 'set-sponsor', [standardPrincipalCV(address)], privateKey, nonce)
    if (r3.ok) {
      console.log(`   [4/5] gatewayv7.set-sponsor(${address}) -- OK`)
    } else {
      console.warn(`   [4/5] gatewayv7.set-sponsor FAILED`)
    }
    nonce = r3.nonce

    // 7. seed-jackpot (predixv3, deployer-only)
    //    $200 = 200_000_000 micro-tokens (6 decimals)
    //    NOTE: deployer must have >= 200 USDCx tokens. Mint first if needed.
    const JACKPOT_SEED = 200_000_000
    const r4 = await callContract(address, 'predixv8', 'seed-jackpot', [uintCV(JACKPOT_SEED)], privateKey, nonce)
    if (r4.ok) {
      console.log(`   [5/5] seed-jackpot(${JACKPOT_SEED}) -- OK ($200 USDCx)`)
    } else {
      console.warn(`   [5/5] seed-jackpot FAILED (deployer needs >= 200 USDCx tokens)`)
    }
    nonce = r4.nonce

    console.log('\n--- Setup complete ---')
  } else {
    console.log('\n--- SKIP_SETUP=1: Skipping setup calls ---')
  }

  // Summary
  console.log('\n' + '='.repeat(60))
  console.log('  DEPLOY SUMMARY')
  console.log('='.repeat(60))
  console.log(`  Deployer:   ${address}`)
  console.log(`  predixv3:   ${address}.predixv3`)
  console.log(`  gatewayv2:  ${address}.gatewayv2`)
  console.log(`  test-usdcx: ${address}.test-usdcx (pre-existing)`)
  console.log('')
  console.log('  Update .env.local:')
  console.log(`    NEXT_PUBLIC_BITPREDIX_CONTRACT_ID=${address}.predixv3`)
  console.log(`    NEXT_PUBLIC_GATEWAY_CONTRACT_ID=${address}.gatewayv2`)
  console.log(`    NEXT_PUBLIC_TEST_USDCX_CONTRACT_ID=${address}.test-usdcx`)
  console.log('')
  console.log('  Then: npm run build && deploy to Vercel')
  console.log('='.repeat(60))
}

main().catch(err => {
  console.error('\nFATAL:', err)
  process.exit(1)
})
