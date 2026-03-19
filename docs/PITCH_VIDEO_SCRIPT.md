# Pitch Video Script -- Predix

**Target duration:** 4 minutes 30 seconds
**Format:** Screen recording with voiceover (no face camera required, but recommended for intro/outro)

---

## SCENE 1: Hook (0:00 -- 0:30)

**[Screen: Predix landing page, dark theme, BTC price chart animating in real time]**

**Voiceover:**

> "What happens when you give AI agents direct access to a prediction market on Bitcoin?
>
> This is Predix -- the first agent-native prediction market built on Stacks. Users and AI agents trade 1-minute BTC price predictions with zero gas fees and fully automated on-chain settlement.
>
> Let me show you how it works."

**[Action: Briefly hover over the UP/DOWN buttons and countdown timer to draw attention to the interface.]**

---

## SCENE 2: The Problem (0:30 -- 1:00)

**[Screen: Simple slide or text overlay on screen -- three bullet points appearing one by one]**

**Voiceover:**

> "Prediction markets today have three core problems.
>
> First, they are slow. Rounds last hours or days. By the time you get a result, you have lost interest.
>
> Second, they are expensive. Every bet costs gas. For small trades, gas can eat a significant portion of your position.
>
> Third, they are human-only. There is no standard way for an AI agent to discover a market, authenticate, and trade autonomously.
>
> Predix solves all three."

---

## SCENE 3: Live Demo -- Placing a Bet (1:00 -- 2:00)

**[Screen: Back to Predix live at predix.live. Show a round in progress.]**

**Voiceover:**

> "Every round lasts 60 seconds. You see the live BTC price from the Pyth oracle, the countdown timer, and the current pool sizes for UP and DOWN."

**[Action: Click on UP, enter an amount (e.g., 5 USD), confirm in Xverse wallet.]**

> "I am placing a 5 dollar bet on UP. Notice that the gas fee is zero -- the platform sponsors every transaction. The user just signs and confirms."

**[Action: Show the bet appearing in the pool. Wait for the countdown to reach zero.]**

> "When the round ends, the settlement cron fetches the close price from Pyth Benchmarks, validates it against the circuit breaker, and calls resolve-and-distribute on-chain. Winners receive their payout automatically. There is nothing to claim."

**[Action: Show the result -- win or loss appearing on screen. If a win, show the confetti animation.]**

> "That is the entire flow. Sixty seconds, zero gas, automatic payout."

---

## SCENE 4: Agent Platform (2:00 -- 3:00)

**[Screen: Split between code editor (showing SDK code) and the Predix agent leaderboard page]**

**Voiceover:**

> "But Predix is not just for humans. It is agent-native from the ground up.
>
> AI agents can integrate through four paths: a REST API with full OpenAPI specification, an MCP server for Claude and Cursor, a TypeScript SDK, and a Python SDK with LangChain support."

**[Action: Show the MCP config in a code editor -- the JSON block with npx @predix/mcp.]**

> "Here is an MCP configuration for Claude Desktop. Add six lines of JSON and Claude can read the market, analyze opportunities, and place bets autonomously."

**[Action: Switch to a terminal or Claude Desktop showing an agent calling predix_market and predix_place_bet.]**

> "The agent calls predix_market to check the current round. It evaluates the odds. It calls predix_place_bet. The platform builds an unsigned transaction, the agent signs locally -- its private key never leaves the machine -- and the platform sponsors and broadcasts."

**[Action: Show the agent leaderboard at predix.live/agents.]**

> "Agents compete on a public leaderboard alongside human traders. You can see their win rate, P&L, ROI, and total volume. This is the first prediction market where AI and humans trade on equal terms."

---

## SCENE 5: Technical Architecture (3:00 -- 3:45)

**[Screen: Architecture diagram from the README or ARCHITECTURE.md -- the ASCII diagram or a cleaner visual version]**

**Voiceover:**

> "Under the hood, Predix is built entirely on Stacks and finalized on Bitcoin.
>
> The smart contracts are written in Clarity. The main market contract uses a gateway-only pattern -- all calls route through a thin proxy that enforces access control and round validation. The gateway and sponsor addresses are timelocked, requiring 144 blocks -- about 24 hours -- to change.
>
> Settlement uses Pyth Network as the oracle. A two-layer circuit breaker validates prices both server-side and on-chain, rejecting any settlement that shows signs of manipulation or stale data.
>
> The entire platform runs serverless on Vercel, with Upstash Redis for optimistic state, nonce tracking, and agent key management."

**[Action: Briefly show the contracts folder in the IDE -- predixv7.clar, gatewayv6.clar, test-usdcx.clar.]**

> "The token is a standard SIP-010 implementation. Every piece of Predix leverages Stacks: Clarity for trust, sponsored transactions for UX, and post-Nakamoto block times for viable on-chain timing."

---

## SCENE 6: Jackpot (3:45 -- 4:00)

**[Screen: Jackpot page at predix.live/jackpot]**

**Voiceover:**

> "One percent of all fees stay in an on-chain jackpot treasury. Every day at 9 PM Eastern, a Bitcoin block hash is used as verifiable randomness to draw a winner. Early and large bettors earn multiplied tickets, incentivizing active participation."

---

## SCENE 7: Closing (4:00 -- 4:30)

**[Screen: Predix landing page with the logo centered. Links to GitHub, docs, and live demo below.]**

**Voiceover:**

> "Predix is a production-grade prediction market with a complete agent platform -- REST API, MCP server, two SDKs, webhooks, and discovery manifests.
>
> It is live on Stacks testnet at predix.live. The GitHub repo includes full documentation, smart contract source, and the agent SDK packages.
>
> We built this to prove that DeFi on Bitcoin can be fast, frictionless, and agent-ready. This is Predix. Thank you."

---

## Recording Notes

**Technical setup:**
- Record at 1080p minimum (1920x1080).
- Use a clean browser window (no bookmarks bar, no other tabs visible).
- Dark mode for both the browser and code editor to match the Predix theme.
- Record audio separately if possible for cleaner sound.

**Key moments to capture:**
1. The countdown timer reaching zero and the round resolving (Scene 3).
2. The wallet popup showing zero gas fee (Scene 3).
3. The MCP config JSON and an agent placing a bet (Scene 4).
4. The agent leaderboard with real data (Scene 4).
5. The jackpot treasury balance and draw history (Scene 6).

**Pacing:**
- Do not rush. Let the UI breathe between transitions.
- Pause for 1-2 seconds after making a point before moving to the next topic.
- Keep cursor movements deliberate. Avoid aimless mouse movement.

**If a round does not resolve during recording:**
- Pre-record a round resolving and splice it in during editing.
- Alternatively, use the history page to show a resolved round.

**Fallback for agent demo:**
- If the MCP server is not configured during recording, show the TypeScript SDK code running in a terminal instead.
- The key point is demonstrating programmatic agent access with local signing.
