import { config } from "./config.js";

/**
 * The knobs Claude may turn while the desk runs (from the strategist agent every 30 min, or when you
 * ask Claude in a chat). Every change is clamped to bounds fixed at startup from YOUR .env:
 * Claude can make the desk more careful, or tune exits, but can never size bigger, loosen the stop,
 * hold more coins, or accept thinner liquidity than you configured.
 */
export interface Strategy {
  minPositionPct: number;
  maxPositionPct: number;
  stopLossPct: number;
  takeProfitPct: number;
  trailArmPct: number;
  trailPct: number;
  maxHoldMin: number;
  maxOpenPositions: number;
  minLiquidityUsd: number;
  minVolM5Usd: number;
}

const startup = {
  maxPositionPct: config.maxPositionPct,
  stopLossPct: config.stopLossPct,
  maxOpenPositions: config.maxOpenPositions,
  minLiquidityUsd: config.minLiquidityUsd,
  minVolM5Usd: config.minVolM5Usd,
};

/** [min, max] per knob. Risk-increasing directions are capped at the .env value. */
export const bounds: Record<keyof Strategy, [number, number]> = {
  minPositionPct: [0.5, startup.maxPositionPct],
  maxPositionPct: [0.5, startup.maxPositionPct],
  stopLossPct: [2, startup.stopLossPct],
  takeProfitPct: [5, 150],
  trailArmPct: [3, 80],
  trailPct: [2, 40],
  maxHoldMin: [3, 360],
  maxOpenPositions: [0, startup.maxOpenPositions],
  minLiquidityUsd: [startup.minLiquidityUsd, 2_000_000],
  minVolM5Usd: [startup.minVolM5Usd, 500_000],
};

export const KEYS = Object.keys(bounds) as (keyof Strategy)[];

export function currentStrategy(): Strategy {
  return Object.fromEntries(KEYS.map((k) => [k, config[k]])) as unknown as Strategy;
}

export interface StrategyChange { key: keyof Strategy; from: number; to: number; clamped: boolean }

/** Apply a partial change, clamped to bounds. Unknown keys and non-numbers are ignored. */
export function applyStrategy(patch: Partial<Record<string, unknown>>): StrategyChange[] {
  const changes: StrategyChange[] = [];
  for (const k of KEYS) {
    const raw = patch[k];
    if (raw === undefined || raw === null) continue;
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    const [lo, hi] = bounds[k];
    let to = Math.min(hi, Math.max(lo, v));
    if (k === "maxOpenPositions") to = Math.round(to);
    const from = config[k];
    if (Math.abs(to - from) < 1e-9) continue;
    (config as Record<string, unknown>)[k] = to;
    changes.push({ key: k, from, to, clamped: to !== v });
  }
  if (config.minPositionPct > config.maxPositionPct) config.minPositionPct = config.maxPositionPct;
  return changes;
}

export const describeChanges = (c: StrategyChange[]) =>
  c.map((x) => `${x.key} ${round(x.from)}→${round(x.to)}${x.clamped ? " (capped)" : ""}`).join(", ");
const round = (n: number) => (Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10);
