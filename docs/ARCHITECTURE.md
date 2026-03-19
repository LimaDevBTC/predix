# Architecture

This document describes the system architecture of Predix, a prediction market for 1-minute BTC price movements built on Stacks and finalized on Bitcoin.

## System Overview

Predix consists of four layers: the client layer (browsers and AI agents), the platform layer (Next.js serverless functions), the state layer (Redis and Stacks blockchain), and the oracle layer (Pyth Network).

```
 CLIENTS                     PLATFORM                    STATE                 ORACLE
+------------------+   +------------------------+   +----------------+   +--------------+
|                  |   |                        |   |                |   |              |
| Browser (Xverse) |-->| Next.js API Routes     |-->| Stacks Testnet |   | Pyth Network |
| AI Agent (SDK)   |-->|   /api/sponsor         |   |  predixv7      |   |  Hermes SSE  |
| MCP Client       |-->|   /api/agent/*         |   |  gatewayv6     |   |  Benchmarks  |
|                  |   |   /api/cron/*          |   |  test-usdcx    |   |              |
+------------------+   |                        |   +----------------+   +--------------+
                       | @predix/mcp (stdio)    |   |                |         |
                       |                        |   | Upstash Redis  |         |
                       +------------------------+   |  pools, nonces |         |
                              |                     |  tickets, keys |         |
                              +-------------------->|                |<--------+
                                                    +----------------+
```

## Core Design Decisions

### 1. Gateway-Only Architecture

Every interaction with the market contract routes through a thin gateway proxy (`gatewayv6`). The market contract (`predixv7`) rejects all direct calls.

**Why:** This pattern provides a single enforcement point for access control, enables sponsor-only settlement, supports timelocked upgrades without redeploying the market contract, and allows the gateway to be paused independently.

```
User/Agent  -->  gatewayv6.place-bet(...)  -->  predixv7.place-bet(...)
                       |
                 [round sanity check]
                 [pause check]
                 [sponsor check for settlement]
```

### 2. Sponsored Transactions (Zero Gas)

Users and agents never pay gas. The platform sponsors every transaction.

**Flow:**
1. Client builds an unsigned transaction with `sponsored: true, fee: 0`.
2. User or agent signs the transaction locally (private key never leaves the client).
3. Signed hex is sent to `/api/sponsor`.
4. Server validates the transaction (contract allowlist, function allowlist), adds sponsorship (sets fee, sets sponsor), and broadcasts to the Stacks network.
5. Server tracks nonce in Redis to prevent `ConflictingNonceInMempool` errors during rapid submissions.

**Why:** Gas fees are the primary friction for onboarding non-crypto users and AI agents. Sponsored transactions eliminate this barrier entirely.

### 3. Automatic Settlement (No Claims)

Users never claim winnings. A Vercel cron job runs every 60 seconds, fetches the settlement price from Pyth Benchmarks, and calls `resolve-and-distribute` on-chain. This single contract call atomically resolves the round, computes payouts, distributes to all winners, and splits fees.

**Why:** Manual claiming creates a poor user experience, leaves funds in limbo, and requires users to pay additional gas. Atomic settlement is simpler, faster, and eliminates the entire claim UX.

### 4. Hybrid State (On-Chain + Off-Chain)

Predix maintains two sources of truth:

| Source | Data | Latency |
|--------|------|---------|
| Stacks blockchain | Round outcomes, bet records, balances, jackpot treasury | ~10s (block time) |
| Upstash Redis | Optimistic pool totals, open prices, nonce tracking, jackpot tickets, agent keys | ~1ms |

Clients poll `/api/round` every second. The response merges on-chain state (from Hiro API) with optimistic state (from Redis) using `max(on-chain, optimistic)` for pool totals.

**Why:** On-chain finality takes ~10 seconds. Without optimistic state, the UI would appear frozen after placing a bet. Redis provides instant feedback while the blockchain catches up.

## Round Lifecycle

```
  T+0s                  T+50s                T+60s
   |                      |                    |
   | TRADING WINDOW       | PRE-SETTLEMENT     | SETTLEMENT
   | (bets accepted)      | (bets closed)      | (cron resolves)
   |                      |                    |
   +----------------------+--------------------+
   |                      |                    |
   | open price set       | cron fetches       | resolve-and-distribute
   | (first-write-wins)   | Pyth Benchmarks    | called on-chain
   |                      | validates circuit   | payouts distributed
   |                      | breaker rules       | fees split (2%+1%)
```

