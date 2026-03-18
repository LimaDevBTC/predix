# AgenticPredix — Plano de Implementação Completo

> Tornar o Predix o primeiro prediction market **agentic-native** no ecossistema Stacks.
> Agentes de IA devem conseguir descobrir, conectar, operar e competir no Predix
> com a mesma facilidade (ou mais) que um humano usando o frontend.

---

## Sumario Executivo

### Estado Atual
O Predix ja tem uma base funcional para agentes:
- 5 endpoints REST em `/api/agent/*` (market, opportunities, build-tx, positions, history)
- OpenAPI spec em `/public/openapi.json`
- Transaction builder server-side (`lib/agent-tx-builder.ts`)
- Flow completo: build-tx → sign → sponsor (zero gas)

### O Que Falta
| Gap | Impacto |
|-----|---------|
| Sem autenticacao de agentes | Impossivel rastrear, limitar ou rankear agentes |
| Sem MCP Server | Claude, Cursor, Windsurf nao conseguem usar Predix como tool nativa |
| Sem discovery manifests | Agentes nao encontram Predix automaticamente |
| Sem SDK | Agentes precisam implementar toda a integracao do zero |
| Sem webhooks | Agentes fazem polling em vez de reagir a eventos |
| Sem dashboard de agentes | Sem visibilidade, sem competicao, sem growth loop |
| Sem docs dedicados | Onboarding friction altissimo |

### Resultado Final
Apos implementacao completa, um agente Claude podera:
```
User: "Aposta $5 UP no Predix"
Claude: → predix_market() → predix_place_bet(UP, 5)
       "Aposta de $5 UP colocada. Round 29385621, TxID: 0xabc..."
```

---

## Arquitetura Geral

```
┌─────────────────────────────────────────────────────────────┐
│                     DISCOVERY LAYER                         │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐ │
│  │ ai-plugin.json│  │  agent.json  │  │   openapi.json    │ │
│  │  (ChatGPT)   │  │(Agent Proto) │  │   (universal)     │ │
│  └──────────────┘  └──────────────┘  └───────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                            │
┌─────────────────────────────────────────────────────────────┐
│                      ACCESS LAYER                           │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐ │
│  │  MCP Server  │  │   REST API   │  │    SDK (TS/Py)    │ │
│  │  (Claude,    │  │  /api/agent  │  │  @predix/sdk      │ │
│  │   Cursor)    │  │              │  │  predix-py        │ │
│  └──────────────┘  └──────────────┘  └───────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                            │
┌─────────────────────────────────────────────────────────────┐
│                       AUTH LAYER                            │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  API Keys (Redis) + Rate Limiting + Agent Identity   │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                            │
┌─────────────────────────────────────────────────────────────┐
│                     EXECUTION LAYER                         │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐ │
│  │  build-tx    │  │   sponsor    │  │   pool-store      │ │
│  │  (construct) │  │  (broadcast) │  │   (optimistic)    │ │
│  └──────────────┘  └──────────────┘  └───────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                            │
┌─────────────────────────────────────────────────────────────┐
│                     FEEDBACK LAYER                          │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐ │
│  │  Webhooks    │  │  Agent       │  │  Agent            │ │
│  │  (events)    │  │  Dashboard   │  │  Leaderboard      │ │
│  └──────────────┘  └──────────────┘  └───────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## Fase 0 — Preparacao & Cleanup

> Corrigir inconsistencias nos endpoints existentes antes de construir em cima.

### 0.1 Corrigir Contract IDs hardcoded

**Problema**: Os endpoints agent/* tem fallbacks para `predixv2`/`predixv2-gateway`, mas o contrato ativo e `predixv8`/`gatewayv7`. Em local dev sem `.env.local`, todos os endpoints usam contratos errados **silenciosamente**.

**Arquivos afetados**:
- `app/api/agent/market/route.ts` (linhas 24-26)
- `app/api/agent/positions/route.ts` (linhas 7-8)
- `app/api/agent/opportunities/route.ts` (linhas 28-29)
- `app/api/agent/history/route.ts` (auditar tambem)
- `lib/agent-tx-builder.ts` (linhas 19-21)

**Acao**: Importar de `lib/config.ts` em vez de hardcodar (fail-fast se env var ausente):
```typescript
// ANTES (cada arquivo repete)
const PREDIXV2_ID = process.env.NEXT_PUBLIC_BITPREDIX_CONTRACT_ID || `${DEPLOYER}.predixv2`

// DEPOIS (centralizado, fail-fast)
import { BITPREDIX_CONTRACT, GATEWAY_CONTRACT, TOKEN_CONTRACT, splitContractId } from '@/lib/config'
```

### 0.2 Consolidar `splitContractId`

**Problema**: `splitContractId()` esta duplicada em 5+ arquivos. `lib/config.ts` ja exporta essa funcao.

**Acao**: Remover duplicatas em `agent/market/route.ts`, `agent/positions/route.ts`, `agent/opportunities/route.ts`, `agent-tx-builder.ts`. Importar de `lib/config.ts`.

### 0.3 Remover action "claim" do build-tx

**Problema**: `build-tx` oferece action `claim`, mas predixv8 nao tem funcao de claim publica — settlement e sponsor-only. Alem disso, `buildClaimTx` chama `predixv8.claim-round-side` diretamente, violando a arquitetura gateway-only (a tx falharia on-chain de qualquer forma).

**Acao**: Remover `claim` de `VALID_ACTIONS` e do switch em `app/api/agent/build-tx/route.ts`. Remover `buildClaimTx` de `lib/agent-tx-builder.ts`. Sem backward-compatibility concern — funcao nunca funcionou.

### 0.4 Remover campo `claimable` do positions

**Problema**: `app/api/agent/positions/route.ts` retorna `claimable: boolean` mas nao existe mecanismo de claim (settlement e automatico). Isso confunde agentes.

**Acao**: Remover campo `claimable` da response. Substituir por `won: boolean` (indica se o agente ganhou o round). Atualizar OpenAPI schema.

### 0.5 Verificar target do approve tx

**Problema**: `buildApproveTx` em `lib/agent-tx-builder.ts` aprova `PREDIXV2_ID` (predixv8) como spender. Verificar no Clarity se quem faz `ft-transfer?` e predixv8 (correto) ou gatewayv7 (incorreto — precisa mudar target).

**Acao**: Ler `predixv8.clar` funcao `place-bet` para confirmar qual principal executa o `ft-transfer?`. Ajustar target do approve se necessario.

### 0.6 Atualizar OpenAPI spec

**Problema**: `openapi.json` lista `claim` como action valida e referencia `predix.app` como server (nao existe).

**Acao**: Remover `claim`, definir URL canonica (`https://bitpredix.vercel.app` ate dominio proprio), adicionar auth schema (Fase 2), remover `claimable` do PositionsResponse.

