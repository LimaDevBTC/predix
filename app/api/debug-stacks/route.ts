import { NextResponse } from 'next/server'
import {
  tupleCV,
  standardPrincipalCV,
  contractPrincipalCV,
  uintCV,
  cvToHex,
  serializeCV,
  makeUnsignedContractCall,
  PostConditionMode,
} from '@stacks/transactions'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Diagnostic endpoint: tests @stacks/transactions serialization on Vercel
 * GET /api/debug-stacks
 */
export async function GET() {
  const results: Record<string, unknown> = {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  }

  try {
    // 1. Test cvToHex with a tuple (same as allowance-status)
    const keyCV = tupleCV({
      owner: standardPrincipalCV('ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK'),
      spender: contractPrincipalCV('ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK', 'predixv8')
    })
    const keyHex = cvToHex(keyCV)
    results.keyHex = keyHex
    results.keyHexLength = keyHex.length
    // Known good value from local test:
    results.keyHexExpected = '0x0c00000002056f776e6572051a6f6a469df261c3f9e5a29366b50480d70d833991077370656e646572061a6f6a469df261c3f9e5a29366b50480d70d833991087072656469787638'
    results.keyHexMatch = keyHex === results.keyHexExpected

    // 2. Test map_entry call with this hex
    const mapRes = await fetch(
      'https://api.testnet.hiro.so/v2/map_entry/ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK/test-usdcx/allowances',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(keyHex),
      }
    )
    results.mapStatus = mapRes.status
    results.mapBody = await mapRes.text().then(t => t.slice(0, 200))

    // 3. Test serializeCV
    const principalHex = serializeCV(contractPrincipalCV('ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK', 'predixv8'))
    results.principalHex = principalHex
    results.principalHexExpected = '061a6f6a469df261c3f9e5a29366b50480d70d833991087072656469787638'
    results.principalMatch = principalHex === results.principalHexExpected

    // 4. Test makeUnsignedContractCall serialize
    const tx = await makeUnsignedContractCall({
      contractAddress: 'ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK',
      contractName: 'test-usdcx',
      functionName: 'approve',
      functionArgs: [
        contractPrincipalCV('ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK', 'predixv8'),
        uintCV(BigInt('1000000000000')),
      ],
      publicKey: '03cd2cfdbd2ad9332828a7a13ef62cb999e063421c708e863a7ffed71fb61c88c9',
      network: 'testnet',
      fee: 0,
      sponsored: true,
      postConditionMode: PostConditionMode.Allow,
    })
    const txHex = tx.serialize()
    results.txHexLength = txHex.length
    results.txHexFirst80 = txHex.slice(0, 80)
    // Known good from local:
    results.txHexExpectedFirst80 = '808000000005007321b74e2b6a7e949e6c4ad313'
    results.txHexStartMatch = txHex.startsWith('808000000005007321b74e2b6a7e949e6c4ad313')

    // 5. Check stacks/transactions version
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pkg = require('@stacks/transactions/package.json')
      results.stacksTxVersion = pkg.version
    } catch {
      results.stacksTxVersion = 'unknown'
    }

    // 6. Test direct broadcast of unsigned tx (will fail with signature error, but should be JSON)
    const txBytes = Buffer.from(txHex, 'hex')
    const broadcastRes = await fetch('https://api.testnet.hiro.so/v2/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: txBytes,
    })
    results.broadcastStatus = broadcastRes.status
    results.broadcastBody = await broadcastRes.text().then(t => t.slice(0, 300))

  } catch (err) {
    results.error = err instanceof Error ? err.message : String(err)
    results.stack = err instanceof Error ? err.stack?.split('\n').slice(0, 5) : undefined
  }

  return NextResponse.json(results, { status: 200 })
}
