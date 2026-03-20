# AgentConex: Predix Agent-Native Completion Plan

> **Objetivo**: Finalizar 100% da infraestrutura agent-native do Predix — o primeiro prediction market on-chain agent-native, finalizado no Bitcoin.
>
> **Contexto**: A infraestrutura REST API, auth, MCP server, SDKs, webhooks CRUD e discovery manifests ja existem (~80%). O que falta: wiring de eventos, cleanup de API, canonicalizacao de URLs, preparacao de packages para publish, hardening.
>
> **Instrucao**: Execute cada fase sequencialmente. Cada task tem arquivo exato, codigo exato, e teste de verificacao. Faca commit ao final de cada fase.

---

## Estado Atual (nao modifique — referencia)

### O que funciona
- 9 API endpoints em `/api/agent/*` (market, opportunities, build-tx, positions, history, leaderboard, stats, register, webhooks)
- Auth: API keys SHA-256 hashed em Redis, rate limiting por tier (anon 10/min, free 30/min, verified 120/min)
- Rate limit headers ja injetados: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `X-Predix-Agent-Tier`
- MCP Server: 7 tools, 2 resources, signing local (`packages/mcp-server/`)
- TypeScript SDK: client completo com `bet()`, `stream()`, `waitForResolution()` (`packages/sdk-ts/`)
- Python SDK: client com signing via Node.js subprocess (`packages/sdk-py/`)
- Discovery: `/.well-known/agent.json`, `/.well-known/ai-plugin.json`, `/openapi.json`
- Webhooks: CRUD completo, SSRF prevention, HMAC signing, retry com backoff, auto-disable apos 50 falhas (`lib/agent-webhooks.ts`)
- Dashboard: `/agents` (leaderboard) e `/agents/[prefix]` (perfil)
- Docs: `/docs/agents` com quickstart, MCP, SDKs, REST reference
- `robots.txt` com regras agent-friendly
- Campo `won: boolean` ja existe no response de positions

### O que falta (este plano resolve)
1. **Webhooks nunca disparam** — CRUD existe mas nenhum evento e emitido
2. **Campo `claimed` vaza** no response de positions (conceito interno, nao faz sentido para agents)
3. **URLs apontam para `bitpredix.vercel.app`** em vez de `www.predix.live`
4. **`agent.json` incompleto** — falta webhooks, leaderboard, stats, register nos endpoints
5. **`robots.txt` sem Sitemap**
6. **Packages nao publicados** no npm/PyPI (falta metadata)
7. **Python SDK usa 3 subprocessos Node** — pode ser 1
8. **Endpoints publicos sem rate limiting** (leaderboard, stats)

---

## FASE 1: Webhook Event Wiring (CRITICO)

> Webhooks sao o diferencial "agent-native". Sem eventos, agents fazem polling. Com eventos, agents reagem em tempo real.

### Task 1.1: Disparar `bet.confirmed` no sponsor

**Arquivo**: `app/api/sponsor/route.ts`

**O que fazer**: Apos broadcast bem-sucedido de `place-bet`, disparar evento `bet.confirmed` para todos os webhooks inscritos.

**Implementacao**: Adicionar import no topo do arquivo:

```typescript
import { dispatchWebhookEvent } from '@/lib/agent-webhooks'
```

Apos o bloco de KV optimistic write (depois da linha `console.log('[sponsor] KV optimistic: ...')`), dentro do mesmo `if (roundId > 0 && ...)`, adicionar:

```typescript
// Dispatch webhook event (fire and forget)
dispatchWebhookEvent('bet.confirmed', {
  roundId,
  side,
  amountUsd: amountMicro / 1e6,
  txid: result.txid,
}).catch(() => {})
```

**IMPORTANTE**: O `.catch(() => {})` e obrigatorio — webhook delivery NAO pode bloquear o sponsor response.

**Teste**:
```bash
# 1. Verificar build
npm run build

# 2. Teste manual: registrar agent, criar webhook para bet.confirmed, fazer bet, verificar delivery
# Use https://webhook.site para capturar o POST
```

---

### Task 1.2: Disparar `round.open` e `round.trading_closed` no cron resolve