---

## Fase 1 — Discovery Layer

> Agentes precisam encontrar Predix automaticamente, sem configuracao humana.

### 1.1 OpenAI Plugin Manifest (`/.well-known/ai-plugin.json`)

**O que e**: Padrao de facto para ChatGPT e agentes compativeis descobrirem APIs.

**Arquivo**: `app/.well-known/ai-plugin/route.ts`

```typescript
// GET /.well-known/ai-plugin.json
export async function GET() {
  return NextResponse.json({
    schema_version: "v1",
    name_for_human: "Predix",
    name_for_model: "predix",
    description_for_human: "Predict BTC price movements in 1-minute rounds. Zero gas fees.",
    description_for_model: "Predix is a prediction market for 1-minute BTC price rounds on Stacks blockchain. Use this to place UP/DOWN bets, check market state, view positions, and analyze opportunities. All transactions are gas-free (sponsored). Testnet only.",
    auth: {
      type: "service_http",
      authorization_type: "bearer",
      verification_tokens: {}
    },
    api: {
      type: "openapi",
      url: "https://bitpredix.vercel.app/openapi.json"
    },
    logo_url: "https://bitpredix.vercel.app/icon-512.png",
    contact_email: "agents@predix.app",
    legal_info_url: "https://bitpredix.vercel.app/terms"
  })
}
```

### 1.2 Agent Protocol Manifest (`/.well-known/agent.json`)

**O que e**: Spec emergente para agent-to-agent discovery. Custo zero, future-proof.

**Arquivo**: `app/.well-known/agent/route.ts`

```typescript
// GET /.well-known/agent.json
export async function GET() {
  return NextResponse.json({
    name: "Predix",
    description: "1-minute BTC prediction market on Stacks. Zero gas.",
    version: "0.1.0",
    capabilities: ["market-data", "trading", "portfolio", "analytics"],
    protocols: {
      openapi: "/openapi.json",
      mcp: {
        package: "@predix/mcp",
        transports: ["stdio", "streamable-http"],
        stdio: { command: "npx", args: ["@predix/mcp"] },
        http: { url: "/mcp", note: "planned" }
      }
    },
    authentication: {
      type: "api-key",
      header: "X-Predix-Key",
      registration: "/api/agent/register"
    },
    endpoints: {
      market: "/api/agent/market",
      opportunities: "/api/agent/opportunities",
      build_tx: "/api/agent/build-tx",
      positions: "/api/agent/positions",
      history: "/api/agent/history",
      sponsor: "/api/sponsor"
    },
    limits: {
      free_tier: "30 req/min",
      verified_tier: "120 req/min"
    }
  })
}
```

### 1.3 Atualizar `robots.txt` e meta tags

**Acao**: Garantir que crawlers de agentes podem acessar os manifests:
```
# public/robots.txt
User-agent: *
Allow: /.well-known/
Allow: /openapi.json
Allow: /api/agent/
```

---

## Fase 2 — Auth Layer

> Identificar agentes individualmente. Base para rate limiting, analytics e leaderboard.

### 2.1 API Key Schema (Redis)

**Formato da key**: `pk_live_<32-char-hex>` (prefixo `pk_` = Predix Key)

**Armazenamento Redis**:
```
agent-key:{hash(key)} → {
  key_prefix: "pk_live_abc1",     // primeiros 12 chars (para display)
  wallet: "ST1ABC...",            // wallet associada
  name: "MyTradingBot",          // nome do agente (opt-in)
  description: "...",            // descricao (opt-in)
  tier: "free",                  // free | verified
  created_at: 1710720000,
  last_used: 1710720000,
  request_count: 0,
  total_volume_usd: 0,
  metadata: {}                   // extensivel
}
```

**Index reverso** (wallet → key):
```
agent-wallet:{wallet} → hash(key)
```

**Arquivo**: `lib/agent-keys.ts`

**Funcoes**:
```typescript
generateAgentKey(wallet: string, name?: string): Promise<{ key: string; prefix: string }>
validateAgentKey(key: string): Promise<AgentKeyData | null>
getAgentByWallet(wallet: string): Promise<AgentKeyData | null>
revokeAgentKey(keyHash: string): Promise<void>
incrementUsage(keyHash: string, volumeUsd?: number): Promise<void>
listAgentKeys(page: number, pageSize: number): Promise<AgentKeyData[]>
```

### 2.2 Registration Endpoint

**Arquivo**: `app/api/agent/register/route.ts`

**Flow**:
1. Agent envia `{ wallet, signature, message, name?, description? }`
2. Server verifica signature (prova que agent controla a wallet)
3. Server gera API key, armazena em Redis
4. Retorna `{ ok: true, apiKey: "pk_live_...", prefix: "pk_live_abc1" }`

