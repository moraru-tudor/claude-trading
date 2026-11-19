import { config } from "../config.js";
import { fetchJson } from "../util.js";
import { limit } from "../ratelimit.js";
import { countCall } from "./market.js";

export const SOL_MINT = "So11111111111111111111111111111111111111112";

export interface Quote {
  inputMint: string; outputMint: string;
  inAmount: string; outAmount: string; otherAmountThreshold: string;
  priceImpactPct: string;
  routePlan: unknown[];
  [k: string]: unknown;
}

const headers = (): Record<string, string> => (config.jupiterApiKey ? { "x-api-key": config.jupiterApiKey } : {});

export async function quote(inputMint: string, outputMint: string, amount: bigint | string, slippageBps = config.slippageBps): Promise<Quote> {
  const u = new URL(`${config.jupiterBase}/quote`);
  u.searchParams.set("inputMint", inputMint);
  u.searchParams.set("outputMint", outputMint);
  u.searchParams.set("amount", amount.toString());
  u.searchParams.set("slippageBps", String(slippageBps));
  u.searchParams.set("restrictIntermediateTokens", "true");
  await limit("jupiter");
  countCall("jupiter");
  return fetchJson<Quote>(u.toString(), { headers: headers() });
}

/** Returns a base64 serialized VersionedTransaction for the user to sign. */
export async function buildSwap(q: Quote, userPublicKey: string): Promise<string> {
  await limit("jupiter");
  countCall("jupiter");
  const res = await fetchJson<{ swapTransaction: string }>(`${config.jupiterBase}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers() },
    body: JSON.stringify({
      quoteResponse: q,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { maxLamports: config.maxPriorityFeeLamports, priorityLevel: "high" },
      },
    }),
  });
  return res.swapTransaction;
}

/**
 * Honeypot test: quote a small buy, then quote selling the received tokens back.
 * No sell route or a huge round-trip loss = can't get out = skip.
 */
export async function roundTrip(mint: string, lamports = 50_000_000n): Promise<{ sellable: boolean; lossPct: number | null }> {
  const buy = await quote(SOL_MINT, mint, lamports);
  try {
    const sell = await quote(mint, SOL_MINT, buy.outAmount);
    const back = Number(sell.outAmount);
    return { sellable: back > 0, lossPct: (1 - back / Number(lamports)) * 100 };
  } catch {
    return { sellable: false, lossPct: null };
  }
}

/** Jupiter Price API v3: aggregated USD price, up to 50 mints per call. */
export async function prices(mints: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const base = config.jupiterBase.replace(/\/swap\/v1\/?$/, "");
  for (let i = 0; i < mints.length; i += 50) {
    await limit("jupiter");
    countCall("jupiter");
    const res = await fetchJson<Record<string, { usdPrice?: number } | null>>(
      `${base}/price/v3?ids=${mints.slice(i, i + 50).join(",")}`, { headers: headers() }, 5_000);
    for (const [mint, v] of Object.entries(res ?? {})) if (v && Number(v.usdPrice) > 0) out.set(mint, Number(v.usdPrice));
  }
  return out;
}
