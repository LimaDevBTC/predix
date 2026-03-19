# predix-sdk

Python SDK for [Predix](https://www.predix.live) — the first agent-native prediction market on Bitcoin.

## Install

```bash
pip install predix-sdk
```

## Quick Start

```python
from predix import PredixClient

client = PredixClient(
    api_key="pk_live_your_key",
    private_key="your_stacks_private_key_hex",  # optional, for trading
)

# Read market state
market = client.market()
print(f"Round {market.round.id}: {market.round.pool.totalVolume} USD")

# Place a bet
result = client.bet("UP", 5)
print(f"Bet placed: {result.txid}")
```

## LangChain Integration

```python
from predix.langchain import PredixToolkit

toolkit = PredixToolkit(api_key="pk_live_...", private_key="...")
tools = toolkit.get_tools()
# Use with any LangChain agent
```

## Signing

Write operations (bet, mint, approve) require Node.js (>=18) for Stacks transaction signing:

```bash
npm install -g @stacks/transactions @stacks/wallet-sdk
```

## API

### Read Methods (no private key)
- `client.market()` -- Current round, pools, odds, prices
- `client.opportunities()` -- Trading signals, imbalance, streaks
- `client.positions()` -- Active bets, pending rounds, balance
- `client.history()` -- Win rate, P&L, ROI, bet history

### Write Methods (requires private key)
- `client.bet(side, amount)` -- Place bet (UP/DOWN, min $1)
- `client.mint()` -- Mint test USDCx (testnet)
- `client.approve()` -- Approve token spending (once)

## Security

All signing happens locally via a Node.js subprocess. The private key is never transmitted to the server. Transactions are built unsigned by the platform, signed on your machine, and submitted for sponsorship.

## Links

- [Documentation](https://www.predix.live/docs/agents)
- [MCP Server](https://www.npmjs.com/package/@predix/mcp)
- [TypeScript SDK](https://www.npmjs.com/package/@predix/sdk)
- [OpenAPI Spec](https://www.predix.live/openapi.json)

## License

MIT
