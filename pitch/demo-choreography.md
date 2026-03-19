# Demo Choreography -- Shot-by-Shot Recording Guide

Follow this script exactly. Each shot is independent -- you can record them separately and stitch together in editing.

---

## Pre-Recording Setup

1. Open Chrome. Remove bookmarks bar (Ctrl+Shift+B). Close all tabs except Predix.
2. Set browser zoom to 100%.
3. Screen resolution: 1920x1080.
4. Dark mode on OS (matches Predix theme).
5. Have Xverse wallet extension installed and logged in with test tokens.
6. Have a code editor (VS Code) open with the MCP config file ready.
7. Have a terminal open with the TypeScript SDK example ready (optional, for agent demo).
8. Close all notifications, Slack, Discord, etc.

---

## Shot List

### SHOT 1: Opening Slide (5 seconds)

**What to record:** Open `pitch/slide-01-opening.html` in browser (full screen, F11).
**Duration:** Hold for 5 seconds. No mouse movement.
**Audio:** Voiceover lines 1-3 play over this.

---

### SHOT 2: Problem Slide (8 seconds)

**What to record:** Open `pitch/slide-02-problem.html` in browser (full screen).
**Duration:** Hold for 8 seconds.
**Audio:** "Prediction markets today have three core problems..." through "...trade autonomously."

---

### SHOT 3: Solution Slide (5 seconds)

**What to record:** Open `pitch/slide-03-solution.html` in browser (full screen).
**Duration:** Hold for 5 seconds.
**Audio:** "Predix solves all three."

---

### SHOT 4: Live Demo -- Market Overview (15 seconds)

**What to record:** Navigate to `https://www.predix.live`. Wait for a round to be in progress.
**Actions (timed):**
- 0s: Page loads. Let the price chart animate for 3 seconds.
- 3s: Slowly move cursor to the countdown timer. Pause 2 seconds.
- 5s: Move cursor to the UP pool total. Pause 1 second.
- 6s: Move cursor to the DOWN pool total. Pause 1 second.
- 7s: Move cursor to the BTC price display. Hold.
**Audio:** "Every round lasts sixty seconds. You see the live BTC price..." through "...pool sizes for UP and DOWN."

---

### SHOT 5: Live Demo -- Placing a Bet (20 seconds)

**What to record:** Still on predix.live, during an active round (at least 30 seconds remaining).
**Actions (timed):**
- 0s: Click the UP button. The amount input appears.
- 2s: Type "5" in the amount field. Pause 1 second.
- 4s: Click the "Bet UP" confirmation button. Xverse wallet popup appears.
- 6s: Pause on the wallet popup. Let the viewer see the fee shows $0.00 or "Sponsored".
- 9s: Click "Confirm" in the wallet.
- 11s: The bet is submitted. Show the pool total updating (optimistic state).
- 13s: Wait. Let the countdown continue ticking down.
- 15s: If the round resolves during recording, capture the resolution animation.
**Audio:** "I am placing a five dollar bet on UP..." through "...There is nothing to claim."

**Fallback:** If the round does not resolve during this shot, cut to the next shot. The voiceover covers it.

---

### SHOT 6: Live Demo -- Round Resolution (10 seconds)

**What to record:** Wait for a round to end and resolve. Capture the moment the outcome appears.
**Actions:**
- 0s: Countdown hits 0.
- 2s: The resolution result appears (UP or DOWN outcome, green or red).
- 4s: If you won, capture the confetti animation.
- 6s: Show the payout appearing in the trade history or result display.
**Audio:** "When the round ends, the settlement cron fetches the close price..." through "...Automatic payout."

**Tip:** You may need to record several rounds to capture a clean resolution. Pick the best take.

---

### SHOT 7: Agent Platform Slide (5 seconds)

**What to record:** Open `pitch/slide-04-agent-platform.html` in browser (full screen).
**Duration:** Hold for 5 seconds.
**Audio:** "But Predix is not just for humans. It is agent-native from the ground up."

---

### SHOT 8: MCP Configuration (10 seconds)