**Arquivo**: `app/api/cron/resolve/route.ts`

**O que fazer**: No inicio do handler GET, apos auth check e init do wallet, disparar `round.open` para a round atual e `round.trading_closed` para a round anterior.

**Implementacao**: O import de `dispatchWebhookEvent` ja existe neste arquivo (linha 16). Adicionar as dispatches logo apos o `logAndPrint({ action: 'init', ... })` (depois da linha 456):

```typescript
// Dispatch round lifecycle events (fire and forget)
const currentRoundId = Math.floor(Date.now() / 60000)
dispatchWebhookEvent('round.open', {
  roundId: currentRoundId,
  startsAt: currentRoundId * 60,
  endsAt: (currentRoundId + 1) * 60,
  tradingClosesAt: (currentRoundId + 1) * 60 - 10,
}).catch(() => {})

dispatchWebhookEvent('round.trading_closed', {
  roundId: currentRoundId - 1,
  closedAt: Math.floor(Date.now() / 1000),
}).catch(() => {})
```

**Nota**: O cron roda a cada minuto. Quando dispara, a round atual acaba de abrir e a round anterior esta sendo resolvida. Isso e close enough do timing real.

**Teste**:
```bash
npm run build
# Verificar que o cron continua respondendo OK
# Criar webhook para round.open, esperar tick do cron
```

---

### Task 1.3: Disparar `bet.result` no cron resolve

**Arquivo**: `app/api/cron/resolve/route.ts`

**O que fazer**: Apos o dispatch de `round.resolved` (que ja existe na funcao `processRound`, linhas 419-425), adicionar dispatch de `bet.result`.

**Implementacao**: Logo apos o `dispatchWebhookEvent('round.resolved', ...)` existente (linha 425), adicionar:

```typescript
dispatchWebhookEvent('bet.result', {
  roundId,
  outcome,
  priceStart,
  priceEnd,
  totalUp: round.totalUp / 1e6,
  totalDown: round.totalDown / 1e6,
  totalVolume: (round.totalUp + round.totalDown) / 1e6,
}).catch(() => {})
```

**Nota**: Broadcast para TODOS os subscribers. O payload inclui dados da round — cada agent verifica se tinha posicao. Isso evita N+1 lookups no Redis.

**Teste**:
```bash
npm run build
# Criar webhook para bet.result, fazer bet, esperar settlement
```

---

### Task 1.4: Disparar `jackpot.drawn` no jackpot-draw cron

**Arquivo**: `app/api/cron/jackpot-draw/route.ts`

**O que fazer**: Apos pagamento do jackpot e save do resultado, disparar `jackpot.drawn`.

**Implementacao**: Adicionar import no topo:

```typescript
import { dispatchWebhookEvent } from '@/lib/agent-webhooks'
```

Apos a linha `await saveDrawResult(result)` (linha 110), antes do log final, adicionar:

```typescript
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
```

**Teste**:
```bash
npm run build
```

---

### Verificacao da Fase 1

```bash
# Build completo sem erros
npm run build

# Grep para confirmar que todos os 6 eventos estao sendo disparados
grep -r "dispatchWebhookEvent" app/api/ --include="*.ts"

# Resultado esperado:
# app/api/cron/resolve/route.ts:    dispatchWebhookEvent('round.open', {
# app/api/cron/resolve/route.ts:    dispatchWebhookEvent('round.trading_closed', {
# app/api/cron/resolve/route.ts:    dispatchWebhookEvent('round.resolved', {        <-- ja existia
# app/api/cron/resolve/route.ts:    dispatchWebhookEvent('bet.result', {
# app/api/sponsor/route.ts:         dispatchWebhookEvent('bet.confirmed', {
# app/api/cron/jackpot-draw/route.ts: dispatchWebhookEvent('jackpot.drawn', {
```

**Commit**: `feat: wire all 6 webhook events — bet.confirmed, round.open, round.trading_closed, bet.result, jackpot.drawn`

---

## FASE 2: API Cleanup

### Task 2.1: Remover campo `claimed` do response de positions

O campo `claimed` e um conceito interno on-chain (o contract tem `claimed: bool` no map de bets). Para agents, settlement e automatico — esse campo nao faz sentido e so gera confusao.

