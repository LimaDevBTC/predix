'use client'

export default function AgentsPage() {
  const DEPLOYER = 'ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK'
  const API_BASE = 'https://predix.app'

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="max-w-4xl mx-auto px-4 py-12">
        {/* Header */}
        <div className="mb-12">
          <h1 className="text-4xl font-bold mb-4 font-sans">
            Predix Agent API
          </h1>
          <p className="text-lg text-zinc-400">
            Native integration for AI agents and bots. Place bets, track positions, and claim winnings programmatically.
            Zero gas fees. 24/7 automated trading on 1-minute BTC prediction rounds.
          </p>
        </div>

        {/* Quick Start */}
        <Section title="Quick Start (MCP Server)">
          <p className="text-zinc-400 mb-4">
            For AIBTC agents and Claude-compatible AI assistants. Install the MCP server and start trading in 3 steps:
          </p>

          <Step n={1} title="Install & configure">
            <Code>{`// Add to your MCP config (claude_desktop_config.json or .claude.json)
{
  "mcpServers": {
    "predix": {
      "command": "npx",
      "args": ["@predix/mcp-server"],
      "env": {
        "PREDIX_API_URL": "${API_BASE}",
        "STACKS_PRIVATE_KEY": "your-stacks-private-key-hex"
      }
    }
  }
}`}</Code>
          </Step>

          <Step n={2} title="Mint tokens & approve">
            <Code>{`// Your agent calls these MCP tools once:
predix_mint_tokens()     // Get test USDCx tokens
predix_approve()         // Approve contract to spend tokens`}</Code>
          </Step>

          <Step n={3} title="Start trading">
            <Code>{`// Your agent can now trade autonomously:
predix_get_market()                       // Check current round
predix_get_opportunities()                // Find favorable bets
predix_place_bet({ side: "UP", amount: 5 })  // Bet $5 on UP
predix_get_positions()                    // Check positions
predix_claim({ roundId: 123, side: "UP" })   // Claim winnings`}</Code>
          </Step>
        </Section>

        {/* MCP Tools */}
        <Section title="MCP Tools">
          <div className="space-y-3">
            <ToolRow name="predix_get_market" desc="Current round state, odds, prices, volume, payout multipliers" />
            <ToolRow name="predix_get_opportunities" desc="Market signals: pool imbalance, price direction, volume, streaks" />
            <ToolRow name="predix_place_bet" desc="Place a bet (UP/DOWN, amount in USD). Zero gas fee." params="side, amount" />
            <ToolRow name="predix_get_positions" desc="Active bets, pending claims, USDCx balance" />
            <ToolRow name="predix_claim" desc="Claim winnings from a resolved round" params="roundId, side" />
            <ToolRow name="predix_get_history" desc="Performance stats: win rate, P&L, ROI, bet history" params="page?, pageSize?" />
            <ToolRow name="predix_mint_tokens" desc="Mint test USDCx tokens (testnet)" />
            <ToolRow name="predix_approve" desc="Approve token spending (one-time)" />
          </div>
        </Section>

        {/* REST API */}
        <Section title="REST API Endpoints">
          <p className="text-zinc-400 mb-4">
            For custom bots and non-MCP integrations. All endpoints are public, no API key required.
          </p>

          <div className="space-y-4">
            <Endpoint method="GET" path="/api/agent/market" desc="Complete market state for agent decision-making" />
            <Endpoint method="GET" path="/api/agent/opportunities" desc="Market signals and betting signals" />
            <Endpoint method="POST" path="/api/agent/build-tx" desc="Build unsigned transaction for agent to sign locally">
              <Code>{`// Request body:
{
  "action": "place-bet",           // place-bet | claim | approve | mint
  "publicKey": "03abc...def",      // Your compressed public key (66 hex chars)
  "params": {
    "side": "UP",                  // UP or DOWN (for place-bet)
    "amount": 5.0                  // USD amount (for place-bet)
  }
}

// Response includes unsigned tx hex.
// Sign with @stacks/transactions, then POST to /api/sponsor`}</Code>
            </Endpoint>
            <Endpoint method="POST" path="/api/sponsor" desc="Submit signed transaction for sponsorship and broadcast">
              <Code>{`// Request: { "txHex": "<signed-transaction-hex>" }
// Response: { "txid": "0x..." }`}</Code>
            </Endpoint>
            <Endpoint method="GET" path="/api/agent/positions?address=ST1..." desc="Positions, pending claims, balance" />
            <Endpoint method="GET" path="/api/agent/history?address=ST1..." desc="Performance stats and bet history" />
          </div>
        </Section>

        {/* Bot Example */}
        <Section title="Bot Example (TypeScript)">
          <Code>{`import { makeUnsignedContractCall, PostConditionMode } from '@stacks/transactions'

const API = '${API_BASE}'
const PUBLIC_KEY = 'your-compressed-public-key-hex'

// 1. Check market
const market = await fetch(\`\${API}/api/agent/market\`).then(r => r.json())
console.log('Round:', market.round.id, 'Odds UP:', market.round.pool.oddsUp)

// 2. Build unsigned tx (server handles contract details)
const buildRes = await fetch(\`\${API}/api/agent/build-tx\`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    action: 'place-bet',
    publicKey: PUBLIC_KEY,
    params: { side: 'UP', amount: 5 }
  })
}).then(r => r.json())

// 3. Sign locally with your private key
const tx = deserializeTransaction(buildRes.txHex)
const signer = new TransactionSigner(tx)
signer.signOrigin(createStacksPrivateKey(PRIVATE_KEY))
const signedHex = tx.serialize()

// 4. Submit for sponsorship (zero gas)
const result = await fetch(\`\${API}/api/sponsor\`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ txHex: signedHex })
}).then(r => r.json())

console.log('Bet placed! txid:', result.txid)`}</Code>
        </Section>

        {/* How It Works */}
        <Section title="How It Works">
          <div className="space-y-4 text-zinc-400">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <InfoCard title="1-Minute Rounds" text="Each round lasts 60 seconds. Bet UP or DOWN on BTC price movement. Trading closes 10 seconds before round end." />
              <InfoCard title="Zero Gas Fees" text="All transactions are sponsored. Your agent pays nothing for gas. Just have USDCx tokens to bet with." />
              <InfoCard title="Deterministic Settlement" text="Open price is first-write-wins in Redis. Close price comes from Pyth Benchmarks (same for everyone)." />
              <InfoCard title="Payout Formula" text="(your_bet / winning_pool) * total_pool * 0.97. The 3% fee splits: 2% protocol + 1% jackpot." />
            </div>
          </div>
        </Section>

        {/* Contract Info */}
        <Section title="Contract Details">
          <div className="text-sm text-zinc-400 space-y-2">
            <div><span className="text-zinc-500">Contract:</span> <code className="text-zinc-300">{DEPLOYER}.predixv2</code></div>
            <div><span className="text-zinc-500">Gateway:</span> <code className="text-zinc-300">{DEPLOYER}.predixv2-gateway</code></div>
            <div><span className="text-zinc-500">Token:</span> <code className="text-zinc-300">{DEPLOYER}.test-usdcx</code> (SIP-010, 6 decimals)</div>
            <div><span className="text-zinc-500">Network:</span> Stacks testnet</div>
            <div><span className="text-zinc-500">Min bet:</span> $1 USDCx</div>
            <div><span className="text-zinc-500">Fee:</span> 3% (2% protocol + 1% jackpot)</div>
          </div>
        </Section>

        <div className="mt-12 pt-8 border-t border-zinc-800 text-center text-zinc-500 text-sm">
          Built for agents. Powered by Stacks + Pyth Network.
        </div>
      </div>
    </div>
  )
}

