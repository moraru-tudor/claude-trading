import type { Market } from "../sources/market.js";
import type { SafetyReport, TokenSnapshot } from "../types.js";

/**
 * SAFETY – rugcheck (mint/freeze authority, LP lock, known dangers) + Jupiter round-trip
 * honeypot test (can we actually sell what we buy?). Any failure = hard veto.
 */
export class Safety {
  private cache = new Map<string, { at: number; r: SafetyReport }>();
  constructor(private market: Market) {}

  async check(t: TokenSnapshot): Promise<SafetyReport> {
    const c = this.cache.get(t.mint);
    if (c && Date.now() - c.at < 5 * 60_000) return c.r;
    const r = await this.market.safety(t);
    this.cache.set(t.mint, { at: Date.now(), r });
    return r;
  }
}