**Arquivo 1**: `app/api/agent/positions/route.ts`

Localizar a funcao `parseBet` (linhas 141-147):
```typescript
// ANTES:
const parseBet = (bet: Record<string, { value?: unknown }> | null) => {
  if (!bet) return null
  const amount = Number(bet['amount']?.value ?? 0)
  if (amount === 0) return null
  const claimed = bet['claimed']?.value === true || String(bet['claimed']?.value) === 'true'
  return { amount: amount / 1e6, claimed }
}
```

Substituir por:
```typescript
// DEPOIS:
const parseBet = (bet: Record<string, { value?: unknown }> | null) => {
  if (!bet) return null
  const amount = Number(bet['amount']?.value ?? 0)
  if (amount === 0) return null
  return { amount: amount / 1e6 }
}
```

Tambem remover as referencias a `claimed` na logica de `estimatedPayout` (linhas 157-160):
```typescript
// ANTES:
if (outcome === 'UP' && up && !up.claimed) {
  estimatedPayout = ...
} else if (outcome === 'DOWN' && down && !down.claimed) {
  estimatedPayout = ...
}

// DEPOIS:
if (outcome === 'UP' && up) {
  estimatedPayout = ...
} else if (outcome === 'DOWN' && down) {
  estimatedPayout = ...
}
```

**Arquivo 2**: `packages/mcp-server/src/lib/client.ts`

Localizar a interface `PositionsResponse` (linhas 86-94), remover `claimed` dos sub-objetos:
```typescript
// ANTES:
up: { amount: number; claimed: boolean } | null
down: { amount: number; claimed: boolean } | null

// DEPOIS:
up: { amount: number } | null
down: { amount: number } | null
```

**Arquivo 3**: `packages/sdk-ts/src/types.ts`

Se a interface `PositionsData` contiver `claimed`, remover tambem.

**Teste**:
```bash
npm run build
# Confirmar que nenhum "claimed" aparece nos agent endpoints
grep -r "claimed" app/api/agent/ packages/mcp-server/src/ packages/sdk-ts/src/ --include="*.ts"
```

---

### Task 2.2: Canonicalizar URLs para `www.predix.live`

Todos os artefatos developer-facing devem apontar para a URL de producao.

**Arquivo 1**: `public/openapi.json` (linha 9)
```json
// ANTES:
"servers": [
  { "url": "https://bitpredix.vercel.app", "description": "Production (testnet)" }
]

// DEPOIS:
"servers": [
  { "url": "https://www.predix.live", "description": "Production" },
  { "url": "https://bitpredix.vercel.app", "description": "Legacy (alias)" }
]
```

**Arquivo 2**: `packages/mcp-server/src/lib/client.ts` (linha 5)
```typescript
// ANTES:
const DEFAULT_API_URL = 'https://bitpredix.vercel.app'

// DEPOIS:
const DEFAULT_API_URL = 'https://www.predix.live'
```

**Arquivo 3**: `packages/mcp-server/src/index.ts` (linha 20, no comment do header)
```typescript
// ANTES:
 *   PREDIX_API_URL       — Base URL (default: https://bitpredix.vercel.app)

// DEPOIS:
 *   PREDIX_API_URL       — Base URL (default: https://www.predix.live)
```

**Arquivo 4**: `packages/sdk-ts/src/client.ts` (linha 18)
```typescript
// ANTES:
const DEFAULT_BASE_URL = 'https://bitpredix.vercel.app'

// DEPOIS:
const DEFAULT_BASE_URL = 'https://www.predix.live'
```

**Arquivo 5**: `packages/sdk-py/predix/client.py` (linha 30)
```python
# ANTES:
DEFAULT_BASE_URL = "https://bitpredix.vercel.app"

# DEPOIS:
DEFAULT_BASE_URL = "https://www.predix.live"
```

**Arquivo 6**: `app/.well-known/ai-plugin/route.ts` (linhas 20-24)
```typescript
// ANTES:
url: 'https://bitpredix.vercel.app/openapi.json',
logo_url: 'https://bitpredix.vercel.app/icon-512.png',
legal_info_url: 'https://bitpredix.vercel.app/terms',

// DEPOIS:
url: 'https://www.predix.live/openapi.json',
logo_url: 'https://www.predix.live/icon-512.png',
legal_info_url: 'https://www.predix.live/terms',
```

