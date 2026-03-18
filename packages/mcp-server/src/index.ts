#!/usr/bin/env node

/**
 * Predix MCP Server — AI Agent integration for the Predix prediction market
 *
 * Tools:
 *   predix_market        — Current round state, odds, prices, volume
 *   predix_opportunities — Market signals and betting opportunities
 *   predix_place_bet     — Place a bet (UP or DOWN) on current round
 *   predix_positions     — View current positions and balance
 *   predix_history       — View historical performance and stats
 *   predix_mint_tokens   — Mint test tokens (testnet only)
 *   predix_approve       — Approve token spending for the contract
 *
 * Resources:
 *   predix://market/current — Live market data
 *   predix://rules          — Trading rules and mechanics
 *
 * Config (env vars):
 *   PREDIX_API_URL       — Base URL (default: https://www.predix.live)
 *   PREDIX_API_KEY       — Agent API key (pk_live_...)
 *   STACKS_PRIVATE_KEY   — Agent's Stacks private key (hex)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { fetchApi } from './lib/client.js'
import type {
  MarketResponse,
  BuildTxResponse,
  PositionsResponse,
  HistoryResponse,
  OpportunitiesResponse,
  SponsorResponse,
} from './lib/client.js'
import { getPublicKey, signTransaction, signMessage } from './lib/signer.js'
import { getStxAddress } from '@stacks/wallet-sdk'

function getPrivateKey(): string {
  const key = process.env.STACKS_PRIVATE_KEY
  if (!key) throw new Error('STACKS_PRIVATE_KEY env var not set')
  return key
}

function getAgentAddress(): string {
  return getStxAddress({
    account: { stxPrivateKey: getPrivateKey(), dataPrivateKey: '', appsKey: '', salt: '', index: 0 } as Parameters<typeof getStxAddress>[0]['account'],
    network: 'testnet',
  })
}

/**
 * Full bet flow: build-tx -> sign locally -> sponsor
 */
async function executeBet(side: 'UP' | 'DOWN', amount: number): Promise<{ txid: string; details: Record<string, unknown> }> {
  const privateKey = getPrivateKey()
  const publicKey = getPublicKey(privateKey)

  const buildRes = await fetchApi<BuildTxResponse>('/api/agent/build-tx', {
    method: 'POST',
    body: JSON.stringify({ action: 'place-bet', publicKey, params: { side, amount } }),
  })

  const signedHex = signTransaction(buildRes.txHex, privateKey)

  const sponsorRes = await fetchApi<SponsorResponse>('/api/sponsor', {
    method: 'POST',
    body: JSON.stringify({ txHex: signedHex }),
  })

  return { txid: sponsorRes.txid, details: buildRes.details }
}

async function executeAction(action: 'approve' | 'mint'): Promise<{ txid: string }> {
  const privateKey = getPrivateKey()
  const publicKey = getPublicKey(privateKey)

  const buildRes = await fetchApi<BuildTxResponse>('/api/agent/build-tx', {
    method: 'POST',
    body: JSON.stringify({ action, publicKey, params: {} }),
  })

  const signedHex = signTransaction(buildRes.txHex, privateKey)

  const sponsorRes = await fetchApi<SponsorResponse>('/api/sponsor', {
    method: 'POST',
    body: JSON.stringify({ txHex: signedHex }),
  })

  return { txid: sponsorRes.txid }
}

/**
 * Auto-register: if STACKS_PRIVATE_KEY is set but no PREDIX_API_KEY,
 * sign a registration message and call /api/agent/register to get a key.
 * Zero friction — agent only needs a private key.
 */
async function ensureApiKey(): Promise<void> {
  if (process.env.PREDIX_API_KEY) return // already configured

  const privateKey = process.env.STACKS_PRIVATE_KEY
  if (!privateKey) return // can't auto-register without a private key

  const address = getAgentAddress()
  const timestamp = Math.floor(Date.now() / 1000)
  const message = `Predix Agent Registration ${timestamp}`
  const signature = signMessage(message, privateKey)

  try {
    const res = await fetchApi<{ ok: boolean; apiKey?: string }>('/api/agent/register', {
      method: 'POST',
      body: JSON.stringify({ wallet: address, signature, message, name: 'MCP Agent' }),
    })

    if (res.apiKey) {
      process.env.PREDIX_API_KEY = res.apiKey
      console.error(`[predix] Auto-registered agent ${address} — API key set`)
    }
  } catch (err) {
    console.error('[predix] Auto-registration failed (continuing without key):', err instanceof Error ? err.message : err)
  }
}

// ---- MCP Server Setup ----

const server = new McpServer({
  name: 'predix',
  version: '0.2.0',
})

// ---- Resources ----

server.resource(
  'market-current',
  'predix://market/current',
  { description: 'Live market data updated every request', mimeType: 'application/json' },
  async (uri) => {
    const data = await fetchApi<MarketResponse>('/api/agent/market')
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] }
  }
)

