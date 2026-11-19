import { fetchJson } from "../util.js";
import { limit } from "../ratelimit.js";
import { countCall } from "./market.js";

// Public endpoint, no key needed for the summary report.
interface Risk { name: string; level: string; description?: string; score?: number }
interface Summary { score?: number; score_normalised?: number; risks?: Risk[]; lpLockedPct?: number }

export interface RugSummary {
  riskScore: number | null;
  dangers: string[];
  warnings: string[];
  mintAuthority: boolean | null;
  freezeAuthority: boolean | null;
  lpLockedPct: number | null;
}

export async function rugcheckSummary(mint: string): Promise<RugSummary> {
  await limit("rugcheck");
  const s = await fetchJson<Summary>(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`);
  countCall("rugcheck");
  const risks = s.risks ?? [];
  const has = (re: RegExp) => risks.some((r) => re.test(r.name));
  return {
    riskScore: s.score_normalised ?? null,
    dangers: risks.filter((r) => r.level === "danger").map((r) => r.name),
    warnings: risks.filter((r) => r.level === "warn").map((r) => r.name),
    mintAuthority: has(/mint authority/i),
    freezeAuthority: has(/freeze authority/i),
    lpLockedPct: s.lpLockedPct ?? null,
  };
}