**Validacoes**:
- Signature valida usando **legacy string signing** (`verifyMessageSignatureRsv` de `@stacks/encryption`)
- Message format exato: `"Predix Agent Registration {unix_timestamp_seconds}"`
- Timestamp na message deve estar dentro de janela de 5 min (anti-replay)
- Server converte signature + message → public key → c32 address, compara com `wallet`
- 1 key por wallet (retorna existente se ja tem)
- Rate limit: 5 registrations/hora por IP

```typescript
// POST /api/agent/register
interface RegisterRequest {
  wallet: string          // ST1ABC... (Stacks address)
  signature: string       // Signed message hex
  message: string         // "Predix Agent Registration {timestamp}"
  name?: string           // "MyTradingBot" (max 32 chars)
  description?: string    // (max 200 chars)
}

interface RegisterResponse {
  ok: true
  apiKey: string          // "pk_live_a1b2c3..." (shown ONCE)
  prefix: string          // "pk_live_a1b2" (for display)
  wallet: string
  tier: "free"
  limits: { requestsPerMinute: 30 }
}
```

### 2.3 Auth Middleware

**Arquivo**: `lib/agent-auth.ts`

**Comportamento**:
- Extrai `X-Predix-Key` do header (ou `Authorization: Bearer pk_...`)
- Valida key em Redis (lookup por hash)
- Injeta `agentData` no request context
- Rate limit: sliding window por key hash
- **Graceful degradation**: se nenhuma key, permite acesso anonimo com rate limit mais restrito (10 req/min por IP) — isso permite testes rapidos sem registration

```typescript
interface AgentContext {
  authenticated: boolean
  keyHash?: string
  wallet?: string
  name?: string
  tier: 'anonymous' | 'free' | 'verified'
  rateLimit: { max: number; remaining: number; reset: number }
}

async function withAgentAuth(
  req: NextRequest,
  handler: (req: NextRequest, agent: AgentContext) => Promise<NextResponse>
): Promise<NextResponse>
```

**Rate Limits**:
| Tier | Requests/min | Bet limit/round |
|------|-------------|-----------------|
| anonymous | 10 | 1 |
| free | 30 | 5 |
| verified | 120 | 20 |

**Enforcement de bet-per-round**: Aplicado no `withAgentAuth` do endpoint `build-tx` (action=place-bet). Counter em Redis: `agent-bets:{keyHash}:{roundId}` com TTL 120s. Incrementa antes de construir tx, rejeita com 429 se exceder limite do tier.

### 2.4 Aplicar Auth em Todos Endpoints Agent/*

**Acao**: Wrap cada handler existente com `withAgentAuth`:

```typescript
// Exemplo: app/api/agent/market/route.ts
import { withAgentAuth } from '@/lib/agent-auth'

export const GET = (req: NextRequest) =>
  withAgentAuth(req, async (req, agent) => {
    // ... logica existente ...
    // Adicionar header X-RateLimit-Remaining
  })
```

**Endpoints que recebem auth**:
- `GET /api/agent/market` — anonymous OK
- `GET /api/agent/opportunities` — anonymous OK
- `POST /api/agent/build-tx` — requires key (place-bet)
- `GET /api/agent/positions` — requires key
- `GET /api/agent/history` — requires key
- `POST /api/sponsor` — manter rate limit existente (wallet-based) + agent key check

### 2.5 Response Headers Padrao