server.resource(
  'rules',
  'predix://rules',
  { description: 'How the Predix prediction market works: round mechanics, fees, timing, payouts', mimeType: 'text/markdown' },
  async (uri) => {
    const rules = `# Predix Trading Rules

## Round Mechanics
- Rounds last **60 seconds** (round ID = Unix timestamp / 60)
- Trading closes **10 seconds before round end** (50s trading window)
- Bet on **UP** (BTC price goes up) or **DOWN** (BTC price goes down)

## Betting
- Minimum bet: **$1 USDCx**
- You can bet on both sides in the same round (bets accumulate per side)
- All transactions are **gas-free** (sponsored by the platform)

## Payouts
- Settlement is **automatic** — no claim needed
- Payout = (your_amount / winning_pool) * total_pool * 0.97
- Fee: **3%** (2% operations + 1% jackpot treasury)
- Tie (same open/close price): full refund, no fee

## Jackpot
- 1% of all fees stay in the on-chain jackpot treasury
- Bets in the first **20 seconds** of a round earn jackpot tickets
  - First bet in round: **4x tickets**
  - Largest bet in round: **2x tickets**
  - All other early bets: **1x ticket**
- Daily draw at **21:00 ET** — winner gets 10% of treasury
- Winner selected via Bitcoin block hash (verifiable randomness)

## Price Oracle
- Pyth Network (BTC/USD feed)
- Open price: first-write-wins from Pyth Hermes SSE
- Close price: Pyth Benchmarks API at round end

## Requirements
1. **Approve** the Predix contract to spend your USDCx (once)
2. **Mint** test tokens if your balance is low (testnet only)
3. **Place bet** within the 50-second trading window
`
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: rules }] }
  }
)

// ---- Tools ----

// -- predix_market --
server.tool(
  'predix_market',
  'Get current Predix market state: active round, pool sizes, odds, BTC price, payout multipliers, and jackpot info. Call this first to understand current conditions before placing a bet.',
  {},
  async () => {
    const data = await fetchApi<MarketResponse>('/api/agent/market')
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
  }
)

// -- predix_opportunities --
server.tool(
  'predix_opportunities',
  'Get computed market signals: pool imbalance (which side has better payout), price direction within round, volume level, jackpot early window status, and recent outcome streaks. Use this to inform betting decisions.',
  {},
  async () => {
    const data = await fetchApi<OpportunitiesResponse>('/api/agent/opportunities')
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
  }
)

// -- predix_place_bet --
server.tool(
  'predix_place_bet',
  'Place a bet on the current round. Builds an unsigned transaction server-side, signs it locally with your private key, and submits it for sponsored broadcast (zero gas). Returns transaction ID on success.',
  {
    side: z.enum(['UP', 'DOWN']).describe('Bet direction: UP (BTC price goes up) or DOWN (BTC price goes down)'),
    amount: z.number().min(1).describe('Bet amount in USD (minimum $1, uses USDCx token)'),
  },
  async ({ side, amount }) => {
    const result = await executeBet(side, amount)
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          txid: result.txid,
          side,
          amount,
          ...result.details,
          note: 'Bet placed! Settlement is automatic. Use predix_positions to check status.',
        }, null, 2)
      }]
    }
  }
)

// -- predix_positions --
server.tool(
  'predix_positions',
  'Get your current positions: active bets in current round, pending rounds, token balance. Settlement is automatic — no claim needed.',
  {},
  async () => {
    const address = getAgentAddress()
    const data = await fetchApi<PositionsResponse>(`/api/agent/positions?address=${address}`)
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
  }
)

// -- predix_history --
server.tool(
  'predix_history',
  'Get your betting history and performance stats: win rate, total P&L, ROI, best win, worst loss, current streak. Paginated.',
  {
    page: z.number().optional().default(1).describe('Page number'),
    pageSize: z.number().optional().default(20).describe('Results per page (max 50)'),
  },
  async ({ page, pageSize }) => {
    const address = getAgentAddress()
    const data = await fetchApi<HistoryResponse>(`/api/agent/history?address=${address}&page=${page}&pageSize=${pageSize}`)
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
  }
)

// -- predix_mint --
server.tool(
  'predix_mint',
  'Mint test USDCx tokens (testnet only). Use this to get tokens for betting if your balance is low.',
  {},
  async () => {
    const result = await executeAction('mint')
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          txid: result.txid,
          note: 'Mint submitted. Tokens appear after confirmation (~30-60s on testnet).',
        }, null, 2)
      }]
    }
  }
)

// -- predix_approve --
server.tool(
  'predix_approve',
  'Approve the Predix contract to spend your USDCx tokens. Required once before placing your first bet.',
  {},
  async () => {
    const result = await executeAction('approve')
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          txid: result.txid,
          note: 'Approval submitted. You can place bets after confirmation (~30-60s on testnet).',
        }, null, 2)
      }]
    }
  }
)

// ---- Start Server ----

async function main() {
  await ensureApiKey()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('Predix MCP Server running on stdio')
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
