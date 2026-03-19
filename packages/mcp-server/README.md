# @predixlive/mcp

MCP Server for [Predix](https://www.predix.live) — the first agent-native prediction market on Bitcoin.

Trade 1-minute BTC price rounds with zero gas fees. Built on Stacks, finalized on Bitcoin.

> **Testnet only.** All tokens are free test tokens with no real value.

## Quick Start

### Claude Desktop / Cursor / Windsurf

Add to your MCP config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "predix": {
      "command": "npx",
      "args": ["@predixlive/mcp"],
      "env": {
        "STACKS_PRIVATE_KEY": "your_stacks_private_key_hex"
      }
    }
  }
}
```

> **Only a private key is needed.** The server auto-registers with the Predix API on first launch and obtains an API key automatically. You can also provide `PREDIX_API_KEY` directly if you prefer.

### First-Time Setup (Testnet)

After connecting, your agent needs to do two one-time setup steps before placing bets:

1. **Mint test tokens** — `predix_mint` gives you free USDCx tokens (testnet only, no real value)
2. **Approve the contract** — `predix_approve` allows the Predix contract to spend your USDCx (once)

After that, your agent can bet freely:

3. **Check the market** — `predix_market` to see the current round
4. **Place a bet** — `predix_place_bet` with side (UP/DOWN) and amount in USD
5. **Settlement is automatic** — payouts are pushed when the round resolves, no action needed

```
User: "Bet $5 UP on Predix"
Claude: → predix_market() → predix_place_bet(UP, 5)
       "Bet of $5 UP placed. Round 29385621, TxID: 0xabc..."
```

## Tools

| Tool | Description |
|------|-------------|
| `predix_market` | Current round state, odds, prices, volume |
| `predix_opportunities` | Market signals and betting opportunities |
| `predix_place_bet` | Place a bet (UP or DOWN) on current round |
| `predix_positions` | View current positions and balance |
| `predix_history` | View historical performance and stats |
| `predix_mint` | Mint free test USDCx tokens (testnet only) |
| `predix_approve` | Approve token spending for the contract (once) |

## Resources

| Resource | Description |
|----------|-------------|
| `predix://market/current` | Live market data (JSON) |
| `predix://rules` | Trading rules and mechanics (Markdown) |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `STACKS_PRIVATE_KEY` | Yes | Stacks private key hex (signs locally, never sent to server) |
| `PREDIX_API_KEY` | No | Agent API key — auto-generated if not provided |
| `PREDIX_API_URL` | No | API base URL (default: `https://www.predix.live`) |

## How It Works

1. Agent calls `predix_market` to check current round and odds
2. Agent calls `predix_place_bet` with side (UP/DOWN) and amount
3. Server builds unsigned tx → agent signs locally → server sponsors and broadcasts (zero gas)
4. Settlement is automatic — payouts pushed when round resolves

Your private key **never leaves your machine**. All signing happens locally via `@stacks/transactions`.

## Security

- Private key **never leaves your machine**. All signing happens locally.
- Transactions are built unsigned on the server, signed locally by the MCP client, and submitted for sponsorship.
- API keys are hashed (SHA-256) before storage. The plaintext key is shown only once at registration.

## Links

- [Documentation](https://www.predix.live/docs/agents)
- [OpenAPI Spec](https://www.predix.live/openapi.json)
- [TypeScript SDK](https://www.npmjs.com/package/@predixlive/sdk)

## License

MIT
