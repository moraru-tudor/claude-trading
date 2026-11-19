# Claude Trading Desk

A 5-agent Solana memecoin trading desk with a live phone dashboard. It is modelled on the "trading desk" screen recordings that go around TikTok, but here every number comes from a real market and a real (or paper) wallet.

```
 SCANNER ─▶ SAFETY ─▶ ANALYST ─▶ RISK ─▶ EXECUTOR
 DexScreener  RugCheck +   Claude bull/   size 3-8%   Jupiter swap,
 new/boosted  Jupiter      bear debate    stop -8%    signed by your
 tokens       honeypot     (TradingAgents trailing,   bot wallet
              round-trip   pattern)       loss limit  (open it in Phantom)
                       ▲                                   │
                       └──── Claude core · monitor loop ◀──┘  exits: stop / TP / trail / max-hold
```

| Agent | What it really does | Source |
|---|---|---|
| **SCANNER** | Pulls the newest and boosted Solana tokens every 20s. Filters them on liquidity, market cap, age and 5m volume, then ranks by buy pressure and a steady (not vertical) move. | DexScreener API |
| **SAFETY** | Hard veto if the token has mint or freeze authority, unlocked LP, or RugCheck "danger" flags, or if a Jupiter **buy→sell round-trip quote** fails or loses more than 12% (a honeypot). | RugCheck + Jupiter |
| **ANALYST** | Runs a TradingAgents-style debate in one structured Claude call: a bull researcher, a bear researcher, then a trader who decides buy/skip, a confidence and a take-profit. Without an API key it uses a rule-based analyst. | Claude (`claude-opus-5-5`) |
| **RISK** | Sizes each trade at 3–8% of equity, scaled by confidence. It caps size at `MAX_POSITION_USD` and 0.5% of pool liquidity. It allows at most 4 open positions, sets a −8% stop, and pauses the desk at the session loss limit. | local |
| **EXECUTOR** | **paper**: realistic fills with fees and AMM price impact. **live**: Jupiter quote → swap transaction → signed with your bot wallet's key → sent to Solana. | Jupiter + Solana RPC |

## ⚠️ Read this first

