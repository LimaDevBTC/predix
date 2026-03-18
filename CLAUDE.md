# Predix -- Prediction Market on Stacks

## Overview
Prediction market where users bet on 1-minute BTC price movements (UP/DOWN). Built on Stacks testnet with sponsored transactions (users pay zero gas). Gateway-only architecture with automated settlement.

## Stack
- **Frontend**: Next.js 14 (App Router), React 19, TailwindCSS
- **Blockchain**: Stacks testnet (Clarity smart contracts, post-Nakamoto ~10s blocks)
- **Oracle**: Pyth Network (Hermes SSE for live prices, Benchmarks API for settlement)
- **Token**: test-usdcx (SIP-010, 6 decimals)
- **Wallet**: @stacks/connect (Xverse)
- **KV Store**: Upstash Redis (optimistic state, nonce tracking, open prices, jackpot tickets)
- **Deploy**: Vercel (serverless)

## Active Contracts (testnet)
| Contract | Address | Purpose |
|---|---|---|
| **predixv8** | `ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK.predixv8` | Main market + jackpot treasury |
| **gatewayv7** | `ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK.gatewayv7` | Sponsor-only proxy |
| **test-usdcx** | `ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK.test-usdcx` | Betting token |

- **Deployer/Sponsor**: `ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK` (same wallet for testnet)
- Contract IDs configured via env vars (fail-fast via `lib/config.ts`)

---

## Architecture Principles

| Principle | Implementation |
|---|---|
| **Gateway-only** | ALL interactions (bets + settlement) go through gatewayv7. predixv8 rejects direct calls. |
| **Sponsor-only settlement** | Users never claim. Cron resolver settles rounds and distributes payouts automatically. |
| **On-chain jackpot** | 1% of fees stays in contract as jackpot treasury. Ticket logic off-chain (Redis). |
| **Pre-settlement window** | Bets close at 50s. Last 10s for server-side computation. |
| **Price bounds** | Contract rejects settlement prices diverging >1% from last-known-price. |
| **Timelocks** | `set-gateway` and `set-sponsor` require 144-block delay (~24h). |

## Data Flow

```
BETS:
  User wallet -> Xverse sign -> /api/sponsor -> Gateway -> predixv8.place-bet

SETTLEMENT (automatic, every minute):
  Vercel Cron -> /api/cron/resolve -> Pyth Benchmarks
    -> Gateway -> predixv8.resolve-and-distribute

JACKPOT DRAW (daily 21h ET):
  Vercel Cron -> /api/cron/jackpot-draw -> Bitcoin block hash
    -> Gateway -> predixv8.pay-jackpot-winner
```

---

## Round Mechanics
- **Duration**: 60 seconds (`round-id = Math.floor(timestamp / 60)`)
- **Trading window**: 50 seconds (closes 10s before round end)
- **Open price**: First-write-wins in Redis (canonical for all clients)
- **Settlement**: Cron fetches Pyth Benchmarks prices, calls `resolve-and-distribute` atomically
- **Payout**: `(user_amount / winning_pool) * total_pool - 3% fee`
- **Fee split**: 2% to fee-recipient (on-chain) + 1% stays as jackpot treasury (on-chain)
- **Hedging**: Users can bet UP and DOWN in same round (bets accumulate per side)

## Smart Contract Architecture

### predixv8.clar (gateway-only)

**Data Maps:**
```clarity
rounds { round-id: uint }
  -> { total-up, total-down, price-start, price-end, resolved }

bets { round-id: uint, user: principal, side: (string-ascii 4) }
  -> { amount: uint, claimed: bool }

round-bettors { round-id: uint }
  -> { bettors: (list 200 principal) }
```

**Public Functions (all gateway-only):**
- `place-bet(round-id, side, amount)` -- Validates timing, transfers tokens, accumulates bet
- `resolve-and-distribute(round-id, price-start, price-end)` -- Atomic resolve + payout + fee split
- `pay-jackpot-winner(winner, amount)` -- Transfer from jackpot treasury to winner
- `seed-jackpot(amount)` -- Deployer deposits tokens into jackpot fund
- `set-initial-price(price)` -- One-shot bootstrap for price bounds
- `set-gateway-bootstrap(new-gateway)` -- One-shot gateway setup (no timelock)
- `schedule-gateway / activate-gateway` -- Timelocked gateway upgrade (144 blocks)
- `schedule-sponsor / activate-sponsor` -- Timelocked sponsor change
- `set-fee-recipient(new)` -- Change fee recipient (deployer-only)
- `set-paused(bool)` -- Emergency pause
- `emergency-withdraw` -- Max 50% per execution, requires paused 200+ blocks

**Constants:**
- `MIN_BET = u1000000` (1 USDCx), `FEE_BPS = u300` (3%)
- `FEE_OPS_BPS = u200` (2% ops), `FEE_JACKPOT_BPS = u100` (1% jackpot)
- `TRADING_WINDOW = u50`, `ROUND_DURATION = u60`
- `PRICE_BOUND_BPS = u100` (1%), `TIMELOCK_BLOCKS = u144` (~24h)

### gatewayv7.clar (thin proxy)
- `place-bet` -- Any user (via sponsor), round sanity check, not paused
- `resolve-and-distribute` -- Sponsor-only
- `pay-jackpot-winner` -- Sponsor-only
- `set-sponsor` / `set-paused` -- Deployer-only

---

## Project Structure