Todos endpoints agent/* devem retornar:
```
X-RateLimit-Limit: 30
X-RateLimit-Remaining: 27
X-RateLimit-Reset: 1710720060
X-Predix-Agent-Tier: free
X-Request-Id: req_abc123
```

---

## Fase 3 — MCP Server (Model Context Protocol)

> O canal mais importante para 2025-2026. Claude, Cursor, Windsurf, e qualquer MCP client
> usam Predix como tool nativa — sem codigo, sem SDK, so config.

### 3.1 Estrutura do Projeto

```
mcp-server/
  package.json
  tsconfig.json
  src/
    index.ts              ← Entry point (stdio transport)
    server.ts             ← MCP server setup + tool registration
    tools/
      market.ts           ← predix_market tool
      opportunities.ts    ← predix_opportunities tool
      place-bet.ts        ← predix_place_bet tool
      positions.ts        ← predix_positions tool
      history.ts          ← predix_history tool
      mint.ts             ← predix_mint tool
      approve.ts          ← predix_approve tool
    lib/
      api-client.ts       ← HTTP client para Predix API
      signer.ts           ← Stacks tx signing (private key)
      config.ts           ← Base URL, API key, wallet config
    resources/
      market-info.ts      ← MCP resource: market state (readable)
```

### 3.2 Package.json

```json
{
  "name": "@predix/mcp",
  "version": "0.1.0",
  "description": "MCP server for Predix prediction market",
  "bin": { "predix-mcp": "./dist/index.js" },
  "main": "./dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@stacks/transactions": "^7.3.1",
    "@stacks/encryption": "^7.1.0"
  }
}
```

### 3.3 Tool Definitions

#### `predix_market` — Estado do mercado
```typescript
{
  name: "predix_market",
  description: "Get current Predix market state: active round, pool sizes, odds, BTC price, payout multipliers, and jackpot info. Call this first to understand current conditions before placing a bet.",
  inputSchema: {
    type: "object",
    properties: {},
    required: []
  }
}
```
**Retorno**: Round ID, seconds remaining, trading open, pool UP/DOWN, odds, payout multipliers, BTC price, price change %, jackpot balance.

#### `predix_opportunities` — Sinais de mercado
```typescript
{
  name: "predix_opportunities",
  description: "Get computed market signals: pool imbalance (which side has better payout), price direction within round, volume level, jackpot early window status, and recent outcome streaks. Use this to inform betting decisions.",
  inputSchema: {
    type: "object",
    properties: {},
    required: []
  }
}
```
**Retorno**: Pool imbalance ratio, favored side, price direction, volume level, recent outcomes, streak info.

#### `predix_place_bet` — Apostar
```typescript
{
  name: "predix_place_bet",
  description: "Place a bet on the current round. Builds an unsigned transaction server-side, signs it locally with your private key, and submits it for sponsored broadcast (zero gas). Returns transaction ID on success.",
  inputSchema: {
    type: "object",
    properties: {
      side: {
        type: "string",
        enum: ["UP", "DOWN"],
        description: "Bet direction: UP (BTC price goes up) or DOWN (BTC price goes down)"
      },
      amount: {
        type: "number",
        minimum: 1,
        description: "Bet amount in USD (minimum $1, uses USDCx token)"
      }
    },
    required: ["side", "amount"]
  }
}
```
**Flow interno**:
1. GET `/api/agent/market` — validar que trading esta aberto
2. POST `/api/agent/build-tx` — obter txHex unsigned
3. Sign localmente com private key (`signStacksTransaction`)
4. POST `/api/sponsor` — submeter tx sponsored
5. Retornar `{ txid, roundId, side, amount, estimatedPayout }`

#### `predix_positions` — Posicoes
```typescript
{
  name: "predix_positions",
  description: "Get your current positions: active bets in current round, pending rounds, token balance. Use this to check your portfolio before placing new bets.",
  inputSchema: {
    type: "object",
    properties: {},
    required: []
  }
}
```
**Nota**: Wallet address derivada automaticamente da private key configurada.

#### `predix_history` — Historico + Stats
```typescript
{
  name: "predix_history",
  description: "Get your betting history and performance stats: win rate, total P&L, ROI, best win, worst loss, current streak. Paginated.",
  inputSchema: {
    type: "object",
    properties: {
      page: { type: "integer", default: 1, description: "Page number" },
      pageSize: { type: "integer", default: 20, maximum: 50, description: "Results per page" }
    },
    required: []
  }
}
```

#### `predix_mint` — Mintar Test Tokens
```typescript
{
  name: "predix_mint",
  description: "Mint test USDCx tokens (testnet only). Use this to get tokens for betting if your balance is low.",
  inputSchema: {
    type: "object",
    properties: {},
    required: []
  }
}
```

#### `predix_approve` — Aprovar Token Spend
```typescript
{
  name: "predix_approve",
  description: "Approve the Predix contract to spend your USDCx tokens. Required once before placing your first bet.",
  inputSchema: {
    type: "object",
    properties: {},
    required: []
  }
}
```

### 3.4 Configuracao do MCP Client

> **SEGURANCA**: `PREDIX_PRIVATE_KEY` controla fundos reais da wallet do agente.
> - NUNCA commitar em repositorios ou compartilhar
> - Usar variaveis de ambiente do sistema (`export PREDIX_PRIVATE_KEY=...`)
> - Considerar usar uma wallet dedicada so para trading no Predix com saldo limitado
> - O MCP server tambem aceita `PREDIX_PRIVATE_KEY_FILE` apontando para um arquivo protegido (chmod 600)

#### Claude Desktop / Claude Code
```json
// ~/.claude/claude_desktop_config.json
{
  "mcpServers": {
    "predix": {
      "command": "npx",
      "args": ["@predix/mcp"],
      "env": {
        "PREDIX_API_KEY": "pk_live_...",
        "PREDIX_PRIVATE_KEY": "your-stacks-private-key",
        "PREDIX_BASE_URL": "https://bitpredix.vercel.app"
      }
    }
  }
}
```

#### Cursor
```json
// .cursor/mcp.json
{
  "mcpServers": {
    "predix": {
      "command": "npx",
      "args": ["@predix/mcp"],
      "env": {
        "PREDIX_API_KEY": "pk_live_...",
        "PREDIX_PRIVATE_KEY": "your-stacks-private-key"
      }
    }
  }
}
```

#### MCP Remoto (Streamable HTTP) — para agentes que nao rodam processos locais
```
// Futuro: MCP Streamable HTTP transport
// URL: https://bitpredix.vercel.app/mcp
// Headers: X-Predix-Key: pk_live_...
// Nota: Neste modo, signing e feito server-side via custodial key
// ou o agente envia txHex pre-assinado como parametro.
// Implementacao: Fase posterior, apos validar stdio transport.
```

### 3.5 MCP Resources (Read-Only Data)

Alem de tools, o MCP server expoe **resources** que agentes podem ler:

```typescript
// resource: predix://market/current
{
  uri: "predix://market/current",
  name: "Current Market State",
  description: "Live market data updated every request",
  mimeType: "application/json"
}

// resource: predix://rules
{
  uri: "predix://rules",
  name: "Predix Trading Rules",
  description: "How the prediction market works: round mechanics, fees, timing, payouts",
  mimeType: "text/markdown"
}
```

O resource `predix://rules` retorna um markdown explicando:
- Rounds de 60s, trading fecha aos 50s
- Min bet $1, fee 3% (2% ops + 1% jackpot)
- Payout = (your_amount / winning_pool) * total_pool * 0.97
- Jackpot: bet nos primeiros 20s ganha tickets, draw diario 21h ET

### 3.6 Fluxo Completo (Exemplo)

```
User: "Checa o mercado do Predix e se tiver boa oportunidade aposta $3 DOWN"

Claude:
  1. tool_use: predix_market
     → Round 29385621, 35s remaining, trading OPEN
     → Pool: UP $45, DOWN $12, payout DOWN = 4.61x
     → BTC: $84,230 → $84,195 (-0.04%)

  2. tool_use: predix_opportunities
     → Pool imbalance: DOWN underweight (3.75:1 ratio)
     → Price direction: DOWN (-0.04%)
     → "DOWN has 4.61x payout — significantly underweight"

  3. tool_use: predix_place_bet { side: "DOWN", amount: 3 }
     → Building tx... Signing... Broadcasting...
     → txid: 0xabc123..., round: 29385621

  4. Response: "Apostei $3 DOWN no round 29385621.
     O pool DOWN esta bem underweight (4.61x payout vs 1.26x UP).
     BTC ja caiu 0.04% nesse round. TxID: 0xabc123..."
```

---

## Fase 4 — SDK TypeScript

> Para agentes programaticos que preferem integrar via codigo (bots autonomos, LangChain tools, etc).

### 4.1 Estrutura

```
packages/sdk-ts/
  package.json
  tsconfig.json
  src/
    index.ts              ← Export principal
    client.ts             ← PredixClient class
    types.ts              ← Interfaces tipadas
    signer.ts             ← Signing utilities
    errors.ts             ← Custom errors
  README.md
```

### 4.2 API do SDK

```typescript
import { PredixClient } from '@predix/sdk'

// Inicializacao
const predix = new PredixClient({
  apiKey: 'pk_live_...',          // Obrigatorio
  privateKey: '...',              // Para assinar txs (opcional se so leitura)
  baseUrl: 'https://bitpredix.vercel.app', // Default
  network: 'testnet',            // Default
})

// --- Leitura (nao requer privateKey) ---

// Estado do mercado
const market = await predix.market()
// → { round: { id, tradingOpen, secondsRemaining, pool, odds, payouts }, contract, jackpot }

// Oportunidades
const signals = await predix.opportunities()
// → { signals: { poolImbalance, priceDirection, volume, jackpot }, recentOutcomes, streak }

// Posicoes (requer wallet address ou privateKey configurada)
const pos = await predix.positions()
// → { balanceUsd, pendingRounds, activeRound }

// Historico
const history = await predix.history({ page: 1, pageSize: 20 })
// → { stats: { winRate, totalPnlUsd, roi }, bets: [...] }

// --- Escrita (requer privateKey) ---

// Apostar
const bet = await predix.bet('UP', 5)
// → { txid, roundId, side, amount, estimatedPayout }

// Mintar test tokens
const mint = await predix.mint()
// → { txid }

// Aprovar token spend
const approve = await predix.approve()
// → { txid }

// --- Utilidades ---

// Derivar wallet address da private key
const address = predix.address
// → "ST1ABC..."

// Esperar round resolver (poll /api/agent/positions a cada 2s ate resolved ou timeout)
const result = await predix.waitForResolution(roundId, { timeout: 90_000, pollInterval: 2000 })
// → { outcome: 'UP', priceStart, priceEnd, pnl }

// Stream de mercado (polling wrapper)
for await (const market of predix.stream({ interval: 2000 })) {
  if (market.round.tradingOpen && market.round.secondsRemaining > 15) {
    // logica de decisao
  }
}
```

### 4.3 Error Handling

```typescript
import { PredixError, TradingClosedError, InsufficientBalanceError } from '@predix/sdk'

try {
  await predix.bet('UP', 100)
} catch (err) {
  if (err instanceof TradingClosedError) {
    console.log('Tarde demais, espere proximo round')
  } else if (err instanceof InsufficientBalanceError) {
    await predix.mint() // mintar mais tokens
    await predix.bet('UP', 100) // retry
  }
}
```

### 4.4 Package.json

```json
{
  "name": "@predix/sdk",
  "version": "0.1.0",
  "description": "TypeScript SDK for Predix prediction market",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "import": "./dist/index.mjs", "require": "./dist/index.js", "types": "./dist/index.d.ts" }
  },
  "dependencies": {
    "@stacks/transactions": "^7.3.1",
    "@stacks/encryption": "^7.1.0"
  },
  "peerDependencies": {},
  "devDependencies": {
    "tsup": "^8.0.0",
    "typescript": "^5.6.0"
  }
}
```

---

## Fase 5 — SDK Python

> Para agentes no ecossistema LangChain, CrewAI, AutoGen, e scripts Python.

### 5.1 Estrutura

```
packages/sdk-py/
  pyproject.toml
  predix/
    __init__.py
    client.py             ← PredixClient class
    types.py              ← Pydantic models
    signer.py             ← Stacks signing (ver nota abaixo)
    errors.py             ← Custom exceptions
  README.md
```

> **Nota tecnica sobre signing em Python**: Nao existe lib Python madura para signing de Stacks transactions.
> Estrategia recomendada (em ordem de preferencia):
> 1. **Server-side signing endpoint** — Adicionar `/api/agent/sign-and-submit` que recebe `{ apiKey, side, amount }` e faz build+sign+submit server-side (custodial mode). Mais simples para agentes Python.
> 2. **Subprocess Node** — `signer.py` chama um script Node.js minimo que assina a tx (requer Node.js instalado).
> 3. **Pure Python** — Implementar secp256k1 signing + Stacks tx serialization em Python (esforco alto, fragil).
> Recomendacao: implementar opcao 1 (server-side) como default para Python SDK, opcao 2 como fallback.

### 5.2 API do SDK

```python
from predix import PredixClient

client = PredixClient(
    api_key="pk_live_...",
    private_key="...",       # Stacks private key
)

# Leitura
market = client.market()
signals = client.opportunities()
positions = client.positions()
history = client.history(page=1, page_size=20)

# Escrita
tx = client.bet(side="UP", amount=5)
print(f"TxID: {tx.txid}")

# Mint test tokens
client.mint()
```

### 5.3 LangChain Integration

```python
from predix.langchain import PredixToolkit

# Cria tools LangChain prontas
toolkit = PredixToolkit(api_key="pk_live_...", private_key="...")
tools = toolkit.get_tools()
# → [PredixMarketTool, PredixBetTool, PredixPositionsTool, ...]

# Usar com agent
from langchain.agents import create_openai_tools_agent
agent = create_openai_tools_agent(llm, tools, prompt)
```

### 5.4 CrewAI Integration

```python
from predix.crewai import PredixTools

# Usar como tools de um agent CrewAI
trader = Agent(
    role="Crypto Trader",
    tools=[PredixTools.market, PredixTools.bet, PredixTools.positions],
)
```

---

## Fase 6 — Webhooks & Events

> Agents reagem a eventos em vez de fazer polling. Critico para bots autonomos.

### 6.1 Eventos Suportados

| Evento | Trigger | Payload |
|--------|---------|---------|
| `round.open` | Novo round comeca (a cada 60s) | `{ roundId, startAt, endsAt }` |
| `round.trading_closed` | Trading fecha (10s antes do fim) | `{ roundId, pool, odds }` |
| `round.resolved` | Round liquidado | `{ roundId, outcome, priceStart, priceEnd, totalVolume }` |
| `bet.confirmed` | Aposta do agente confirmada on-chain | `{ roundId, side, amount, txid }` |
| `bet.result` | Resultado da aposta do agente | `{ roundId, side, amount, outcome, pnl }` |
| `jackpot.drawn` | Jackpot diario sorteado | `{ winner, amount, blockHash }` |

### 6.2 Webhook CRUD

**Arquivo**: `app/api/agent/webhooks/route.ts`

```typescript
// POST /api/agent/webhooks — Criar webhook
interface CreateWebhookRequest {
  url: string                    // HTTPS URL do agente
  events: string[]               // ["round.resolved", "bet.result"]
  secret?: string                // Se fornecido, usado para HMAC. Senao, server gera.
}

// GET /api/agent/webhooks — Listar webhooks do agente
// DELETE /api/agent/webhooks/:id — Remover webhook
// PATCH /api/agent/webhooks/:id — Atualizar webhook (toggle active, mudar events)
```

**Limites**: Max 5 webhooks por agent key.

### 6.3 Delivery

**Arquivo**: `lib/agent-webhooks.ts`

**Mecanismo**:
1. Cron resolve round → dispara `round.resolved` para todos webhooks inscritos
2. POST para URL do webhook com:
   - Body: JSON do evento
   - Header `X-Predix-Signature`: HMAC-SHA256 do body com secret
   - Header `X-Predix-Event`: nome do evento
   - Header `X-Predix-Delivery`: UUID unico
3. Retry: 3 tentativas com backoff (1s, 5s, 30s)
4. Timeout: 5s por tentativa
5. Disable automatico apos 50 falhas consecutivas

**SSRF Prevention (obrigatorio)**:
Na criacao/update do webhook, validar URL antes de salvar:
1. Parse URL — rejeitar se nao for HTTPS
2. Resolver DNS do hostname
3. Rejeitar IPs privados/reservados: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `::1`, `169.254.0.0/16` (link-local), `0.0.0.0`
4. Na hora do delivery, resolver DNS novamente (prevenir DNS rebinding) e verificar IP antes de conectar
5. Setar header `Host` explicitamente no request de delivery

**Redis storage**:
```
agent-webhook:{webhookId} → {
  id: "wh_abc123",
  keyHash: "...",
  url: "https://mybot.example.com/webhook",
  events: ["round.resolved", "bet.result"],
  secret: "whsec_...",
  active: true,
  failCount: 0,
  createdAt: 1710720000
}

agent-webhooks:{keyHash} → ["wh_abc123", "wh_def456"]  // index
```

### 6.4 Integracao com Cron Existente

**Modificar** `app/api/cron/resolve/route.ts`:
```typescript
// Apos resolver round com sucesso:
await dispatchWebhookEvent('round.resolved', {
  roundId,
  outcome,
  priceStart,
  priceEnd,
  totalVolume,
})
```

**Modificar** `app/api/sponsor/route.ts`:
```typescript
// Apos broadcast de place-bet com sucesso:
if (agentKeyHash) {
  await dispatchWebhookEvent('bet.confirmed', {
    roundId, side, amount, txid,
  }, agentKeyHash) // so para o agente que apostou
}
```

---

## Fase 7 — Agent Dashboard & Leaderboard

> Visibilidade publica cria competicao entre agentes → atrai mais agentes.

### 7.1 Endpoints de Backend

**`GET /api/agent/leaderboard`** — Ranking publico de agentes
```typescript
interface AgentLeaderboardEntry {
  name: string            // "AlphaBot" ou "Anonymous Agent"
  prefix: string          // "pk_live_a1b2" (parcial, para tracking)
  wallet: string          // Stacks address
  stats: {
    totalBets: number
    winRate: number
    totalPnlUsd: number
    roi: number
    totalVolumeUsd: number
    activeSince: number   // timestamp
    lastActive: number    // timestamp
  }
  rank: number
}

// Query params: sort=pnl|winRate|volume|roi, page, pageSize
```

**`GET /api/agent/stats`** — Stats globais do ecossistema
```typescript
interface AgentEcosystemStats {
  totalAgents: number           // Agentes registrados
  activeAgents24h: number       // Agentes ativos ultimas 24h
  agentVolume24h: number        // Volume de agentes em USD
  agentVolumePercent: number    // % do volume total que vem de agentes
  topAgent: AgentLeaderboardEntry
}
```

### 7.2 Pagina `/agents`

**Arquivo**: `app/agents/page.tsx`

**Secoes**:
1. **Hero**: "The Arena for Trading Agents" — stats globais
2. **Leaderboard table**: Ranking com sort por PnL, Win Rate, Volume, ROI
3. **Quick Start**: 3 tabs (MCP, SDK, Raw HTTP) com copy-paste snippets
4. **Active Now**: Badge de agentes que apostaram no round atual

**Design**: Usar estetica de terminal/hacker (JetBrains Mono, cores neon sobre dark) para atrair developers e agentes AI.

### 7.3 Pagina `/agents/[prefix]` (perfil do agente)

**Arquivo**: `app/agents/[prefix]/page.tsx`

**Conteudo**:
- Nome + descricao do agente
- Stats completos (winRate, PnL, ROI, volume, streak)
- Grafico de PnL over time
- Ultimas 20 apostas
- Badge de ranking (#1 PnL, #1 Volume, etc)

---

## Fase 8 — Documentacao & Developer Experience

> Onboarding friction zero. Um agente deve conseguir comecar a operar em 5 minutos.

### 8.1 Pagina `/docs/agents`

**Arquivo**: `app/docs/agents/page.tsx`

**Estrutura**:

#### Quickstart (60 segundos)
```bash
# 1. Registrar (obter API key)
curl -X POST https://bitpredix.vercel.app/api/agent/register \
  -H "Content-Type: application/json" \
  -d '{"wallet":"ST1ABC...","signature":"...","message":"Predix Agent Registration 1710720000"}'

# 2. Checar mercado
curl https://bitpredix.vercel.app/api/agent/market \
  -H "X-Predix-Key: pk_live_..."

# 3. Apostar
curl -X POST https://bitpredix.vercel.app/api/agent/build-tx \
  -H "X-Predix-Key: pk_live_..." \
  -H "Content-Type: application/json" \
  -d '{"action":"place-bet","publicKey":"03abc...","params":{"side":"UP","amount":5}}'
```

#### Guia MCP (Claude/Cursor)
```bash
# Instalar
npm install -g @predix/mcp

# Configurar Claude Desktop
# Adicionar ao ~/.claude/claude_desktop_config.json:
{
  "mcpServers": {
    "predix": {
      "command": "npx",
      "args": ["@predix/mcp"],
      "env": {
        "PREDIX_API_KEY": "pk_live_...",
        "PREDIX_PRIVATE_KEY": "your-private-key"
      }
    }
  }
}
# Pronto! Diga ao Claude: "Aposta $5 UP no Predix"
```

#### Guia SDK TypeScript
```typescript
import { PredixClient } from '@predix/sdk'

const predix = new PredixClient({
  apiKey: 'pk_live_...',
  privateKey: process.env.STACKS_PRIVATE_KEY!,
})

// Bot simples: apostar contra a maioria
const signals = await predix.opportunities()
if (signals.signals.poolImbalance.favoredSide) {
  await predix.bet(signals.signals.poolImbalance.favoredSide, 5)
}
```

#### Guia SDK Python
```python
from predix import PredixClient

client = PredixClient(api_key="pk_live_...", private_key="...")
market = client.market()
if market.round.trading_open:
    client.bet("UP", 5)
```

#### Reference completa
- Todos endpoints com request/response examples
- Error codes e significados
- Rate limit details
- Webhook event schemas

### 8.2 OpenAPI Spec Atualizada

**Arquivo**: `public/openapi.json` (atualizar)

Adicionar:
- `securitySchemes` com API key
- Endpoint `/api/agent/register`
- Endpoint `/api/agent/webhooks` (CRUD)
- Endpoint `/api/agent/leaderboard`
- Endpoint `/api/agent/stats`
- Remover action `claim`
- Server URL correto

---

## Estrutura Final de Arquivos

```
app/
  .well-known/
    ai-plugin/route.ts              ← [Fase 1.1] OpenAI plugin manifest
    agent/route.ts                  ← [Fase 1.2] Agent Protocol manifest
  api/agent/
    register/route.ts               ← [Fase 2.2] Agent registration
    market/route.ts                 ← [existente] Market state
    opportunities/route.ts          ← [existente] Trading signals
    build-tx/route.ts               ← [existente] Transaction builder
    positions/route.ts              ← [existente] Portfolio
    history/route.ts                ← [existente] Betting history
    webhooks/route.ts               ← [Fase 6.2] Webhook CRUD
    leaderboard/route.ts            ← [Fase 7.1] Agent ranking
    stats/route.ts                  ← [Fase 7.1] Ecosystem stats
  agents/
    page.tsx                        ← [Fase 7.2] Agent dashboard
    [prefix]/page.tsx               ← [Fase 7.3] Agent profile
  docs/
    agents/page.tsx                 ← [Fase 8.1] Developer docs

lib/
  agent-auth.ts                     ← [Fase 2.3] Auth middleware
  agent-keys.ts                     ← [Fase 2.1] Key management (Redis)
  agent-webhooks.ts                 ← [Fase 6.3] Webhook delivery
  agent-tx-builder.ts               ← [existente] Tx construction

mcp-server/
  package.json                      ← [Fase 3.2] @predix/mcp
  src/
    index.ts                        ← [Fase 3.1] Entry point
    server.ts                       ← [Fase 3.1] Server setup
    tools/
      market.ts                     ← [Fase 3.3]
      opportunities.ts              ← [Fase 3.3]
      place-bet.ts                  ← [Fase 3.3]
      positions.ts                  ← [Fase 3.3]
      history.ts                    ← [Fase 3.3]
      mint.ts                       ← [Fase 3.3]
      approve.ts                    ← [Fase 3.3]
    lib/
      api-client.ts                 ← [Fase 3.1]
      signer.ts                     ← [Fase 3.1]
      config.ts                     ← [Fase 3.1]
    resources/
      market-info.ts                ← [Fase 3.5]

packages/
  sdk-ts/
    package.json                    ← [Fase 4.4] @predix/sdk
    src/
      index.ts                      ← [Fase 4.1]
      client.ts                     ← [Fase 4.2]
      types.ts                      ← [Fase 4.2]
      signer.ts                     ← [Fase 4.2]
      errors.ts                     ← [Fase 4.3]
  sdk-py/
    pyproject.toml                  ← [Fase 5.1] predix-py
    predix/
      __init__.py                   ← [Fase 5.1]
      client.py                     ← [Fase 5.2]
      types.py                      ← [Fase 5.2]
      signer.py                     ← [Fase 5.2]
      errors.py                     ← [Fase 5.2]
      langchain.py                  ← [Fase 5.3]
      crewai.py                     ← [Fase 5.4]

public/
  openapi.json                      ← [Fase 8.2] Atualizado
  robots.txt                        ← [Fase 1.3] Atualizado
```

---

## Cronograma de Execucao

| Prioridade | Fase | O que | Esforco | Deps |
|:---:|:---:|---|:---:|:---:|
| **P0** | 0 | Cleanup (fix contract IDs, remove claim, update spec) | 2h | — |
| **P0** | 2 | Auth Layer (API keys, register, middleware, rate limiting) | 1d | Fase 0 |
| **P0** | 3 | MCP Server (7 tools, resources, npm package) | 2d | Fase 2 |
| **P1** | 1 | Discovery (ai-plugin.json, agent.json, robots.txt) | 3h | — (soft dep Fase 2 para auth ref) |
| **P1** | 4 | SDK TypeScript (@predix/sdk) | 1d | Fase 2 |
| **P2** | 6 | Webhooks (CRUD, delivery, cron integration) | 1.5d | Fase 2 |
| **P2** | 8 | Docs page + OpenAPI update | 1d | Fase 3+4 |
| **P3** | 7 | Agent Dashboard & Leaderboard (frontend) | 1.5d | Fase 2 |
| **P3** | 5 | SDK Python + LangChain/CrewAI integration | 1d | Fase 4 |

**Total estimado**: ~10 dias de trabalho focado.

**Caminho critico**: Fase 0 → Fase 2 → Fase 3 (MCP) → publicar npm → agentes operam.

---

## Metricas de Sucesso

| Metrica | Baseline | Meta 30d | Meta 90d |
|---------|:--------:|:--------:|:--------:|
| Agentes registrados | 0 | 10 | 50 |
| % volume via agentes | 0% | 20% | 50% |
| API calls/dia (agentes) | 0 | 1,000 | 10,000 |
| MCP installs (npm) | 0 | 50 | 200 |
| SDK installs (npm+pypi) | 0 | 30 | 100 |
| Webhook deliveries/dia | 0 | 500 | 5,000 |

---

## Riscos & Mitigacoes

| Risco | Impacto | Mitigacao |
|-------|---------|-----------|
| Agentes spammando apostas | Drain do sponsor wallet STX | Rate limit por tier + monitoramento de sponsor balance |
| Private keys expostas | Fundos do agente roubados | Docs enfatizam: nunca commitar keys, usar env vars, keys sao do agente (nao do Predix) |
| Webhook target malicioso | SSRF via webhook URL | Validacao rigorosa: HTTPS only, DNS resolve + IP check (rejeitar privados/reservados), re-check no delivery (anti-DNS rebinding) |
| MCP spec muda | Package quebra | Pin version do @modelcontextprotocol/sdk, testes automatizados |
| Manipulacao por agentes (ex: criar imbalance e explorar) | Perdas para outros users | Min 2 distinct wallets por round, circuit breaker, price bounds on-chain |
| Rate limit bypass (multiple keys) | Infra overload | 1 key per wallet, IP-based backup limit |

---

## Notas de Design

### Por que MCP e nao so REST?
MCP (Model Context Protocol) e o padrao nativo para Claude, Cursor, Windsurf, e a maioria dos agentes AI em 2025-2026. REST requer que o agente entenda a API, monte requests, parse responses. MCP fornece **tools nativas** que o LLM pode chamar diretamente — zero friction.

### Por que API keys e nao JWT?
- Agentes sao programas, nao humanos com sessoes
- API keys sao stateless, simples, universais
- JWT adiciona complexidade (refresh, expiry) sem beneficio real para agents

### Por que wallet signature no register?
- Prova que o agente controla a wallet (proof of ownership)
- Previne registration spam
- Liga a key a uma wallet real (para tracking de volume/PnL)
- Nao requer email, OAuth, ou qualquer onboarding humano

### Por que webhooks alem de polling?
- Polling 1x/s * 100 agentes = 100 req/s (caro)
- Webhooks: 1 evento broadcast para N agentes = O(N) POSTs, mas no nosso timing
- Bots autonomos precisam reagir a `round.resolved` instantaneamente

---

## Nota: Parametro `isEarly` no build-tx

O `buildPlaceBetTx` em `lib/agent-tx-builder.ts` calcula automaticamente `isEarly` (true se aposta nos primeiros 20s do round — elegivel para jackpot tickets). Este parametro e computado **server-side** pelo endpoint `/api/agent/build-tx` e nao precisa ser passado pelo agente. O MCP server e os SDKs nao expoem este parametro — e transparente.

---

## Consideracoes de Mainnet Migration

Quando o Predix migrar para mainnet, a infra agentica precisara de ajustes:

| Item | Acao |
|------|------|
| API keys | Manter keys existentes. Adicionar campo `network: testnet|mainnet` ao registro. Keys testnet nao funcionam em mainnet (e vice-versa). |
| Agent leaderboard | Reset para mainnet. Manter historico testnet como "practice season". |
| Webhook URLs | Manter. Eventos passam a incluir `network` no payload. |
| MCP server | `PREDIX_BASE_URL` muda. Config do agente decide network. |
| SDK | `network` param no constructor. Default muda para `mainnet`. |
| Contract IDs | Novos contratos em mainnet. SDK/MCP leem do `/api/agent/market` (que retorna contract info). |
| Token | test-usdcx → real USDCX. Min bet pode mudar. |
| Sponsor balance | Mainnet STX custa real. Monitorar sponsor wallet balance com alertas. |

---

*Documento criado em 2026-03-18. Versao 1.1 (revisado).*
