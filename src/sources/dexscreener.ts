import { fetchJson, sanitizeLabel } from "../util.js";
import { countCall } from "./market.js";
import type { TokenSnapshot } from "../types.js";

// Public API, no key. Limits: profiles/boosts 60 req/min, tokens 300 req/min.
const BASE = "https://api.dexscreener.com";

interface Profile { chainId: string; tokenAddress: string; icon?: string }
interface Pair {
  chainId: string; dexId: string; pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceUsd?: string;
  txns?: Record<string, { buys: number; sells: number }>;
  volume?: Record<string, number>;
  priceChange?: Record<string, number>;
  liquidity?: { usd?: number };
  fdv?: number; marketCap?: number; pairCreatedAt?: number;
  info?: { imageUrl?: string };
}

export async function latestSolanaMints(): Promise<string[]> {
  const [profiles, boosts] = await Promise.all([
    fetchJson<Profile[]>(`${BASE}/token-profiles/latest/v1`).catch(() => [] as Profile[]),
    fetchJson<Profile[]>(`${BASE}/token-boosts/latest/v1`).catch(() => [] as Profile[]),
  ]);
  countCall("dexscreener"); countCall("dexscreener");
  const set = new Set<string>();
  for (const p of [...profiles, ...boosts]) if (p.chainId === "solana" && p.tokenAddress) set.add(p.tokenAddress);
  return [...set];
}

/** Best (most liquid) pair per mint, max 30 mints per request. */
export async function tokenSnapshots(mints: string[]): Promise<Map<string, TokenSnapshot>> {
  const out = new Map<string, TokenSnapshot>();
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    const pairs = await fetchJson<Pair[]>(`${BASE}/tokens/v1/solana/${chunk.join(",")}`);
    countCall("dexscreener");
    for (const p of pairs ?? []) {
      const mint = p.baseToken?.address;
      if (!mint || !chunk.includes(mint)) continue;
      const liq = p.liquidity?.usd ?? 0;
      const prev = out.get(mint);
      if (prev && prev.liquidityUsd >= liq) continue;
      out.set(mint, toSnapshot(p));
    }
  }
  return out;
}

export async function solPriceUsd(): Promise<number> {
  const SOL = "So11111111111111111111111111111111111111112";
  const pairs = await fetchJson<Pair[]>(`${BASE}/tokens/v1/solana/${SOL}`);
  countCall("dexscreener");
  const usdPairs = (pairs ?? []).filter((p) => p.baseToken.address === SOL && ["USDC", "USDT"].includes(p.quoteToken.symbol));
  usdPairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const px = Number(usdPairs[0]?.priceUsd);
  if (!px) throw new Error("could not price SOL");
  return px;
}

function toSnapshot(p: Pair): TokenSnapshot {
  const t = p.txns ?? {};
  return {
    mint: p.baseToken.address,
    symbol: sanitizeLabel(p.baseToken.symbol || "?", 14).toUpperCase(),
    name: sanitizeLabel(p.baseToken.name || "", 32),
    icon: p.info?.imageUrl,
    priceUsd: Number(p.priceUsd ?? 0),
    liquidityUsd: p.liquidity?.usd ?? 0,
    marketCap: p.marketCap ?? p.fdv ?? 0,
    volM5: p.volume?.m5 ?? 0,
    volH1: p.volume?.h1 ?? 0,
    buysM5: t.m5?.buys ?? 0,
    sellsM5: t.m5?.sells ?? 0,
    buysH1: t.h1?.buys ?? 0,
    sellsH1: t.h1?.sells ?? 0,
    chgM5: p.priceChange?.m5 ?? 0,
    chgH1: p.priceChange?.h1 ?? 0,
    chgH24: p.priceChange?.h24 ?? 0,
    pairCreatedAt: p.pairCreatedAt ?? 0,
    dexId: p.dexId,
    pairAddress: p.pairAddress,
  };
}