// ---- Subcomponents ----

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-12">
      <h2 className="text-2xl font-bold mb-4 text-white">{title}</h2>
      {children}
    </section>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <div className="flex items-center gap-3 mb-2">
        <span className="w-7 h-7 rounded-full bg-[#F7931A] text-black text-sm font-bold flex items-center justify-center">{n}</span>
        <h3 className="font-semibold text-white">{title}</h3>
      </div>
      {children}
    </div>
  )
}

function Code({ children }: { children: string }) {
  return (
    <pre className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 overflow-x-auto text-sm font-mono text-zinc-300">
      {children}
    </pre>
  )
}

function ToolRow({ name, desc, params }: { name: string; desc: string; params?: string }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3">
      <code className="text-[#F7931A] font-mono text-sm font-semibold whitespace-nowrap">{name}</code>
      <span className="text-zinc-400 text-sm flex-1">{desc}</span>
      {params && <span className="text-zinc-600 text-xs font-mono">{params}</span>}
    </div>
  )
}

function Endpoint({ method, path, desc, children }: { method: string; path: string; desc: string; children?: React.ReactNode }) {
  const color = method === 'GET' ? 'text-green-400' : 'text-blue-400'
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
      <div className="flex items-center gap-3 mb-1">
        <span className={`font-mono text-sm font-bold ${color}`}>{method}</span>
        <code className="text-zinc-300 text-sm">{path}</code>
      </div>
      <p className="text-zinc-500 text-sm mb-2">{desc}</p>
      {children}
    </div>
  )
}

function InfoCard({ title, text }: { title: string; text: string }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
      <h4 className="font-semibold text-white mb-1">{title}</h4>
      <p className="text-sm text-zinc-400">{text}</p>
    </div>
  )
}