### Core Files
| File | Purpose |
|---|---|
| `components/MarketCardV4.tsx` | Main betting UI |
| `lib/config.ts` | Centralized network + contract config (fail-fast) |
| `lib/pool-store.ts` | Upstash Redis KV abstraction |
| `lib/sponsored-tx.ts` | Sponsored transaction helper |
| `lib/positions.ts` | localStorage trade tracking (network-prefixed, 7-day TTL) |
| `lib/jackpot.ts` | Hybrid jackpot: on-chain treasury + off-chain tickets |
| `lib/alerting.ts` | Discord webhook + console alerting |
| `lib/hiro.ts` | Hiro API wrapper (dynamic testnet/mainnet) |
| `lib/pyth.ts` | Pyth price feed (SSE + Benchmarks) |

### API Routes
| Route | Method | Purpose |
|---|---|---|
| `/api/round` | GET | Current round data + pool state + jackpot balance (polled 1s) |
| `/api/open-price` | GET/POST | Canonical open price (first-write-wins) |
| `/api/pool-update` | POST | Optimistic bet broadcast to KV |
| `/api/sponsor` | POST | Sponsor + broadcast signed tx (rate limited, body size limited) |
| `/api/allowance-status` | GET | Check token approval status |
| `/api/mint-status` | GET | Check mint eligibility |
| `/api/health` | GET | Health check (Redis, Hiro, sponsor balance, jackpot) |
| `/api/jackpot/status` | GET | Jackpot balance, tickets, countdown |
| `/api/jackpot/history` | GET | Last 7 draw results |
| `/api/cron/resolve` | GET | Settlement cron (every minute, CRON_SECRET auth) |
| `/api/cron/jackpot-draw` | GET | Daily jackpot draw (21h ET, CRON_SECRET auth) |

### Pages
| Page | Purpose |
|---|---|
| `/` | Main market (MarketCardV4) |
| `/jackpot` | Jackpot treasury, tickets, draw history, rules |
| `/history` | Round explorer |
| `/leaderboard` | Trader rankings |
| `/profile/[address]` | Wallet profile + bet history |

### Scripts
| Script | Purpose |
|---|---|
| `scripts/deploy-predixv3.mjs` | Deploy predixv8 + gatewayv7 + setup calls |
| `scripts/resolver-daemon.mjs` | Fallback settlement daemon (Railway/Render) |

---

## Key Architecture Patterns

### 1. Gateway-Only + Sponsor Settlement
Users never interact with predixv8 directly. All calls go through gatewayv7.
- Bets: User -> Xverse sign -> `/api/sponsor` -> Gateway -> predixv8
- Settlement: Cron -> `/api/sponsor` -> Gateway -> predixv8
- Users never claim. Payouts are pushed automatically.

### 2. Sponsored Transactions
Users don't pay gas. Flow:
1. Client builds unsigned tx with `sponsored: true, fee: 0`
2. Wallet signs tx
3. Client sends signed hex to `/api/sponsor`
4. Server validates (contract + function allowlist), adds sponsorship, broadcasts
5. Nonce tracking: Redis lock + KV nonce prevents `ConflictingNonceInMempool`

### 3. On-Chain Jackpot + Off-Chain Tickets
- **On-chain**: 1% of fees stays in contract (`jackpot-balance` data-var). `pay-jackpot-winner` transfers from treasury.
- **Off-chain (Redis)**: Ticket tracking (first/largest bettors, multipliers 1x/2x/4x), daily draw logic.
- **Draw**: Daily 21h ET, winner picked via Bitcoin block hash, prize = 10% of treasury.

### 4. Cross-Device Sync (Polling + KV)
- Clients poll `/api/round` every 1 second
- On-chain state from Hiro API merged with optimistic KV state
- Merge strategy: `max(on-chain, optimistic)` for pool totals

### 5. Circuit Breaker
Cron validates prices before settlement:
- Price change > 0.5% in 60s -> skip round
- Hermes/Benchmarks divergence > 0.3% -> skip round
- Price outside $10k-$500k -> skip round
- Contract enforces 1% bound as second layer of defense

---

## Environment Variables
```
NEXT_PUBLIC_STACKS_NETWORK=testnet
NEXT_PUBLIC_BITPREDIX_CONTRACT_ID=ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK.predixv8
NEXT_PUBLIC_GATEWAY_CONTRACT_ID=ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK.gatewayv7
NEXT_PUBLIC_TEST_USDCX_CONTRACT_ID=ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK.test-usdcx
ORACLE_MNEMONIC=<sponsor wallet mnemonic>
UPSTASH_REDIS_REST_URL=<upstash url>
UPSTASH_REDIS_REST_TOKEN=<upstash token>
HIRO_API_KEY=<hiro api key>
CRON_SECRET=<cron auth secret>
```

## Development
```bash
npm run dev      # Start dev server
npm run build    # Production build
npm run test     # Run tests (vitest)
```

## Deploy Gotchas
- **Clarity contracts must be pure ASCII** -- em-dashes, curly quotes cause broadcast errors
- **`block-height` vs `stacks-block-height`** -- Clarity 3+ uses `stacks-block-height`. Using `block-height` causes silent deploy abort.
- **Deploy script**: use `fetch` for broadcast (not `curl`)
- **Nonce conflicts**: Rapid sequential bets require KV-based nonce tracking + Redis lock
- **Gateway init**: predixv8 initializes gateway as DEPLOYER. Must call `set-gateway-bootstrap` after gatewayv7 is deployed.

## Tailwind Custom Colors
```
bitcoin: '#F7931A'    up: '#22C55E'    down: '#EF4444'
```

## Fonts
- Sans: Outfit
- Mono: JetBrains Mono
