# Smart Contracts

Predix runs on three Clarity smart contracts deployed to Stacks testnet. All user and agent interactions are routed exclusively through the gateway proxy.

## Active Contracts

| Contract | Deployed As | Role |
|----------|-------------|------|
| `predixv7.clar` | `ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK.predixv7` | Main market logic, jackpot treasury, settlement |
| `gatewayv6.clar` | `ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK.gatewayv6` | Thin proxy, sponsor-only settlement, emergency pause |
| `test-usdcx.clar` | `ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK.test-usdcx` | SIP-010 token (6 decimals, 1000 USD mint per wallet) |

Deployer/Sponsor: `ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK`

## Architecture: Gateway-Only Access

```
  User/Agent
      |
      v
  gatewayv6 (proxy)
      |
      v
  predixv7 (market)  <-->  test-usdcx (token)
```

The market contract (`predixv7`) rejects all calls that do not originate from the gateway. This ensures:

- All bets pass through round sanity checks in the gateway.
- Settlement is restricted to the authorized sponsor wallet.
- The gateway can be paused independently for emergency response.
- Gateway upgrades require a 144-block timelock (~24 hours).

## predixv7 -- Main Market

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `ROUND_DURATION` | 60 | Seconds per round |
| `TRADING_WINDOW` | 50 | Seconds the betting window is open |
| `MIN_BET` | 1,000,000 | Minimum bet (1 USDCx, 6 decimals) |
| `FEE_BPS` | 300 | Total fee: 3% (300 basis points) |
| `FEE_OPS_BPS` | 200 | Operations fee: 2% to fee-recipient |
| `FEE_JACKPOT_BPS` | 100 | Jackpot fee: 1% stays in contract treasury |
| `PRICE_BOUND_BPS` | 100 | Reject settlement prices diverging >1% from last known |
| `TIMELOCK_BLOCKS` | 144 | ~24 hours for gateway/sponsor changes |
| `WITHDRAW_COOLDOWN` | 200 | ~33 minutes between emergency withdrawals |

### Data Maps

```clarity
;; Round state (created on first bet)
rounds { round-id: uint }
  -> { total-up: uint, total-down: uint, price-start: uint, price-end: uint, resolved: bool }

;; Individual bet records
bets { round-id: uint, user: principal, side: (string-ascii 4) }
  -> { amount: uint, claimed: bool }

;; Bettor list per round (max 200)
round-bettors { round-id: uint }
  -> { bettors: (list 200 principal) }
```

### Public Functions

All functions are gateway-only unless otherwise noted.

| Function | Access | Description |
|----------|--------|-------------|
| `place-bet(round-id, side, amount)` | Gateway | Validate timing, transfer tokens from user, accumulate bet. Side: "UP" or "DOWN". |
| `resolve-and-distribute(round-id, price-start, price-end)` | Gateway (sponsor) | Atomic settlement: mark resolved, compute payouts, distribute to winners, split fees (2% ops + 1% jackpot). Refunds without fee if no counterparty. |
| `pay-jackpot-winner(winner, amount)` | Gateway (sponsor) | Transfer from on-chain jackpot treasury to winner. |
| `seed-jackpot(amount)` | Deployer | Deposit tokens into jackpot fund. |
| `set-initial-price(price)` | Deployer | One-shot bootstrap for price bounds validation. |
| `set-gateway-bootstrap(new-gateway)` | Deployer | One-shot initial gateway setup (no timelock). |
| `schedule-gateway(new-gateway)` | Deployer | Begin timelocked gateway upgrade (144 blocks). |
| `activate-gateway` | Deployer | Complete gateway upgrade after timelock expires. |
| `schedule-sponsor(new-sponsor)` | Deployer | Begin timelocked sponsor change. |
| `activate-sponsor` | Deployer | Complete sponsor change after timelock expires. |
| `set-fee-recipient(new)` | Deployer | Change fee recipient address. |
| `set-paused(bool)` | Deployer | Emergency pause. Halts all betting and settlement. |
| `emergency-withdraw` | Deployer | Withdraw max 50% of contract balance. Requires paused for 200+ blocks. |

### Error Codes

