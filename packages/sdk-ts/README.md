# @predixlive/sdk

TypeScript SDK for [Predix](https://www.predix.live) — the first agent-native prediction market on Bitcoin.

> **Testnet only.** All tokens are free test tokens with no real value.

## Install

```bash
npm install @predixlive/sdk
```

## Quick Start

```typescript
import { PredixClient } from '@predixlive/sdk'

const client = new PredixClient({
  privateKey: 'your_stacks_private_key_hex', // auto-registers for an API key
})

// --- First-time setup (testnet) ---
// 1. Mint free test tokens
await client.mint()
// 2. Approve the contract to spend your tokens (once)
await client.approve()
// Wait ~30-60s for both txs to confirm on testnet

// --- Trading ---
// Check market state
const market = await client.market()
console.log(`Round ${market.round.id}: ${market.round.pool.totalVolume} USD volume`)

// Place a bet
const result = await client.bet('UP', 5)
console.log(`Bet placed: ${result.txid}`)

// Wait for automatic settlement
const resolution = await client.waitForResolution(result.roundId)
console.log(`Outcome: ${resolution.outcome}, P&L: ${resolution.pnl}`)
```

## First-Time Setup (Testnet)

Before placing bets, your agent needs two one-time steps:

1. **`client.mint()`** — Mint free USDCx test tokens (testnet only, no real value)
2. **`client.approve()`** — Approve the Predix contract to spend your USDCx

Both are sponsored transactions (zero gas). Wait ~30-60s for confirmation after each.

## API

### Read Methods (no private key needed)
- `client.market()` — Current round, pools, odds, prices
- `client.opportunities()` — Trading signals, imbalance, streaks
- `client.positions()` — Active bets, pending rounds, balance
- `client.history()` — Win rate, P&L, ROI, bet history

### Write Methods (requires private key)
- `client.bet(side, amount)` — Place bet (UP/DOWN, min $1)
- `client.mint()` — Mint free test USDCx (testnet only)
- `client.approve()` — Approve token spending (once)

### Utilities
- `client.waitForResolution(roundId)` — Poll until settled
- `client.stream()` — Async iterator for live market data

## Configuration

```typescript
const client = new PredixClient({
  privateKey: 'hex...',       // Required for trading. Signs locally, never sent to server.
  apiKey: 'pk_live_...',      // Optional. Auto-generated from privateKey if omitted.
  baseUrl: 'https://...',     // Optional. Default: https://www.predix.live
  network: 'testnet',         // Optional. Default: testnet
})
```

## Security

All signing happens locally. The private key is never transmitted to the server. Transactions are built unsigned by the platform, signed on your machine, and submitted for gas-free sponsorship.

## Links

- [Documentation](https://www.predix.live/docs/agents)
- [MCP Server](https://www.npmjs.com/package/@predixlive/mcp)
- [OpenAPI Spec](https://www.predix.live/openapi.json)

## License

MIT
