import "dotenv/config";

export type Mode = "demo" | "paper" | "live";

const str = (k: string, d: string) => (process.env[k] ?? "").trim() || d;
const num = (k: string, d: number) => {
  const v = (process.env[k] ?? "").trim();
  if (!v) return d;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${k} must be a number, got "${v}"`);
  return n;
};

const mode = str("MODE", "paper") as Mode;
if (!["demo", "paper", "live"].includes(mode)) throw new Error(`MODE must be demo | paper | live`);

export const config = {
  mode,
  confirmLive: process.env.CONFIRM_LIVE === "I_UNDERSTAND_THIS_USES_REAL_MONEY",
  startUsd: num("START_USD", 81),
  sessionHours: num("SESSION_HOURS", 10),

  analyst: str("ANALYST", process.env.ANTHROPIC_API_KEY ? "claude" : "rules") as "claude" | "rules",
  analystModel: str("ANALYST_MODEL", "claude-opus-5-5"),
  analystEffort: str("ANALYST_EFFORT", "low") as "low" | "medium" | "high",
  maxAnalystCallsPerHour: num("MAX_ANALYST_CALLS_PER_HOUR", 60),

  minPositionPct: num("MIN_POSITION_PCT", 3),
  maxPositionPct: num("MAX_POSITION_PCT", 8),
  maxPositionUsd: num("MAX_POSITION_USD", 25),
  maxOpenPositions: num("MAX_OPEN_POSITIONS", 4),
  stopLossPct: num("STOP_LOSS_PCT", 8),
  takeProfitPct: num("TAKE_PROFIT_PCT", 30),
  trailArmPct: num("TRAIL_ARM_PCT", 15),
  trailPct: num("TRAIL_PCT", 10),
  maxHoldMin: num("MAX_HOLD_MIN", 60),
  dailyLossLimitPct: num("DAILY_LOSS_LIMIT_PCT", 30),

  minLiquidityUsd: num("MIN_LIQUIDITY_USD", 15_000),
  minMcapUsd: num("MIN_MCAP_USD", 50_000),
  maxMcapUsd: num("MAX_MCAP_USD", 25_000_000),
  minAgeMin: num("MIN_AGE_MIN", 3),
  maxAgeHours: num("MAX_AGE_HOURS", 72),
  minVolM5Usd: num("MIN_VOL_M5_USD", 2_000),

  // How often the scanner looks for new coins (DexScreener's discovery feeds allow ~1 call/s).
  scanIntervalSec: Math.max(2, num("SCAN_INTERVAL_SEC", 5)),
  // How often open positions are re-priced and checked against stop / take-profit (ms). 1000 = every second.
  monitorIntervalMs: Math.max(250, process.env.MONITOR_INTERVAL_SEC ? num("MONITOR_INTERVAL_SEC", 1) * 1000 : num("MONITOR_INTERVAL_MS", 1000)),
  // Tick stream: watch each held coin's pool on Solana and re-check on every swap (sub-second reaction).
  tickStream: str("TICK_STREAM", "1") === "1",
  // Smallest gap between two tick-triggered checks (ms).
  // 500 ms = at most 2 tick checks/s, which keeps 1/s polling + ticks + scanning under DexScreener's 300/min.
  tickDebounceMs: Math.max(100, num("TICK_DEBOUNCE_MS", 500)),
  // Per-second prices from: dexscreener (pool price) or jupiter (aggregated price API).
  priceSource: str("PRICE_SOURCE", "dexscreener") as "dexscreener" | "jupiter",
  paperFeePct: num("PAPER_FEE_PCT", 0.5),

  walletSecret: str("WALLET_SECRET_KEY", ""),
  rpcUrl: str("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com"),
  wsUrl: str("SOLANA_WS_URL", ""),
  jupiterBase: str("JUPITER_BASE_URL", "https://lite-api.jup.ag/swap/v1"),
  jupiterApiKey: str("JUPITER_API_KEY", ""),
  slippageBps: num("SLIPPAGE_BPS", 300),
  maxPriorityFeeLamports: num("MAX_PRIORITY_FEE_LAMPORTS", 1_000_000),
  solFeeReserve: num("SOL_FEE_RESERVE", 0.02),

  port: num("PORT", 8787),
  host: str("HOST", "127.0.0.1"),
  dashboardToken: str("DASHBOARD_TOKEN", ""),
  dataDir: str("DATA_DIR", "data"),
  reset: process.env.RESET === "1",
};

export type Config = typeof config;

export function validateConfig(c: Config) {
  if (c.mode === "live") {
    if (!c.confirmLive)
      throw new Error("MODE=live requires CONFIRM_LIVE=I_UNDERSTAND_THIS_USES_REAL_MONEY in .env");
    if (!c.walletSecret) throw new Error("MODE=live requires WALLET_SECRET_KEY (a dedicated burner wallet)");
  }
  if (c.minPositionPct > c.maxPositionPct) throw new Error("MIN_POSITION_PCT > MAX_POSITION_PCT");
  if (c.stopLossPct <= 0 || c.stopLossPct >= 100) throw new Error("STOP_LOSS_PCT must be between 0 and 100");
  if (c.host !== "127.0.0.1" && c.host !== "localhost" && !c.dashboardToken)
    throw new Error("Set DASHBOARD_TOKEN when exposing the dashboard beyond localhost (HOST)");
}
