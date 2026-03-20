import { NextResponse } from 'next/server'
import {
  makeContractCall,
  PostConditionMode,
  uintCV,
  standardPrincipalCV,
} from '@stacks/transactions'
import { STACKS_TESTNET, STACKS_MAINNET } from '@stacks/network'
import { generateWallet, getStxAddress } from '@stacks/wallet-sdk'
import {
  getJackpotBalance,
  getTotalTickets,
  resolveTicketOwner,
  calculatePrize,
  saveDrawResult,
  drawPeriodEndingET,
  type DrawResult,
} from '@/lib/jackpot'
import { NETWORK_NAME, GATEWAY_CONTRACT, splitContractId } from '@/lib/config'
import { HIRO_API, hiroHeaders, disableApiKey } from '@/lib/hiro'
import { alert } from '@/lib/alerting'
import { dispatchWebhookEvent } from '@/lib/agent-webhooks'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const [GATEWAY_ADDRESS, GATEWAY_NAME] = splitContractId(GATEWAY_CONTRACT)
const STACKS_NETWORK = NETWORK_NAME === 'mainnet' ? STACKS_MAINNET : STACKS_TESTNET
const TX_FEE = BigInt(process.env.SPONSOR_TX_FEE || '50000')

/**
 * Daily jackpot draw -- runs at 21h ET via Vercel Cron.
 * Uses first Bitcoin block hash after 21h ET as randomness source.
 * Calls gateway.pay-jackpot-winner to transfer prize from contract treasury.
 */
export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // 1. Get the draw period that's ending now (today's calendar date in ET).
    // Tickets since last draw (21h yesterday → now) are stored under this date.
    const today = drawPeriodEndingET()
    const now = new Date()
    const etDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))

    // 2. Check total tickets
    const totalTickets = await getTotalTickets(today)
    if (!totalTickets || totalTickets === 0) {
      console.info('[JACKPOT] No tickets today, skipping draw')
      return NextResponse.json({ ok: true, skipped: true, reason: 'no_tickets' })
    }

    // 3. Get jackpot balance (from on-chain contract)
    const balance = await getJackpotBalance()
    if (balance <= 0) {
      console.info('[JACKPOT] Zero balance, skipping draw')
      return NextResponse.json({ ok: true, skipped: true, reason: 'zero_balance' })
    }

    // 4. Wait for first Bitcoin block after 21h ET
    const targetTimestamp = Math.floor(etDate.setHours(21, 0, 0, 0) / 1000)
    const block = await waitForBitcoinBlockAfter(targetTimestamp)
    if (!block) {
      await alert('WARN', 'Jackpot draw: could not find Bitcoin block after target time')
      return NextResponse.json({ ok: false, error: 'No Bitcoin block found' }, { status: 500 })
    }

    // 5. Calculate winner index
    const seed = BigInt('0x' + block.hash)
    const winnerIndex = seed % BigInt(totalTickets)

    // 6. Resolve ticket owner
    const winner = await resolveTicketOwner(today, winnerIndex)
    if (!winner) {
      await alert('WARN', 'Jackpot draw: could not resolve ticket owner')
      return NextResponse.json({ ok: false, error: 'Could not resolve winner' }, { status: 500 })
    }

    // 7. Calculate prize (10% of fund)
    const prize = calculatePrize(balance)

    // 8. Prepare draw result
    const result: DrawResult & { txId?: string; transferError?: string } = {
      date: today,
      blockHeight: block.height,
      blockHash: block.hash,
      totalTickets,
      winnerIndex: winnerIndex.toString(),
      winner,
      prize,
      jackpotBalanceAfter: balance - prize,
    }

    // 9. On-chain payment: call gateway.pay-jackpot-winner (contract transfers from treasury)
    let txId: string | null = null
    try {
      txId = await payJackpotWinner(winner, prize)
      result.txId = txId
      console.info(`[JACKPOT] pay-jackpot-winner broadcast: ${txId}`)
    } catch (e) {
      const transferErr = e instanceof Error ? e.message : String(e)
      console.error(`[JACKPOT] pay-jackpot-winner failed: ${transferErr}`)
      await alert('CRITICAL', `Jackpot prize payment failed: ${transferErr}`, {
        winner, prize, date: today,
      })
      result.transferError = transferErr
    }

    // 10. Save draw result (after payment attempt, so txId/error is captured)
    await saveDrawResult(result)

    // Dispatch webhook event (fire and forget)
    dispatchWebhookEvent('jackpot.drawn', {
      date: today,
      winner,
      prizeUsd: prize / 1e6,
      totalTickets,
      blockHash: block.hash,
      blockHeight: block.height,
      txId: txId || null,
    }).catch(() => {})

    // 11. Log and alert
    console.info(`[JACKPOT] Draw complete: winner=${winner} prize=${(prize / 1e6).toFixed(2)} USDCx txId=${txId}`)
    await alert('INFO', `Jackpot draw: ${winner} won ${(prize / 1e6).toFixed(2)} USDCx${txId ? ` tx=${txId}` : ''}`)

    return NextResponse.json({ ok: true, result })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await alert('CRITICAL', `Jackpot draw failed: ${msg}`)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// Sponsor wallet + on-chain jackpot payment