1. **Round opens (T+0s):** Round ID is `floor(unix_timestamp / 60)`. The first bet triggers round creation on-chain. The open price is set via first-write-wins in Redis.
2. **Trading window (T+0s to T+50s):** Users and agents place bets through the gateway. Bets accumulate per side (UP/DOWN). Users can bet on both sides in the same round.
3. **Pre-settlement window (T+50s to T+60s):** Betting closes. The cron job prepares for settlement: fetches the close price from Pyth Benchmarks, runs circuit breaker validation.
4. **Settlement (T+60s):** The cron calls `resolve-and-distribute` through the gateway. The contract atomically resolves the round, distributes payouts to winners, and splits fees (2% operations + 1% jackpot treasury).

## Price Validation (Circuit Breaker)

Predix implements two layers of price validation to prevent oracle manipulation and stale data.

### Server-Side (cron)

| Check | Threshold | Action |
|-------|-----------|--------|
| Price movement | > 0.5% in 60 seconds | Skip round |
| Oracle divergence | > 0.3% between Hermes and Benchmarks | Skip round |
| Price range | Outside $10,000 - $500,000 | Skip round |

### On-Chain (contract)

| Check | Threshold | Action |
|-------|-----------|--------|
| Price bounds | > 1% from last known price | Reject transaction (ERR_PRICE_OUT_OF_BOUNDS) |

The server-side checks are conservative (tighter thresholds). The on-chain check is a defense-in-depth measure that catches anything the server missed.

## Jackpot System

The jackpot is a hybrid on-chain/off-chain system.

**On-chain:** 1% of all fees stay in the contract as a `jackpot-balance` data variable. The `pay-jackpot-winner` function transfers from this treasury.

**Off-chain (Redis):** Ticket tracking and draw logic.

| Multiplier | Condition |
|------------|-----------|
| 1x | Base: $1 bet in the early window (first 20 seconds) = 1 ticket |
| 2x | First bettor on a side |
| 2x | Largest bet on a side |
| 4x | Both first and largest |

**Daily draw (21:00 ET):** A Bitcoin block hash serves as verifiable randomness. The winner receives 10% of the on-chain treasury. The draw is executed via `pay-jackpot-winner` through the gateway.

## Agent Platform

Predix provides four integration paths for AI agents:

```
                    +------------------+
                    |   Agent Client   |
                    +--------+---------+
                             |
            +----------------+----------------+
            |                |                |
     +------v------+  +-----v------+  +------v------+
     |  REST API   |  |  MCP Server |  |    SDKs     |
     | /api/agent  |  | @predix/mcp |  | TS + Python |
     +------+------+  +-----+------+  +------+------+
            |                |                |
            +----------------+----------------+
                             |
                    +--------v---------+
                    |  /api/sponsor    |
                    |  (sign + submit) |
                    +--------+---------+
                             |
                    +--------v---------+
                    |  Stacks Network  |
                    +------------------+
```

**Authentication:** Agents register by signing a message with their Stacks wallet, proving ownership. The platform issues an API key (`pk_live_...`) used for rate-limited access.

**Transaction signing:** The platform builds unsigned sponsored transactions. The agent signs locally with its private key. The signed transaction is submitted to `/api/sponsor` for sponsorship and broadcast. The agent's private key never leaves its machine.

**Webhooks:** Agents can subscribe to events (round.resolved, bet.confirmed, jackpot.drawn, etc.) and receive HMAC-signed HTTP callbacks.

**Discovery:** Standard manifests at `/.well-known/agent.json` and `/.well-known/ai-plugin.json` enable automated agent onboarding.

## Deployment

| Component | Platform | Configuration |
|-----------|----------|---------------|
| Frontend + API | Vercel (serverless) | Next.js App Router |
| Database | Upstash Redis | Serverless, global replication |
| Blockchain | Stacks testnet | ~10s blocks (post-Nakamoto) |
| Oracle | Pyth Network | Hermes SSE (live) + Benchmarks (settlement) |
| Cron: Settlement | Vercel Cron | Every 60 seconds |
| Cron: Jackpot | Vercel Cron | Daily at 21:00 ET |
| Fallback daemon | Railway/Render | `scripts/resolver-daemon.mjs` |

## Security Boundaries

| Boundary | Enforcement |
|----------|-------------|
| User input | Contract validates side, amount, timing, round ID |
| Oracle data | Two-layer circuit breaker (server + contract) |
| Gateway access | Contract-level caller check, gateway-only |
| Settlement access | Sponsor-only via gateway |
| Upgrades | 144-block timelock on gateway and sponsor changes |
| Emergency | Pause + 200-block cooldown + 50% cap on withdrawals |
| Agent keys | SHA-256 hashed in Redis, rate-limited per tier |
| Webhooks | SSRF prevention, HMAC-SHA256 signing, auto-disable after 50 failures |
| Nonces | Redis lock + KV tracking prevents mempool conflicts |