**Teste**:
```bash
# Nenhuma referencia a bitpredix.vercel.app nos artefatos agent-facing
grep -r "bitpredix.vercel.app" public/openapi.json packages/ app/.well-known/

# Resultado esperado: apenas a entry "Legacy (alias)" no openapi.json
```

---

### Task 2.3: Completar `agent.json` com todos os endpoints

**Arquivo**: `app/.well-known/agent/route.ts`

Substituir o objeto `endpoints` atual por:

```typescript
endpoints: {
  market: '/api/agent/market',
  opportunities: '/api/agent/opportunities',
  build_tx: '/api/agent/build-tx',
  positions: '/api/agent/positions',
  history: '/api/agent/history',
  sponsor: '/api/sponsor',
  register: '/api/agent/register',
  webhooks: '/api/agent/webhooks',
  leaderboard: '/api/agent/leaderboard',
  stats: '/api/agent/stats',
},
```

**Teste**:
```bash
npm run build
```

---

### Task 2.4: Adicionar Sitemap ao robots.txt

**Arquivo**: `public/robots.txt`

Adicionar ao final:

```
Sitemap: https://www.predix.live/sitemap.xml
```

**Teste**: Verificar que o arquivo contem a linha.

---

### Verificacao da Fase 2

```bash
npm run build
grep -r "claimed" app/api/agent/positions/ --include="*.ts"   # nenhum resultado
grep -r "bitpredix.vercel.app" packages/ app/.well-known/       # so legacy alias
```

**Commit**: `fix: remove leaked claimed field, canonicalize URLs to predix.live, complete agent.json`

---

## FASE 3: Package Publishing Prep

> `npx @predix/mcp` e o hook principal de onboarding. Precisa funcionar.

### Task 3.1: Preparar `@predix/mcp` para npm

**Arquivo**: `packages/mcp-server/package.json`

Adicionar campos obrigatorios para npm publish:

```json
{
  "name": "@predix/mcp",
  "version": "0.2.0",
  "description": "Predix Prediction Market - MCP Server for AI Agents",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "predix-mcp": "dist/index.js"
  },
  "files": ["dist", "README.md", "LICENSE"],
  "repository": {
    "type": "git",
    "url": "https://github.com/LimaDevBTC/predix"
  },
  "homepage": "https://www.predix.live/docs/agents",
  "license": "MIT",
  "author": "Predix <agents@predix.live>",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "start": "node dist/index.js",
    "prepublishOnly": "npm run build"
  },
  "keywords": ["predix", "prediction-market", "mcp", "model-context-protocol", "stacks", "bitcoin", "aibtc", "ai-agent", "defi"],
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@stacks/transactions": "^7.0.0",
    "@stacks/wallet-sdk": "^7.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "@types/node": "^20.0.0"
  },
  "engines": {
    "node": ">=18"
  }
}
```

**Criar**: `packages/mcp-server/README.md`

```markdown
# @predix/mcp

MCP Server for [Predix](https://www.predix.live) — the first agent-native prediction market on Bitcoin.

Trade 1-minute BTC price rounds with zero gas fees. Built on Stacks, finalized on Bitcoin.

## Quick Start

### Claude Desktop / Cursor / Windsurf

Add to your MCP config (`claude_desktop_config.json`):

\```json
{
  "mcpServers": {
    "predix": {
      "command": "npx",
      "args": ["@predix/mcp"],
      "env": {
        "PREDIX_API_KEY": "pk_live_your_key_here",
        "STACKS_PRIVATE_KEY": "your_stacks_private_key_hex"
      }
    }
  }
}
\```

### Get an API Key

Register at [predix.live/docs/agents](https://www.predix.live/docs/agents) or via the API:

\```bash
curl -X POST https://www.predix.live/api/agent/register \
  -H "Content-Type: application/json" \
  -d '{"wallet":"ST...","signature":"...","message":"Predix Agent Registration {timestamp}"}'
\```

## Tools

| Tool | Description |
|------|-------------|
| `predix_market` | Current round state, odds, prices, volume |
| `predix_opportunities` | Market signals and betting opportunities |
| `predix_place_bet` | Place a bet (UP or DOWN) on current round |
| `predix_positions` | View current positions and balance |
| `predix_history` | View historical performance and stats |
| `predix_mint_tokens` | Mint test tokens (testnet only) |
| `predix_approve` | Approve token spending for the contract |

## Resources

| Resource | Description |
|----------|-------------|
| `predix://market/current` | Live market data (JSON) |
| `predix://rules` | Trading rules and mechanics (Markdown) |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PREDIX_API_KEY` | Yes | Agent API key (`pk_live_...`) |
| `STACKS_PRIVATE_KEY` | For trading | Stacks private key hex (signs locally, never sent to server) |
| `PREDIX_API_URL` | No | API base URL (default: `https://www.predix.live`) |

