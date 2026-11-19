import { config } from "../config.js";
import type { SafetyReport, TokenSnapshot } from "../types.js";
import { latestSolanaMints, solPriceUsd, tokenSnapshots } from "./dexscreener.js";
import { roundTrip } from "./jupiter.js";
import type { Market } from "./market.js";
import { rugcheckSummary } from "./rugcheck.js";

export class RealMarket implements Market {
  readonly kind = "real" as const;
  private solCache = { px: 0, at: 0 };

  async discover(): Promise<TokenSnapshot[]> {
    const mints = await latestSolanaMints();
    const snaps = await tokenSnapshots(mints.slice(0, 90));
    return [...snaps.values()];
  }

  snapshots(mints: string[]) {
    return tokenSnapshots(mints);
  }

  async solPriceUsd() {
    if (Date.now() - this.solCache.at > 60_000) this.solCache = { px: await solPriceUsd(), at: Date.now() };
    return this.solCache.px;
  }

  async safety(t: TokenSnapshot): Promise<SafetyReport> {
    const reasons: string[] = [];
    const [rug, rt] = await Promise.allSettled([rugcheckSummary(t.mint), roundTrip(t.mint)]);

    let lp: SafetyReport["lp"] = "unknown";
    let mintAuthority: boolean | null = null, freezeAuthority: boolean | null = null, riskScore: number | null = null;
    if (rug.status === "fulfilled") {
      const r = rug.value;
      mintAuthority = r.mintAuthority; freezeAuthority = r.freezeAuthority; riskScore = r.riskScore;
      if (r.mintAuthority) reasons.push("mint authority enabled");
      if (r.freezeAuthority) reasons.push("freeze authority enabled");
      for (const d of r.dangers) if (!/authority/i.test(d)) reasons.push(d.toLowerCase());
      const lpBad = r.dangers.some((d) => /lp|liquidity/i.test(d));
      lp = lpBad ? "fail" : r.lpLockedPct !== null && r.lpLockedPct < 50 && t.dexId !== "pumpswap" ? "fail" : "pass";
      if (lp === "fail" && !lpBad) reasons.push(`LP only ${Math.round(r.lpLockedPct ?? 0)}% locked`);
    } else reasons.push("rugcheck unavailable");

    let honeypot: SafetyReport["honeypot"] = "unknown";
    let roundTripLossPct: number | null = null;
    if (rt.status === "fulfilled") {
      roundTripLossPct = rt.value.lossPct;
      honeypot = rt.value.sellable && (rt.value.lossPct ?? 100) < 12 ? "pass" : "fail";
      if (honeypot === "fail") reasons.push(rt.value.sellable ? `round-trip loss ${rt.value.lossPct?.toFixed(1)}%` : "no sell route");
    } else reasons.push("jupiter quote failed");

    if (t.liquidityUsd < config.minLiquidityUsd) reasons.push("liquidity too thin");
    const ok = honeypot === "pass" && lp === "pass" && !mintAuthority && !freezeAuthority && reasons.length === 0;
    return { ok, honeypot, lp, mintAuthority, freezeAuthority, riskScore, roundTripLossPct, reasons };
  }
}
