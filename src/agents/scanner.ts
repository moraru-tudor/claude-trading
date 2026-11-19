import { config } from "../config.js";
import type { Market } from "../sources/market.js";
import type { TokenSnapshot } from "../types.js";

/**
 * SCANNER – pulls freshly listed / boosted Solana tokens and ranks them by short-term momentum.
 * Pure filters + a score; no LLM. Fast and cheap so it can run every ~20s.
 */
export class Scanner {
  private seen = new Map<string, number>(); // mint -> last time we forwarded it
  private scanLog: { t: number; n: number }[] = [];

  constructor(private market: Market) {}

  /** tokens scanned in the last hour (the "1,983/h" number on the dashboard) */
  perHour() {
    const cut = Date.now() - 3_600_000;
    this.scanLog = this.scanLog.filter((s) => s.t > cut);
    return this.scanLog.reduce((a, s) => a + s.n, 0);
  }

  async scan(exclude: Set<string>): Promise<{ scanned: number; picks: TokenSnapshot[] }> {
    const all = await this.market.discover();
    this.scanLog.push({ t: Date.now(), n: all.length });
    const now = Date.now();
    const picks = all
      .filter((t) => !exclude.has(t.mint))
      .filter((t) => (this.seen.get(t.mint) ?? 0) < now - 10 * 60_000) // don't re-analyse the same coin for 10 min
      .filter((t) => passesFilters(t, now))
      .map((t) => ({ t, s: momentumScore(t) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 3)
      .map((x) => x.t);
    for (const p of picks) this.seen.set(p.mint, now);
    return { scanned: all.length, picks };
  }
}

export function passesFilters(t: TokenSnapshot, now = Date.now()) {
  const ageMin = t.pairCreatedAt ? (now - t.pairCreatedAt) / 60_000 : Infinity;
  return (
    t.priceUsd > 0 &&
    t.liquidityUsd >= config.minLiquidityUsd &&
    t.marketCap >= config.minMcapUsd &&
    t.marketCap <= config.maxMcapUsd &&
    ageMin >= config.minAgeMin &&
    ageMin <= config.maxAgeHours * 60 &&
    t.volM5 >= config.minVolM5Usd
  );
}

/** Positive = interesting. Rewards buy pressure and steady (not parabolic) 5m/1h moves. */
export function momentumScore(t: TokenSnapshot) {
  const flow = (t.buysM5 + 1) / (t.sellsM5 + 1);
  if (flow < 1.1) return 0;
  if (t.chgM5 <= 0 || t.chgH1 <= 0) return 0;
  if (t.chgM5 > 60 || t.chgH1 > 400) return 0; // already went vertical — chasing tops is how bots die
  const volLiq = t.volH1 / Math.max(t.liquidityUsd, 1);
  return Math.log(flow) * 2 + Math.min(t.chgM5, 30) / 10 + Math.min(volLiq, 5) / 2;
}
