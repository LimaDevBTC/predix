# Predix — Prediction Market on Stacks

## Overview
Prediction market where users bet on 1-minute BTC price movements (UP/DOWN). Built on Stacks testnet with sponsored transactions (users pay zero gas).

## Stack
- **Frontend**: Next.js 14 (App Router), React 19, TailwindCSS
- **Blockchain**: Stacks testnet (Clarity smart contracts)
- **Oracle**: Pyth Network (Hermes SSE for live prices, Benchmarks API for historical)
- **Token**: test-usdcx (SIP-010, 6 decimals)
- **Wallet**: @stacks/connect (Xverse)
- **KV Store**: Upstash Redis (optimistic state, nonce tracking, open prices)
- **Deploy**: Vercel (serverless)

## Active Contracts (testnet)
| Contract | Address | Purpose |
|---|---|---|
| **predixv1** | `ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK.predixv1` | Main market (active) |
| **test-usdcx** | `ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK.test-usdcx` | Betting token |

- **Deployer**: `ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK`
- Contract ID configured via `.env.local` → `NEXT_PUBLIC_BITPREDIX_CONTRACT_ID`
- Previous versions: bitpredix-v5, bitpredix-v6 (deprecated, kept as reference)

---

## Round Mechanics
- **Duration**: 60 seconds (`round-id = Math.floor(timestamp / 60)`)
- **Trading window**: 55 seconds (closes 5s before round end)
- **Open price**: First-write-wins in Redis (canonical for all clients)
- **Settlement**: Frontend fetches Pyth prices, first claim resolves round on-chain
- **Payout**: `(user_amount / winning_pool) * total_pool - 3% fee`
- **Hedging**: Users can bet UP and DOWN in same round (bets accumulate per side)

## Smart Contract Architecture (`contracts/predixv1.clar`)

### Data Maps
```clarity
rounds { round-id: uint }
  → { total-up, total-down, price-start, price-end, resolved }

bets { round-id: uint, user: principal, side: (string-ascii 4) }
  → { amount: uint, claimed: bool }

user-pending-rounds { user: principal }
  → { round-ids: (list 50 uint) }

round-bettors { round-id: uint }
  → { bettors: (list 200 principal) }
```

### Public Functions
- `place-bet(round-id, side, amount)` — Validates timing, transfers tokens, accumulates bet
- `claim-round-side(round-id, side, price-start, price-end)` — Per-side claim, resolves round if first
- `claim-on-behalf(round-id, user, side, price-start, price-end)` — Deployer-only auto-claim

### Read-Only Functions
- `get-bet(round-id, user, side)` — Single bet lookup
- `get-user-bets(round-id, user)` — Returns both UP and DOWN bets
- `get-round(round-id)` — Round data
- `get-user-pending-rounds(user)` — List of unclaimed round IDs

### Constants
- `MIN_BET = u1000000` (1 USDCx)
- `FEE_BPS = u300` (3%)
- `ROUND_DURATION = u60`
- `TRADING_WINDOW = u55`

---

## Project Structure

### Core Files
| File | Purpose |
|---|---|
| `components/MarketCardV4.tsx` | Main betting UI (~1200 lines) |
| `components/ClaimButton.tsx` | Claim/settlement button |
| `lib/pyth.ts` | Pyth price feed (SSE + Benchmarks) |
| `lib/amm.ts` | LMSR pricing (b = 3000 + volume) |
| `lib/pool-store.ts` | Upstash Redis KV abstraction |
| `lib/sponsored-tx.ts` | Sponsored transaction helper |
| `lib/positions.ts` | localStorage trade tracking |
| `lib/usePendingRounds.ts` | React hook for pending claims |
| `lib/types.ts` | TypeScript interfaces |
| `instrumentation.ts` | Server-side round monitor (captures open price) |