- **The video you may have seen is not evidence that this works.** "$81 → $2,745 overnight, 77% win rate" clips are marketing, and often lead to "bot" apps that drain your wallet. No honest bot can promise returns. Most memecoins go to zero. Expect to lose money in live mode, especially at first.
- **Never give any bot, website or "Grok/Claude bot" app your main wallet's seed phrase or private key.** This bot only uses a **separate burner wallet** that you fund with an amount you can lose.
- Be careful with memecoin-bot repos on GitHub. Many contain key stealers (for example, a GitHub search for the video's `ai-memecoin-trading-bot` finds no repo with the 63 stars it shows, only 0-star copies). Read any code before you run it, including this code.
- Not financial advice. Check the laws and tax rules where you live.

## Quick start

```bash
npm install
cp .env.example .env
npm run demo     # offline simulated market: preview the UI (numbers are NOT real)
npm run paper    # REAL prices from DexScreener/Jupiter, fake money. Run this for days first.
```

Open the URL it prints (default `http://127.0.0.1:8787`).

**Use Claude as the analyst:** put `ANTHROPIC_API_KEY=...` in `.env`. The model is `claude-opus-5-5` at `ANALYST_EFFORT=low`, with at most `MAX_ANALYST_CALLS_PER_HOUR=60` calls. Claude only sees candidates that already passed the Scanner and Safety, so cost stays low (roughly a few cents per candidate). Server-side refusal fallback is enabled, so a declined request is retried on a fallback model instead of failing.

**On your phone:** set `HOST=0.0.0.0` and a `DASHBOARD_TOKEN`. Then open `http://<your-computer-ip>:8787/?token=...` on the same Wi-Fi and use "Add to Home Screen".

## Going live (real money)

1. In **Phantom**, create a **new account** used only for the bot. Go to Settings → that account → **Export private key**.
2. Send it a small amount of SOL (e.g. the $81 from the video), plus ~0.02 SOL for fees.
3. In `.env`:
   ```
   MODE=live
   CONFIRM_LIVE=I_UNDERSTAND_THIS_USES_REAL_MONEY
   WALLET_SECRET_KEY=<that exported key>
   START_USD=81
   SOLANA_RPC_URL=<a paid RPC, e.g. Helius/QuickNode – the public one rate-limits>
   ```
4. `npm run live`. Every swap appears in Phantom under that account, because it's the same keypair.

Phantom itself has no API that lets a program approve trades for you. A bot either signs with a key (this approach) or asks you to tap "approve" on every trade. A desk that trades unattended while you sleep has to hold a key, so keep that wallet small.

### Safety controls
- **Pause / Resume / Close all** buttons on the dashboard (`POST /api/pause`, `/api/resume`, `/api/close-all`).
- `DAILY_LOSS_LIMIT_PCT` (default 30%) pauses new entries automatically.
- `SESSION_HOURS` (default 10, like the video's 22:00→08:00): after this, no new entries; open positions are still managed, and the recap sheet opens.
- `MAX_POSITION_USD`, `MAX_OPEN_POSITIONS`, `SLIPPAGE_BPS`, `MAX_PRIORITY_FEE_LAMPORTS`, and a 5% price-impact refusal in live mode.
- State lives in `data/state-<mode>.json`. Restarting resumes the session; set `RESET=1` to start a new one.

## Run it inside the Claude app (desktop)

The desk screen also exists as a page inside Claude (`claude-app/desk.html`, published as a Claude artifact). Pages inside Claude run in a locked-down frame that can't reach the market or Phantom. They can, however, reach a **local connector** on your computer through the Claude desktop app. So the setup is:

```
Phantom bot account key ──▶ bot on your computer (npm run paper / live) ──▶ Solana
   (stays in .env)                     ▲  local HTTP
                                       │
             trading-desk connector (src/mcp.ts, started by the Claude desktop app)
                                       ▲
                     desk page inside the Claude desktop app
```

1. Start the bot: `npm run paper` (or `npm run live`). Leave it running.
2. Open the Claude desktop app → Settings → Developer → Edit Config, and add this to `claude_desktop_config.json` (use your real folder path):
   ```json
   {
     "mcpServers": {
       "trading-desk": {
         "command": "npx",
         "args": ["-y", "tsx", "/full/path/to/claude-trading/src/mcp.ts"],
         "env": { "DESK_URL": "http://127.0.0.1:8787", "DASHBOARD_TOKEN": "" }
       }
     }
   }
   ```
   On Windows use a path like `C:\\Users\\you\\claude-trading\\src\\mcp.ts`. If you set `DASHBOARD_TOKEN` in `.env`, put the same value here.
3. Restart the Claude desktop app, open the desk page, and choose **Allow** for `trading-desk`.

The page shows live equity, the 5 agents, open positions and the decision stream, and has Pause / Resume / Close all buttons. You can also just ask Claude in a chat: "how is my trading desk doing?" or "pause the desk".

Notes:
- **You never paste your private key into Claude.** It only lives in `.env` on your computer. The connector and the page never see it.
- Only the Claude **desktop** app can reach local connectors. The phone app and claude.ai in a browser show a "connect" screen instead.
- The bot keeps trading when Claude is closed. Claude is the window and remote control, not the engine.

## Running it 24/7

The Claude app can't keep a process running overnight. Run the desk on a computer that stays on, or on a small VPS (`npm run paper` under `pm2`/`systemd`), and open the dashboard from your phone.

## Project layout

```
src/
  index.ts            wiring + loops
  core.ts             Desk: entry pipeline, exit monitor, state, recap
  agents/             scanner · safety · analyst (Claude) · risk · executor
  sources/            dexscreener · rugcheck · jupiter · real market · sim (demo)
  server.ts           dashboard + SSE stream + control endpoints
  mcp.ts              trading-desk connector for the Claude desktop app
claude-app/desk.html  the desk page published inside Claude
public/index.html     the phone dashboard
test/risk.test.ts     stop/TP/trailing/sizing/limits tests  (npm test)
```

## Credits / ideas borrowed
- [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents): bull/bear researcher → trader → risk-manager structure (re-implemented here as a single Claude call).
- [sendaifun/solana-agent-kit](https://github.com/sendaifun/solana-agent-kit): its trade action wraps the same Jupiter swap flow that `sources/jupiter.ts` calls directly (kept dependency-free so you can audit it).
