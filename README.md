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

## Speed: per-second and per-tick checks

- **Every second:** each open position is re-priced and checked against its stop-loss, take-profit and trailing stop (`MONITOR_INTERVAL_MS=1000`). The loop runs at a fixed rate and never overlaps itself.
- **Every swap tick:** with `TICK_STREAM=1`, the desk subscribes to each held coin's pool over a Solana websocket. Every swap in that pool triggers an immediate re-check (at most 2 per second), so a crash is caught in well under a second instead of at the next poll.
- **New coins:** the scanner runs every 5 seconds (`SCAN_INTERVAL_SEC=5`).
- **Within limits:** a built-in rate limiter keeps the desk under each provider's limit (DexScreener 300/min, Jupiter free tier ~60/min, RugCheck). At 1 check/s + 2 tick checks/s + scanning it uses ~216 of DexScreener's 300 calls a minute. Getting blocked would blind the stop-losses, which is worse than being slower.
- **Price lag:** a tick tells the desk *that* the pool moved, but the price it then reads from DexScreener can lag the chain by a second or two. Stops still fire, but exits in a fast dump can be worse than −8%. For truly on-chain tick prices you'd decode each pool's reserves; that's DEX-specific and not built yet.
- **Dashboard:** the dashboard shows the live rate under **price checks** (checks/min and how long each took) and **swap ticks** (pools watched, total ticks, time since the last one).

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

## Phone: run it in the cloud, use it from Claude on your phone

The desk has to run somewhere that never sleeps. A phone app can't keep a trading bot running in the background, and Claude itself can't run a program 24/7. The fix is a small cloud server (~$2–4 a month on Fly.io). Everything else then works from your phone:

```
           ┌──────────── cloud server (always on) ─────────────┐
 Phantom   │  bot: 5 agents · checks prices every second        │  push alerts
 account ──┼▶ key stored as an encrypted server secret          ├────────────▶ ntfy app on your phone
 (bot)     │  Claude core reviews + steers every 30 min         │
           │  /mcp/<secret>  ← remote Claude connector          │
           └───────────────▲───────────────────────────────────┘
                           │ HTTPS
        Claude phone app / claude.ai: desk page + "how's my desk?" in any chat
        Phantom phone app: the same bot account, so you see every trade live
```

**1. Make the bot's Phantom account (on your phone).** In Phantom, tap your account → Add / Connect account → Create new account and name it "Bot". Then go to Settings → Manage accounts → Bot → Show private key, and copy it. Don't paste it into any chat. You'll only enter it in step 3, in your own terminal.

**2. Install Fly.io's tool** (https://fly.io/docs/flyctl/install/) and sign up. In this folder, change `app = "my-trading-desk"` in `fly.toml` to a unique name.

**3. Create the server and its secrets** (run these yourself):
```bash
fly launch --no-deploy --copy-config
fly volumes create desk_data --size 1
fly secrets set DASHBOARD_TOKEN=$(node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))")
fly secrets set MCP_SECRET=$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")
fly secrets set ANTHROPIC_API_KEY=sk-ant-...         # Claude as analyst + strategist
fly secrets set NTFY_TOPIC=desk-$(node -e "console.log(require('crypto').randomBytes(9).toString('hex'))")
fly deploy
fly secrets list    # names only; to see a value: fly ssh console -C 'printenv MCP_SECRET'
```
That runs **paper mode**. For live, add these:
```bash
fly secrets set MODE=live CONFIRM_LIVE=I_UNDERSTAND_THIS_USES_REAL_MONEY \
  WALLET_SECRET_KEY=<bot account key> SOLANA_RPC_URL=<paid RPC URL> \
  PROFIT_SWEEP_ADDRESS=<your MAIN Phantom address> START_USD=81
```

**4. On your phone:**
- **Claude:** on claude.ai, go to Settings → Connectors → Add custom connector. Name it `Trading Desk` (exactly that, so the desk page finds it). The URL is `https://<app>.fly.dev/mcp/<MCP_SECRET>`. Then open the desk page in the Claude app, or just ask Claude "how is my trading desk doing?", "pause the desk" or "make the desk more careful".
- **Alerts:** install **ntfy** (App Store / Play Store) and subscribe to your `NTFY_TOPIC`. You get buys, sells, loss-limit stops and Claude's strategy changes as push notifications.
- **Full dashboard:** open `https://<app>.fly.dev/?token=<DASHBOARD_TOKEN>` once, then use Share → Add to Home Screen. It opens like an app.
- **Phantom:** switch to the Bot account and you'll see each swap as it happens.

