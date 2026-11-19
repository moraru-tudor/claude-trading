import type { SafetyReport, TokenSnapshot } from "../types.js";

/** Where the desk gets data from. RealMarket = DexScreener + RugCheck + Jupiter. SimMarket = offline demo. */
export interface Market {
  readonly kind: "real" | "sim";
  /** Fresh Solana tokens worth looking at (already enriched with pair stats). */
  discover(): Promise<TokenSnapshot[]>;
  /** Current stats for specific mints. */
  snapshots(mints: string[]): Promise<Map<string, TokenSnapshot>>;
  safety(token: TokenSnapshot): Promise<SafetyReport>;
  solPriceUsd(): Promise<number>;
  /** Fast price check for held coins (called every second). `snap` is included when the source returns full stats. */
  priceTick(mints: string[]): Promise<Map<string, { price: number; snap?: TokenSnapshot }>>;
  /** Keep a live swap-tick subscription on exactly these pools; `onTick(mint)` fires on every swap. */
  syncTicks(pools: { mint: string; pair?: string }[], onTick: (mint: string) => void): void;
  tickStats(): { ticks: number; lastTickAt: number; streams: number; error: string };
}

/** Shared call counter so the dashboard can show "N calls" per source. */
export const calls: Record<string, number> = { dexscreener: 0, rugcheck: 0, jupiter: 0, claude: 0, solana: 0 };
export const countCall = (src: keyof typeof calls | string) => {
  calls[src] = (calls[src] ?? 0) + 1;
};