### API Routes
| Route | Method | Purpose |
|---|---|---|
| `/api/round` | GET | Current round data + pool state (polled every 1s) |
| `/api/open-price` | GET/POST | Canonical open price (first-write-wins) |
| `/api/pool-update` | POST | Optimistic bet broadcast to KV |
| `/api/sponsor` | POST | Sponsor + broadcast signed tx |
| `/api/stacks-read` | POST | Proxy for read-only contract calls |
| `/api/allowance-status` | GET | Check token approval status |
| `/api/mint-status` | GET | Check mint eligibility |
| `/api/pyth-price` | GET | Historical Pyth OHLC data |

### Components
| Component | Purpose |
|---|---|
| `MarketCardV4Wrapper.tsx` | Dynamic import (CSR only) |
| `ConnectWalletButton.tsx` | Xverse wallet connection |
| `MintTestTokens.tsx` | Onboarding: mint test tokens |
| `BtcPriceChart.tsx` | lightweight-charts price chart |
| `TradeTape.tsx` | Scrolling recent trades ticker |
| `Countdown.tsx` | Round timer |
| `ResolutionModal.tsx` | Win/loss result display |
| `AppHeader.tsx` | Navigation bar |

### Scripts
| Script | Purpose |
|---|---|
| `scripts/mint-test-tokens.js` | Mint tokens for testing |
| `scripts/resolver-daemon.mjs` | Auto-settle rounds |
| `scripts/oracle-daemon.mjs` | Oracle price daemon |
| `scripts/cron-oracle.mjs` | Cron-based oracle |

---

## Key Architecture Patterns

### 1. Cross-Device Sync (Polling + KV)
SSE doesn't work on multi-instance Vercel serverless. Solution:
- Clients poll `/api/round` every 1 second
- On-chain state from Hiro API merged with optimistic KV state
- Merge strategy: `max(on-chain, optimistic)` for pool totals
- Trade dedup by ID prevents duplicates across polling + client broadcast

### 2. Sponsored Transactions
Users don't pay gas. Flow:
1. Client builds unsigned tx with `sponsored: true, fee: 0`
2. Wallet signs tx
3. Client sends signed hex to `/api/sponsor`
4. Server validates (contract + function allowlist), adds sponsorship, broadcasts
5. **Nonce tracking**: Redis lock + KV nonce prevents `ConflictingNonceInMempool`

### 3. Deterministic Settlement
- **Open price**: `instrumentation.ts` captures on server startup, also first client POST wins
- **Close price**: Pyth Benchmarks API (deterministic, same for all)
- Contract stores prices on first claim (subsequent claims use stored values)

### 4. LMSR AMM Pricing
```
b = B0 (3000) + volumeTraded
priceUp = exp(qUp/b) / (exp(qUp/b) + exp(qDown/b))
```
Higher volume = lower price impact. Used for UI display only (contract uses simple pool ratio for payouts).

---

## Environment Variables (`.env.local`)
```
NEXT_PUBLIC_STACKS_NETWORK=testnet
NEXT_PUBLIC_BITPREDIX_CONTRACT_ID=ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK.predixv1
NEXT_PUBLIC_TEST_USDCX_CONTRACT_ID=ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK.test-usdcx
ORACLE_MNEMONIC=<deployer mnemonic for sponsoring>
UPSTASH_REDIS_REST_URL=<upstash url>
UPSTASH_REDIS_REST_TOKEN=<upstash token>
```

## Development
```bash
npm run dev      # Start dev server
npm run build    # Production build
npm run test     # Run tests (vitest)
```

## Deploy Gotchas
- **Clarity contracts must be pure ASCII** — em-dashes, curly quotes cause broadcast errors
- **Deploy script**: use `fetch` for broadcast (not `curl`)
- **.env.local** values with spaces break `source .env.local` — pass directly as env vars
- **Nonce conflicts**: Rapid sequential bets require KV-based nonce tracking + Redis lock

## Tailwind Custom Colors
```
bitcoin: '#F7931A'    up: '#22C55E'    down: '#EF4444'
```

## Fonts
- Sans: Outfit
- Mono: JetBrains Mono