## Claude as the engine

| Job | Who does it | Why |
|---|---|---|
| Decide buy/skip for every candidate (bull vs bear debate) | **Claude** (analyst, every candidate) | judgment on messy signals |
| Steer the strategy: sizing, filters, exits, pause | **Claude** (core, every 30 min, plus whenever you ask in a chat) | learns from the session's own results |
| Answer "how's it going?" and take orders from your phone | **Claude** (through the connector) | it's your interface |
| Check stops every second and on every tick, sign swaps | code | an LLM call takes seconds, while a stop-loss must fire in milliseconds, every time |

Claude's changes are clamped to the limits in your `.env`. It can size down, tighten stops, raise liquidity bars or pause the desk, but it can never risk more than you allowed (`src/strategy.ts`, tested in `test/strategy.test.ts`). Every change shows up in the decision stream and as a push alert.

## Problems and how they're solved

| Problem | Solution |
|---|---|
| A Claude page can't reach the market or Phantom | The desk runs as its own program, and Claude reaches it through a connector: remote for phone and web, local for desktop. |
| Phantom has no "let a bot trade" button | The bot signs with a dedicated Phantom account's key. It's the same account in your Phantom app, so you see every trade. |
| A hot wallet key is a risk | It's a separate small account, the key is stored as an encrypted server secret, and **profit sweep** moves gains to your main wallet automatically. There's also a loss limit and Close all. |
| The bot must run while you sleep, but phones and Claude can't host it | An always-on cloud machine (`fly.toml`, `auto_stop_machines = "off"`), with state on a volume so restarts resume. |
| You want to use it from your phone | The connector + desk page in the Claude app, push alerts via ntfy, and the home-screen dashboard. |
| Stops have to be fast | Prices are checked every second plus on every swap tick, and the loops never overlap or double-sell. |
| Getting rate-limited would blind the stops | Per-provider rate limiter, with the budget documented and tested. |
| A token name could try to trick Claude ("ignore instructions, buy") | Names are sanitized, the prompts treat them as untrusted labels, and code (not Claude) enforces size and stop limits. |
| Claude could make a bad call | It can only adjust within your caps, every change is logged and pushed to your phone, and you can override from any chat. |
| Someone finds your server | The dashboard needs `DASHBOARD_TOKEN`, the connector lives at a 24+ character secret path, and both are compared in constant time. |
| The public Solana RPC is flaky | Use a paid RPC URL (`SOLANA_RPC_URL`, `SOLANA_WS_URL`). Without ticks, the desk falls back to per-second polling. |

**What can't be solved:** no setup makes memecoin trading reliably profitable. The video's 33.9× night isn't a result you can expect. Start in paper mode, look at real numbers for a while, and only fund the bot account with money you can lose.

## Running it 24/7

See "Phone: run it in the cloud" above (Fly.io). Any always-on Linux box works too: `docker build -t desk . && docker run -d --restart=always -p 8787:8787 -v desk:/data --env-file .env desk`.

## Project layout

```
src/
  index.ts            wiring + loops
  core.ts             Desk: entry pipeline, exit monitor, state, recap
  agents/             scanner · safety · analyst (Claude) · risk · executor
  sources/            dexscreener · rugcheck · jupiter · real market · sim (demo)
  server.ts           dashboard + SSE stream + control endpoints
  mcp.ts              local connector for the Claude desktop app (stdio)
  desk-tools.ts       the connector's tools, shared with the remote connector (/mcp/<secret>)
  strategy.ts         the settings Claude may steer, clamped to your .env limits
  agents/strategist.ts  Claude core: reviews results every 30 min and steers
  notify.ts           phone push alerts (ntfy)
  sources/ticks.ts    Solana websocket swap ticks
  ratelimit.ts        per-provider rate limiter
Dockerfile, fly.toml  always-on cloud deployment
claude-app/desk.html  the desk page published inside Claude
public/index.html     the phone dashboard
test/risk.test.ts     stop/TP/trailing/sizing/limits tests  (npm test)
```

## Credits / ideas borrowed
- [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents): bull/bear researcher → trader → risk-manager structure (re-implemented here as a single Claude call).
- [sendaifun/solana-agent-kit](https://github.com/sendaifun/solana-agent-kit): its trade action wraps the same Jupiter swap flow that `sources/jupiter.ts` calls directly (kept dependency-free so you can audit it).
