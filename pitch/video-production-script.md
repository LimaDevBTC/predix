# Predix -- Video Production Script (5 min)

> **Format:** AI narration (voiceover) + screen recording (you)
> **Resolution:** 1920x1080 @ 60fps
> **Tip:** Record each section separately. Easier to sync and re-record if needed.

---

## SECTION 1 -- HOOK (0:00 - 0:18)

| Time | Narration (AI Voice) | Screen Action (You) |
|------|---------------------|---------------------|
| 0:00 | What happens when you give AI agents direct access to a prediction market on Bitcoin? | **Black screen** with Predix logo fade-in (use `pitch/x-banner.png` or the logo centered on dark bg). Hold 3s. |
| 0:08 | This is Predix. The first agent-native prediction market built on Stacks. Users and AI agents trade one-minute BTC price predictions with zero gas fees and fully automated on-chain settlement. | **Transition to predix.live** -- show the homepage loading. Slow mouse scroll down to reveal the full MarketCard. |
| 0:17 | Let me show you how it works. | **Pause on MarketCard** -- price ticking, countdown visible. |

---

## SECTION 2 -- THE PROBLEM (0:18 - 0:40)

| Time | Narration (AI Voice) | Screen Action (You) |
|------|---------------------|---------------------|
| 0:18 | Prediction markets today have three core problems. | **Open a new tab.** Go to Polymarket or any slow prediction market. Show a market with "Ends in 14 days" or similar. |
| 0:23 | First, they are slow. Rounds last hours or days. By the time you get a result, you have lost interest. | **Highlight/circle** the long expiry date on the competitor site. Scroll to show how long markets take. |
| 0:30 | Second, they are expensive. Every bet costs gas. For small trades, gas fees eat a significant portion of your position. | **Show a MetaMask/wallet** gas fee screen (can be a screenshot if you don't want to do a live tx). Show gas = $2-5 for a small bet. |
| 0:36 | Third, they are human-only. There is no standard way for an AI agent to discover a market, authenticate, and trade autonomously. | **Show competitor's docs page** -- no API, no SDK, no agent support. OR show a blank search for "API" on their docs. |

---

## SECTION 3 -- LIVE DEMO: PLACING A BET (0:40 - 1:45)

> **CRITICAL:** Time this so you start recording at ~10s into a new round (50s left). You need enough time to bet + show settlement.

| Time | Narration (AI Voice) | Screen Action (You) |
|------|---------------------|---------------------|
| 0:40 | Predix solves all three. | **Switch tab back to predix.live.** MarketCard visible, countdown running. |
| 0:43 | Every round lasts sixty seconds. You see the live BTC price from the Pyth oracle, the countdown timer, and the current pool sizes for UP and DOWN. | **Move cursor** slowly over each element as it's mentioned: (1) BTC price at top, (2) countdown timer, (3) UP pool size, (4) DOWN pool size. |
| 0:55 | I am placing a five dollar bet on UP. | **Click UP button.** Type "5" in the amount field. |
| 1:00 | Notice the gas fee is zero. The platform sponsors every transaction. | **Hover/highlight** the fee display showing $0.00 or "Sponsored". |
| 1:04 | The user just signs and confirms. | **Click "Place Bet".** Xverse popup appears. **Click Confirm** in Xverse. Show the tx confirming. |
| 1:12 | *(pause -- let the UI update)* | **Show the pool updating** -- your bet appears in the UP pool. The optimistic update is instant. Wait for countdown to approach 0. |
| 1:20 | When the round ends, the settlement cron fetches the close price from Pyth Benchmarks, validates it against the circuit breaker, and calls resolve and distribute on-chain. | **Countdown hits 0.** The round resolves. Show the result appearing (UP wins or DOWN wins). |
| 1:35 | Winners receive their payout automatically. There is nothing to claim. | **Show the payout notification** or the balance update. If you won, highlight the amount. If you lost, that's fine too -- it's honest. |
| 1:40 | That is the entire flow. Sixty seconds. Zero gas. Automatic payout. | **Brief pause on the resolved round.** Let it breathe. |

---

## SECTION 4 -- AGENT-NATIVE PLATFORM (1:45 - 3:00)

| Time | Narration (AI Voice) | Screen Action (You) |
|------|---------------------|---------------------|
| 1:45 | But Predix is not just for humans. It is agent-native from the ground up. | **Open VS Code** or your editor. Navigate to the project root. Show the folder structure briefly (packages/sdk-ts, packages/sdk-py, packages/mcp-server). |
| 1:55 | AI agents can integrate through four paths. A REST API with full OpenAPI specification. An MCP server for Claude and Cursor. A TypeScript SDK. And a Python SDK with LangChain support. | **Open each folder quickly** as mentioned: (1) Open `public/openapi.json` -- scroll briefly, (2) Open `packages/mcp-server/`, (3) Open `packages/sdk-ts/`, (4) Open `packages/sdk-py/`. |
| 2:15 | Here is an MCP configuration for Claude Desktop. Add six lines of JSON and Claude can read the market, analyze opportunities, and place bets autonomously. | **Open Claude Desktop settings** (or show the MCP config JSON in editor). Show the `mcpServers` config block with `@predix/mcp`. Highlight how short it is. |
| 2:28 | The agent calls predix market to check the current round. It evaluates the odds. It calls predix place bet. | **Switch to Claude Desktop.** Type a prompt like "What's the current Predix round?" Show Claude calling the MCP tool and getting the response. Then ask it to place a bet. |
| 2:42 | The platform builds an unsigned transaction. The agent signs locally. Its private key never leaves the machine. And the platform sponsors and broadcasts. | **Show Claude's response** with the bet confirmation. Highlight the flow in the response (unsigned tx -> sign -> broadcast). |
| 2:52 | Agents compete on a public leaderboard alongside human traders. You can see their win rate, profit and loss, return on investment, and total volume. | **Open predix.live/leaderboard** in the browser. Scroll through the rankings. Point out any agent entries if visible (or the agent badge column). |

---

## SECTION 5 -- TECHNICAL DEEP DIVE (3:00 - 4:15)

| Time | Narration (AI Voice) | Screen Action (You) |
|------|---------------------|---------------------|
| 3:00 | Under the hood, Predix is built entirely on Stacks and with finality on Bitcoin. | **Open Hiro Explorer** (explorer.hiro.so). Navigate to the predixv8 contract. Show it's a real deployed contract. |
| 3:08 | The smart contracts are written in Clarity. The main market contract uses a gateway-only pattern. All calls route through a thin proxy that enforces access control and round validation. | **Open the contract source** in the explorer or in VS Code (`contracts/predixv8.clar`). Scroll to show the gateway check (`asserts! (is-eq tx-sender (var-get gateway))`). |
| 3:20 | The gateway and sponsor addresses are timelocked, requiring 144 blocks, about 24 hours, to change. | **Scroll to the `schedule-gateway` / `activate-gateway` functions.** Highlight the 144-block constant. |
| 3:30 | Settlement uses Pyth Network as the oracle. A two-layer circuit breaker validates prices both server-side and on-chain, rejecting any settlement that shows signs of manipulation or stale data. | **Open VS Code** -> `app/api/cron/resolve/route.ts`. Scroll to the circuit breaker logic (price change check, divergence check). Then briefly show the on-chain price bound in the contract. |
| 3:48 | One percent of all fees stay in an on-chain jackpot treasury. Every day at nine PM Eastern, a Bitcoin block hash is used as verifiable randomness to draw a winner. Early and large bettors earn multiplied tickets, incentivizing active participation. | **Open predix.live/jackpot** in the browser. Show: (1) Treasury balance, (2) Ticket list with multipliers, (3) Draw history, (4) Countdown to next draw. |

---

## SECTION 6 -- CLOSING (4:15 - 4:50)

| Time | Narration (AI Voice) | Screen Action (You) |
|------|---------------------|---------------------|
| 4:15 | Predix is a production-grade prediction market with a complete agent platform. REST API. MCP server. Two SDKs. Webhooks. Discovery manifests. | **Open predix.live** homepage. Quick montage of tabs: (1) main market, (2) `/leaderboard`, (3) `/jackpot`, (4) `/history`. Switch between them briskly. |
| 4:30 | It is live on Stacks testnet at predix dot live. The GitHub repo includes full documentation, smart contract source, and the agent SDK packages. | **Open the GitHub repo** (github.com/LimaDevBTC/predix). Show the README briefly. Scroll to show the project structure. |
| 4:40 | We built this to prove that DeFi on Bitcoin can be fast, frictionless, and agent-ready. | **Back to predix.live.** Show a new round starting. Price ticking. Life in the market. |
| 4:47 | This is Predix. Thank you. | **Fade to black** with Predix logo + "predix.live" centered. Hold 3s. |

---

## PRE-RECORDING CHECKLIST

- [ ] Xverse wallet connected with test-usdcx balance (at least 20 USDCx)
- [ ] predix.live open and working (rounds resolving)
- [ ] Claude Desktop configured with MCP server (test it works before recording)
- [ ] Hiro Explorer tab ready with predixv8 contract open
- [ ] GitHub repo tab ready
- [ ] VS Code open with project loaded
- [ ] Competitor site tab ready (Polymarket or similar) for Section 2
- [ ] Screen resolution: 1920x1080
- [ ] Close all notifications, Slack, Discord, email
- [ ] Browser: clean tab bar, no bookmarks bar, dark theme
- [ ] Font size in VS Code: bump to 16-18px for readability

## POST-PRODUCTION NOTES

- Generate AI voiceover from the narration column (ElevenLabs, PlayHT, or similar)
- Sync narration audio to screen recording in your video editor
- Add subtle zoom-ins (1.2x-1.5x) when pointing at specific UI elements
- Add cursor highlight effect if your recording tool supports it
- No background music during demo sections (distraction). Light ambient track ok for intro/outro
- Export: 1080p60, H.264, ~20 Mbps bitrate
