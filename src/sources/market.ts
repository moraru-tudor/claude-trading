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
}

/** Shared call counter so the dashboard can show "N calls" per source. */
export const calls: Record<string, number> = { dexscreener: 0, rugcheck: 0, jupiter: 0, claude: 0, solana: 0 };
export const countCall = (src: keyof typeof calls | string) => {
  calls[src] = (calls[src] ?? 0) + 1;
};