**What to record:** Open VS Code with the MCP JSON config visible.
**Actions:**
- 0s: Show the code editor with the JSON block. Font size should be large enough to read (16-18px).
- 3s: Slowly highlight the "predix" server block with your cursor.
- 6s: Highlight the env vars section.
**Audio:** "Here is an MCP configuration for Claude Desktop. Add six lines of JSON..."

**Alternative:** You can open `pitch/slide-04-agent-platform.html` which already has the code block styled.

---

### SHOT 9: Agent Trading Demo (15 seconds)

**What to record:** Choose ONE of these options:

**Option A -- Claude Desktop / Cursor (preferred):**
- Open Claude Desktop or Cursor with the MCP server configured.
- Show Claude calling `predix_market` and receiving market data.
- Show Claude calling `predix_place_bet` and placing a bet.

**Option B -- Terminal with SDK:**
- Open a terminal. Run a simple script that calls `client.market()` and `client.bet('UP', 5)`.
- Show the JSON response with round data.
- Show the txid returned from the bet.

**Option C -- REST API (simplest):**
- Open a terminal. Run:
  ```
  curl -s https://www.predix.live/api/agent/market | jq .
  ```
- Show the JSON response with round ID, pools, odds.

**Audio:** "The agent calls predix market to check the current round..." through "...the platform sponsors and broadcasts."

---

### SHOT 10: Agent Leaderboard (8 seconds)

**What to record:** Navigate to `https://www.predix.live/agents`.
**Actions:**
- 0s: Page loads. Show the ecosystem stats at the top (registered agents, active 24h, volume).
- 3s: Scroll down slowly to show the agent rankings table.
- 5s: Click a sort tab (e.g., "Win Rate") to show sorting works.
**Audio:** "Agents compete on a public leaderboard alongside human traders..."

---

### SHOT 11: Tech Architecture Slide (10 seconds)

**What to record:** Open `pitch/slide-05-tech-stack.html` in browser (full screen).
**Duration:** Hold for 10 seconds.
**Audio:** "Under the hood, Predix is built entirely on Stacks..." through "...stale data."

---

### SHOT 12: Jackpot Page (8 seconds)

**What to record:** Navigate to `https://www.predix.live/jackpot`.
**Actions:**
- 0s: Page loads. Show the treasury balance card.
- 3s: Show the countdown to next draw.
- 5s: Scroll down to show draw history table.
**Audio:** "One percent of all fees stay in an on-chain jackpot treasury..."

---

### SHOT 13: Closing Slide (8 seconds)

**What to record:** Open `pitch/slide-06-closing.html` in browser (full screen).
**Duration:** Hold for 8 seconds. No mouse movement.
**Audio:** "Predix is a production-grade prediction market..." through "This is Predix. Thank you."

---

## Editing Guide

### Recommended Software
- **Quick and free:** CapCut (desktop), DaVinci Resolve (free tier), or Canva Video
- **Simple option:** OBS for recording + CapCut for assembly

### Assembly Order
1. Shot 1 (Opening) -- 5s
2. Shot 2 (Problem) -- 8s
3. Shot 3 (Solution) -- 5s
4. Shot 4 (Market overview) -- 15s
5. Shot 5 (Placing bet) -- 20s
6. Shot 6 (Resolution) -- 10s
7. Shot 7 (Agent slide) -- 5s
8. Shot 8 (MCP config) -- 10s
9. Shot 9 (Agent demo) -- 15s
10. Shot 10 (Leaderboard) -- 8s
11. Shot 11 (Tech slide) -- 10s
12. Shot 12 (Jackpot) -- 8s
13. Shot 13 (Closing) -- 8s

**Total: ~127 seconds of footage = ~4 minutes 15 seconds with transitions**

### Transitions
- Use simple **fade to black** (0.3s) between shots. No fancy transitions.
- Between slides and live demo, a quick fade is enough.

### Audio
1. Generate voiceover from `voiceover-script.txt` using ElevenLabs or PlayHT.
2. Recommended voice: Male, American English, professional tone (e.g., "Adam" on ElevenLabs).
3. Lay the audio track first, then align the video clips to match the voiceover timing.
4. No background music needed. If you want it, use something minimal and low volume (20% of voice).

### Export Settings
- Resolution: 1920x1080 (1080p)
- Frame rate: 30 fps
- Format: MP4 (H.264)
- Target file size: under 100MB