| Code | Name | Cause |
|------|------|-------|
| u1000 | ERR_UNAUTHORIZED | Caller is not the gateway or deployer |
| u1001 | ERR_ROUND_NOT_ENDED | Round has not ended yet |
| u1004 | ERR_INVALID_SIDE | Side must be "UP" or "DOWN" |
| u1005 | ERR_INVALID_AMOUNT | Below minimum bet |
| u1006 | ERR_TRADING_CLOSED | Betting window has closed (>50s into round) |
| u1007 | ERR_TRANSFER_FAILED | Token transfer failed |
| u1009 | ERR_INVALID_PRICES | Settlement prices are zero or malformed |
| u1012 | ERR_ALREADY_RESOLVED | Round already settled |
| u1016 | ERR_PAUSED | Contract is paused |
| u1017 | ERR_PRICE_OUT_OF_BOUNDS | Settlement price diverges >1% from last known |
| u1018 | ERR_NOT_INITIALIZED | Price bounds not bootstrapped |
| u1020 | ERR_TIMELOCK_NOT_EXPIRED | Upgrade timelock has not elapsed |
| u1022 | ERR_WITHDRAW_COOLDOWN | Must wait 200+ blocks between withdrawals |

## gatewayv6 -- Proxy

The gateway is a thin proxy that enforces access control and round sanity before forwarding calls to `predixv7`.

| Function | Access | Description |
|----------|--------|-------------|
| `place-bet(round-id, side, amount)` | Any user (via sponsor) | Validates: not paused, round is current +/- 1. Forwards to predixv7. |
| `resolve-and-distribute(round-id, price-start, price-end)` | Sponsor only | Validates: not paused, caller is sponsor. Forwards to predixv7. |
| `pay-jackpot-winner(winner, amount)` | Sponsor only | Forwards to predixv7. |
| `set-paused(paused)` | Deployer | Toggle gateway emergency pause. |
| `set-sponsor(new-sponsor)` | Deployer | Change the authorized sponsor address. |

### Error Codes

| Code | Name | Cause |
|------|------|-------|
| u2000 | ERR_UNAUTHORIZED | Caller is not the deployer |
| u2001 | ERR_GATEWAY_PAUSED | Gateway is paused |
| u2002 | ERR_ROUND_NOT_ACTIVE | Round ID not within valid range |
| u2003 | ERR_NOT_SPONSOR | Caller is not the sponsor wallet |

## test-usdcx -- Token

Standard SIP-010 fungible token with a controlled mint.

| Function | Description |
|----------|-------------|
| `transfer(amount, sender, recipient, memo)` | Standard SIP-010 transfer |
| `approve(spender, amount)` | Approve allowance for contract spending |
| `transfer-from(amount, sender, recipient)` | Spend from allowance |
| `mint(recipient)` | Mint 1000 USDCx (once per principal) |

The market contract (`predixv7`) is authorized to transfer tokens without explicit allowance for settlement operations.

## Security Model

1. **No public claim functions.** Users never claim. Settlement is atomic and sponsor-only.
2. **Price bounds enforcement.** The contract rejects settlement prices diverging >1% from the last known price, preventing oracle manipulation.
3. **Timelocked upgrades.** Gateway and sponsor changes require a 144-block waiting period, giving users ~24 hours to exit.
4. **Emergency controls.** The contract can be paused. Emergency withdrawals are capped at 50% per execution and require the contract to be paused for 200+ blocks.
5. **Gateway isolation.** If the gateway is compromised, the market contract can be pointed to a new gateway after the timelock period.

## Testing

```bash
npm run test
```

Tests run with Vitest and the Clarinet SDK (`vitest-environment-clarinet`), executing against a local Stacks simnet. Test files are located in `tests/`.

## File Reference

```
contracts/
├── predixv7.clar           # Main market + jackpot treasury
├── gatewayv6.clar          # Gateway proxy
├── test-usdcx.clar         # SIP-010 token
├── sip-010-trait.clar      # SIP-010 trait definition
├── predixv8.clar           # Next version (development)
├── gatewayv7.clar          # Next gateway (development)
└── (legacy contracts)      # bitpredix-v6, predixv1, predixv2, predixv2-gateway
```