// ---------------------------------------------------------------------------

async function initWallet() {
  const mnemonic = process.env.SPONSOR_MNEMONIC || process.env.ORACLE_MNEMONIC
  if (!mnemonic) throw new Error('SPONSOR_MNEMONIC not configured')

  const wallet = await generateWallet({ secretKey: mnemonic, password: '' })
  const account = wallet.accounts[0]
  return {
    privateKey: account.stxPrivateKey,
    address: getStxAddress({ account, network: NETWORK_NAME }),
  }
}

async function getNonce(address: string): Promise<number> {
  const res = await fetch(`${HIRO_API}/extended/v1/address/${address}/nonces`, {
    headers: hiroHeaders(),
  })
  if (res.status === 429) disableApiKey()
  if (!res.ok) throw new Error(`Nonce fetch failed: HTTP ${res.status}`)
  const data = await res.json() as { possible_next_nonce: number }
  return data.possible_next_nonce
}

/**
 * Call gateway.pay-jackpot-winner to transfer prize from contract treasury to winner.
 * The contract holds the jackpot funds (1% of volume from each settled round).
 * Sponsor wallet signs the tx; gateway verifies sponsor; predixv3 transfers tokens.
 */
async function payJackpotWinner(winner: string, amount: number): Promise<string> {
  const { privateKey, address } = await initWallet()
  const nonce = await getNonce(address)

  const MAX_RETRIES = 3
  let currentNonce = nonce

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const tx = await makeContractCall({
      contractAddress: GATEWAY_ADDRESS,
      contractName: GATEWAY_NAME,
      functionName: 'pay-jackpot-winner',
      functionArgs: [
        standardPrincipalCV(winner),
        uintCV(amount),
      ],
      senderKey: privateKey,
      network: STACKS_NETWORK,
      postConditionMode: PostConditionMode.Allow,
      fee: TX_FEE,
      nonce: BigInt(currentNonce),
    })

    const hexTx = tx.serialize()
    const binaryTx = Buffer.from(hexTx, 'hex')

    const res = await fetch(`${HIRO_API}/v2/transactions`, {
      method: 'POST',
      headers: hiroHeaders({ 'Content-Type': 'application/octet-stream' }),
      body: binaryTx,
    })
    const text = await res.text()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any
    try { data = JSON.parse(text) } catch { data = { txid: text.trim().replace(/"/g, '') } }

    if (data.error) {
      const reason = data.reason as string
      const reasonData = data.reason_data as { expected?: number } | undefined

      if ((reason === 'BadNonce' || reason === 'ConflictingNonceInMempool') && attempt < MAX_RETRIES) {
        currentNonce = reasonData?.expected != null ? reasonData.expected : currentNonce + 1
        console.log(`[JACKPOT] Nonce error (${reason}), retrying with nonce=${currentNonce}`)
        continue
      }

      throw new Error(`pay-jackpot-winner broadcast failed: ${data.error} -- ${reason}`)
    }

    const txId = data.txid || data || tx.txid()
    return typeof txId === 'string' ? txId : String(txId)
  }

  throw new Error('Exhausted nonce retries for jackpot payment')
}

// ---------------------------------------------------------------------------
// Bitcoin block helper
// ---------------------------------------------------------------------------

interface BitcoinBlock {
  hash: string
  height: number
  timestamp: number
}

async function waitForBitcoinBlockAfter(targetTimestamp: number, timeoutMs = 15 * 60 * 1000): Promise<BitcoinBlock | null> {
  const start = Date.now()
  const pollInterval = 30_000 // 30s

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch('https://mempool.space/api/blocks/tip/hash')
      const tipHash = await res.text()
      const blockRes = await fetch(`https://mempool.space/api/block/${tipHash.trim()}`)
      const block = await blockRes.json() as { id: string; height: number; timestamp: number }

      if (block.timestamp >= targetTimestamp) {
        return { hash: block.id, height: block.height, timestamp: block.timestamp }
      }
    } catch {
      // mempool.space API error -- retry
    }

    await new Promise(r => setTimeout(r, pollInterval))
  }

  return null
}
