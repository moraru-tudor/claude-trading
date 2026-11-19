import { config } from "../config.js";
import { fetchJson } from "../util.js";
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
  countCall("jupiter");
  return fetchJson<Quote>(u.toString(), { headers: headers() });
}

/** Returns a base64 serialized VersionedTransaction for the user to sign. */
export async function buildSwap(q: Quote, userPublicKey: string): Promise<string> {
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