## How It Works

1. Agent calls `predix_market` to check current round and odds
2. Agent calls `predix_place_bet` with side (UP/DOWN) and amount
3. Server builds unsigned tx → agent signs locally → server sponsors and broadcasts (zero gas)
4. Settlement is automatic — payouts pushed when round resolves

Your private key **never leaves your machine**. All signing happens locally via `@stacks/transactions`.

## Links

- [Documentation](https://www.predix.live/docs/agents)
- [Agent Leaderboard](https://www.predix.live/agents)
- [OpenAPI Spec](https://www.predix.live/openapi.json)
```

---

### Task 3.2: Preparar `@predix/sdk` para npm

**Arquivo**: `packages/sdk-ts/package.json`

Adicionar campos:

```json
{
  "name": "@predix/sdk",
  "version": "0.1.0",
  "description": "TypeScript SDK for Predix prediction market — agent-native BTC trading",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist", "README.md", "LICENSE"],
  "repository": {
    "type": "git",
    "url": "https://github.com/LimaDevBTC/predix"
  },
  "homepage": "https://www.predix.live/docs/agents",
  "license": "MIT",
  "author": "Predix <agents@predix.live>",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "prepublishOnly": "npm run build"
  },
  "keywords": ["predix", "prediction-market", "stacks", "bitcoin", "sdk", "ai-agent", "defi"],
  "dependencies": {
    "@stacks/transactions": "^7.0.0",
    "@stacks/wallet-sdk": "^7.0.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "@types/node": "^20.0.0"
  },
  "engines": {
    "node": ">=18"
  }
}
```

**Criar**: `packages/sdk-ts/README.md`

```markdown
# @predix/sdk

TypeScript SDK for [Predix](https://www.predix.live) — the first agent-native prediction market on Bitcoin.

## Install

\```bash
npm install @predix/sdk
\```

## Quick Start

\```typescript
import { PredixClient } from '@predix/sdk'

const client = new PredixClient({
  apiKey: 'pk_live_your_key',
  privateKey: 'your_stacks_private_key_hex', // optional, for trading
})

// Read market state (no private key needed)
const market = await client.market()
console.log(`Round ${market.round.id}: ${market.round.pool.totalVolume} USD volume`)

// Place a bet
const result = await client.bet('UP', 5)
console.log(`Bet placed: ${result.txid}`)

// Wait for settlement
const resolution = await client.waitForResolution(result.roundId)
console.log(`Outcome: ${resolution.outcome}, P&L: ${resolution.pnl}`)

// Stream market data
for await (const state of client.stream({ interval: 2000 })) {
  console.log(`${state.round.secondsRemaining}s left, UP odds: ${state.round.pool.oddsUp}`)
}
\```

## API

### Read Methods (no private key)
- `client.market()` — Current round, pools, odds, prices
- `client.opportunities()` — Trading signals, imbalance, streaks
- `client.positions()` — Active bets, pending rounds, balance
- `client.history()` — Win rate, P&L, ROI, bet history

### Write Methods (requires private key)
- `client.bet(side, amount)` — Place bet (UP/DOWN, min $1)
- `client.mint()` — Mint test USDCx (testnet)
- `client.approve()` — Approve token spending (once)

### Utilities
- `client.waitForResolution(roundId)` — Poll until settled
- `client.stream()` — Async iterator for live market data

## Links

- [Documentation](https://www.predix.live/docs/agents)
- [MCP Server](https://www.npmjs.com/package/@predix/mcp)
- [OpenAPI Spec](https://www.predix.live/openapi.json)
```

---

### Task 3.3: Preparar `predix-sdk` para PyPI

**Arquivo**: `packages/sdk-py/pyproject.toml`

Garantir que contem:

```toml
[project]
name = "predix-sdk"
version = "0.1.0"
description = "Python SDK for Predix prediction market — agent-native BTC trading"
readme = "README.md"
license = {text = "MIT"}
authors = [{name = "Predix", email = "agents@predix.live"}]
requires-python = ">=3.9"
dependencies = ["httpx>=0.24", "pydantic>=2.0"]

[project.optional-dependencies]
langchain = ["langchain-core>=0.1"]

[project.urls]
Homepage = "https://www.predix.live"
Documentation = "https://www.predix.live/docs/agents"
Repository = "https://github.com/LimaDevBTC/predix"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
```

**Criar**: `packages/sdk-py/README.md`

```markdown
# predix-sdk

Python SDK for [Predix](https://www.predix.live) — the first agent-native prediction market on Bitcoin.

## Install

\```bash
pip install predix-sdk
\```

## Quick Start

\```python
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
\```

## LangChain Integration

\```python
from predix.langchain import PredixToolkit

toolkit = PredixToolkit(api_key="pk_live_...", private_key="...")
tools = toolkit.get_tools()
# Use with any LangChain agent
\```

> **Note**: Write operations require Node.js installed (for Stacks transaction signing).
```

---

### Verificacao da Fase 3

```bash
# Build MCP server
cd packages/mcp-server && npm run build && cd ../..

# Build TS SDK
cd packages/sdk-ts && npm run build && cd ../..

# Dry run npm pack
cd packages/mcp-server && npm pack --dry-run && cd ../..
cd packages/sdk-ts && npm pack --dry-run && cd ../..

# Verificar que README existe
ls packages/mcp-server/README.md packages/sdk-ts/README.md packages/sdk-py/README.md
```

**Commit**: `feat: prepare @predix/mcp, @predix/sdk, predix-sdk for publishing`

**NOTA**: O publish real (`npm publish --access public` / `twine upload`) deve ser feito manualmente pelo deployer apos review. NAO execute publish automaticamente.

---

## FASE 4: Discovery & SEO Polish

### Task 4.1: SEO metadata para `/docs/agents`

**Arquivo**: Criar `app/docs/agents/layout.tsx`

```typescript
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Agent API Documentation | Predix',
  description: 'Build AI agents that trade on Predix — the first agent-native prediction market on Bitcoin. MCP server, TypeScript & Python SDKs, webhooks, zero gas fees.',
  openGraph: {
    title: 'Predix Agent API — Build AI Trading Agents on Bitcoin',
    description: '1-minute BTC prediction rounds. Zero gas. MCP + REST + SDKs. Fully on-chain, finalized on Bitcoin.',
    url: 'https://www.predix.live/docs/agents',
    siteName: 'Predix',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Predix Agent API — Build AI Trading Agents on Bitcoin',
    description: '1-minute BTC prediction rounds. Zero gas. MCP + REST + SDKs.',
  },
}

export default function AgentDocsLayout({ children }: { children: React.ReactNode }) {
  return children
}
```

---

### Task 4.2: SEO metadata para `/agents`

**Arquivo**: Criar `app/agents/layout.tsx`

```typescript
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Agent Leaderboard | Predix',
  description: 'Top AI agents trading on Predix. Rankings by P&L, win rate, volume, and ROI.',
  openGraph: {
    title: 'Predix Agent Leaderboard',
    description: 'See which AI agents are winning on the first agent-native prediction market on Bitcoin.',
    url: 'https://www.predix.live/agents',
    siteName: 'Predix',
    type: 'website',
  },
}

export default function AgentsLayout({ children }: { children: React.ReactNode }) {
  return children
}
```

---

### Verificacao da Fase 4

```bash
npm run build
# Verificar que os layouts nao conflitam com os pages existentes
```

**Commit**: `feat: add SEO metadata for agent docs and leaderboard pages`

---

## FASE 5: Python SDK Signer Consolidation

### Task 5.1: Bundlar signer unificado

**Problema**: O Python SDK faz 3 invocacoes separadas de `subprocess.run(["node", "-e", ...])` — uma para derivar address, uma para public key, outra para assinar tx. Cada uma faz cold start do Node.js.

**Solucao**: Criar um unico script JS que aceita comandos via stdin e retorna JSON.

**Criar**: `packages/sdk-py/predix/_signer.js`

```javascript
/**
 * Unified Stacks signer for the Predix Python SDK.
 * Reads JSON commands from stdin, writes JSON results to stdout.
 * Private key is passed via stdin (never in command args).
 */
const readline = require('readline')
const { createStacksPrivateKey, pubKeyfromPrivKey, publicKeyToHex, deserializeTransaction, TransactionSigner } = require('@stacks/transactions')
const { getStxAddress } = require('@stacks/wallet-sdk')

const rl = readline.createInterface({ input: process.stdin })

rl.on('line', (line) => {
  try {
    const cmd = JSON.parse(line)

    if (cmd.action === 'derive') {
      const address = getStxAddress({
        account: { stxPrivateKey: cmd.privateKey, dataPrivateKey: '', appsKey: '', salt: '', index: 0 },
        network: cmd.network || 'testnet',
      })
      const pubKey = publicKeyToHex(pubKeyfromPrivKey(createStacksPrivateKey(cmd.privateKey)))
      console.log(JSON.stringify({ address, publicKey: pubKey }))
    } else if (cmd.action === 'sign') {
      const tx = deserializeTransaction(cmd.txHex)
      const signer = new TransactionSigner(tx)
      signer.signOrigin(createStacksPrivateKey(cmd.privateKey))
      console.log(JSON.stringify({ signedHex: tx.serialize() }))
    } else {
      console.log(JSON.stringify({ error: `Unknown action: ${cmd.action}` }))
    }
  } catch (e) {
    console.log(JSON.stringify({ error: e.message }))
  }
  rl.close()
})
```

**Modificar**: `packages/sdk-py/predix/client.py`

Substituir os 3 metodos `_derive_address`, `_get_public_key`, `_sign_tx` por:

```python
import os

def _signer_script_path(self) -> str:
    return os.path.join(os.path.dirname(__file__), '_signer.js')

def _call_signer(self, action: str, **kwargs) -> dict:
    """Single Node.js subprocess call for all signing operations."""
    cmd = json.dumps({"action": action, "privateKey": self.private_key, **kwargs})
    try:
        result = subprocess.run(
            ["node", self._signer_script_path()],
            input=cmd,
            capture_output=True, text=True, timeout=15,
        )
        if result.returncode != 0:
            raise PredixError(f"Signer failed: {result.stderr.strip()}")
        data = json.loads(result.stdout.strip())
        if "error" in data:
            raise PredixError(f"Signer error: {data['error']}")
        return data
    except FileNotFoundError:
        raise PredixError("Node.js required for Stacks signing (install from nodejs.org)")

def _derive_address(self) -> str:
    data = self._call_signer("derive", network=self.network)
    self._public_key = data["publicKey"]
    return data["address"]

def _get_public_key(self) -> str:
    if hasattr(self, '_public_key') and self._public_key:
        return self._public_key
    # derive also caches public key
    self._derive_address()
    return self._public_key

def _sign_tx(self, tx_hex: str) -> str:
    data = self._call_signer("sign", txHex=tx_hex)
    return data["signedHex"]
```

**Atualizar**: `packages/sdk-py/pyproject.toml` — garantir que `_signer.js` e incluido no package:

```toml
[tool.hatch.build.targets.wheel]
packages = ["predix"]
```

**NOTA**: O `_signer.js` precisa que `@stacks/transactions` e `@stacks/wallet-sdk` estejam instalados globalmente ou no mesmo diretorio. Adicionar nota no README:

```markdown
> **Signing dependency**: Write operations require Node.js (>=18) and `@stacks/transactions` installed:
> \```bash
> npm install -g @stacks/transactions @stacks/wallet-sdk
> \```
```

---

### Verificacao da Fase 5

```bash
# Verificar que o script JS existe e tem syntax valida
node -c packages/sdk-py/predix/_signer.js

# Build do projeto principal nao e afetado
npm run build
```

**Commit**: `feat: consolidate Python SDK signing into single Node.js subprocess`

---

## FASE 6: Production Hardening

### Task 6.1: Rate limiting nos endpoints publicos

**Problema**: `/api/agent/leaderboard` e `/api/agent/stats` sao publicos (nao usam `withAgentAuth`). Sem rate limiting, podem ser abusados.

**Solucao**: Wrap com `withAgentAuth` sem `requireAuth` — aplica rate limiting anonimo mas nao exige API key.

**Arquivo 1**: `app/api/agent/leaderboard/route.ts`

Verificar se ja usa `withAgentAuth`. Se NAO usar, wrappear o handler:

```typescript
import { withAgentAuth } from '@/lib/agent-auth'

export const GET = (req: NextRequest) =>
  withAgentAuth(req, async () => {
    // ... handler existente ...
  }, { requireAuth: false })
```

**Arquivo 2**: `app/api/agent/stats/route.ts`

Mesmo pattern.

**Teste**:
```bash
npm run build
# Verificar que os endpoints retornam headers X-RateLimit-*
curl -i https://www.predix.live/api/agent/leaderboard 2>&1 | grep -i ratelimit
```

---

### Task 6.2: Webhook delivery timeout safety

**Problema**: `deliverWebhook` em `lib/agent-webhooks.ts` faz retry com delays de ate 30s. Se muitos webhooks existirem, isso pode atrasar o cron.

**Solucao**: Verificar que todos os dispatches usam `.catch(() => {})` (fire-and-forget) e que o `Promise.allSettled` no `dispatchWebhookEvent` ja protege contra isso. Se sim, nao precisa mudar nada — so confirmar.

**Verificacao**:
```bash
# Confirmar que todos os dispatchWebhookEvent usam .catch(() => {})
grep -A1 "dispatchWebhookEvent" app/api/ -r --include="*.ts"
```

Se algum NAO tiver `.catch(() => {})`, adicionar.

---

### Verificacao da Fase 6

```bash
npm run build
```

**Commit**: `fix: add rate limiting to public agent endpoints, verify webhook timeout safety`

---

## CHECKLIST FINAL

Apos todas as fases, confirmar:

```bash
# 1. Build limpo
npm run build

# 2. Todos os 6 eventos webhook disparados
grep -r "dispatchWebhookEvent" app/api/ --include="*.ts" | wc -l
# Esperado: 6 (round.open, round.trading_closed, round.resolved, bet.result, bet.confirmed, jackpot.drawn)

# 3. Nenhum "claimed" nos endpoints de agent
grep -r "claimed" app/api/agent/ packages/mcp-server/src/ packages/sdk-ts/src/ --include="*.ts"
# Esperado: 0 resultados

# 4. URLs canonicalizadas
grep -r "bitpredix.vercel.app" packages/ app/.well-known/ --include="*.ts" --include="*.py" --include="*.json"
# Esperado: apenas legacy alias no openapi.json

# 5. Packages prontos
ls packages/mcp-server/README.md packages/sdk-ts/README.md packages/sdk-py/README.md
# Esperado: 3 arquivos

# 6. MCP server compila
cd packages/mcp-server && npm run build && cd ../..

# 7. TS SDK compila
cd packages/sdk-ts && npm run build && cd ../..

# 8. Python signer funcional
node -c packages/sdk-py/predix/_signer.js
```

## POS-DEPLOY (manual, nao automatizar)

1. `cd packages/mcp-server && npm publish --access public`
2. `cd packages/sdk-ts && npm publish --access public`
3. `cd packages/sdk-py && python -m build && twine upload dist/*`
4. Testar `npx @predix/mcp` em diretorio limpo
5. Testar `npm install @predix/sdk` em projeto novo
6. Testar `pip install predix-sdk` em venv limpo
7. Configurar Claude Desktop com MCP e verificar tools
8. Criar webhook via API e verificar delivery em webhook.site
