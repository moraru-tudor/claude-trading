import { config } from "../config.js";
import type { AnalystVerdict, Position, TokenSnapshot } from "../types.js";
import { clamp } from "../util.js";

/**
 * RISK – decides size and whether a new trade is allowed at all.
 * Size = 3-8% of equity scaled by analyst confidence, capped in USD and by impact on the pool.
 */
export interface RiskDecision { allow: boolean; sizeUsd: number; sizePct: number; stopPct: number; reason: string }

export function sizeTrade(
  v: AnalystVerdict, t: TokenSnapshot,
  st: { equityUsd: number; cashUsd: number; positions: Position[]; sessionStartEquity: number; paused: boolean; sessionOver: boolean },
): RiskDecision {
  const stopPct = config.stopLossPct;
  const no = (reason: string): RiskDecision => ({ allow: false, sizeUsd: 0, sizePct: 0, stopPct, reason });
  if (st.paused) return no("desk paused");
  if (st.sessionOver) return no("session over — no new entries");
  if (st.positions.length >= config.maxOpenPositions) return no(`max ${config.maxOpenPositions} open positions`);
  if (st.positions.some((p) => p.mint === t.mint)) return no("already holding");
  const ddPct = (1 - st.equityUsd / st.sessionStartEquity) * 100;
  if (ddPct >= config.dailyLossLimitPct) return no(`loss limit hit (-${ddPct.toFixed(1)}%)`);

  const pct = clamp(config.minPositionPct + (config.maxPositionPct - config.minPositionPct) * v.confidence, config.minPositionPct, config.maxPositionPct);
  let usd = (st.equityUsd * pct) / 100;
  usd = Math.min(usd, config.maxPositionUsd, t.liquidityUsd * 0.005, st.cashUsd * 0.95);
  if (usd < 1) return no("size below $1");
  return { allow: true, sizeUsd: usd, sizePct: (usd / st.equityUsd) * 100, stopPct, reason: "ok" };
}

/** Exit rules, checked every few seconds for each open position. */
export function exitSignal(p: Position, price: number, now = Date.now()): string | null {
  const chg = (price / p.entryPrice - 1) * 100;
  if (chg <= -p.stopPct + 1e-9) return "stop loss"; // epsilon: exactly -8% must trigger
  if (chg >= p.takeProfitPct) return "take profit";
  const fromHigh = (1 - price / p.highPrice) * 100;
  const peak = (p.highPrice / p.entryPrice - 1) * 100;
  if (peak >= config.trailArmPct && fromHigh >= config.trailPct) return "trailing stop";
  if (now - p.openedAt > config.maxHoldMin * 60_000) return "max hold time";
  return null;
}
