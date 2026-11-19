export interface TokenSnapshot {
  mint: string;
  symbol: string;
  name: string;
  icon?: string;
  priceUsd: number;
  liquidityUsd: number;
  marketCap: number;
  volM5: number;
  volH1: number;
  buysM5: number;
  sellsM5: number;
  buysH1: number;
  sellsH1: number;
  chgM5: number;
  chgH1: number;
  chgH24: number;
  pairCreatedAt: number; // ms epoch
  dexId: string;
  pairAddress: string;
}

export interface SafetyReport {
  ok: boolean;
  honeypot: "pass" | "fail" | "unknown";
  lp: "pass" | "fail" | "unknown";
  mintAuthority: boolean | null;
  freezeAuthority: boolean | null;
  riskScore: number | null; // rugcheck normalised (lower is better) if available
  roundTripLossPct: number | null;
  reasons: string[];
}

export interface AnalystVerdict {
  action: "buy" | "skip";
  bullScore: number; // 0-5
  bearScore: number; // 0-5
  confidence: number; // 0-1
  takeProfitPct: number;
  bull: string[];
  bear: string[];
  rationale: string;
  by: "claude" | "rules";
}

export interface Position {
  id: string;
  mint: string;
  symbol: string;
  icon?: string;
  entryPrice: number;
  qty: number; // UI units (paper) – informational in live
  rawAmount?: string; // live: token base units held
  decimals?: number;
  costUsd: number;
  openedAt: number;
  highPrice: number;
  lastPrice: number;
  takeProfitPct: number;
  stopPct: number;
  marketCap: number;
  liquidityUsd: number;
  pairAddress?: string;
  lastPriceAt?: number;
}

export interface Trade {
  id: string;
  ts: number;
  side: "BUY" | "SELL";
  mint: string;
  symbol: string;
  icon?: string;
  usd: number;
  pnlUsd?: number;
  reason: string;
  txSig?: string;
}

export interface Decision {
  ts: number;
  side: "BUY" | "SELL" | "SKIP" | "CORE";
  symbol: string;
  icon?: string;
  text: string;
  usd?: number;
  pnlUsd?: number;
}

export type AgentName = "scanner" | "safety" | "analyst" | "risk" | "executor";
export interface AgentStatus {
  text: string;
  symbol?: string;
  icon?: string;
  ok?: boolean;
  source: string;
  updatedAt: number;
}

export interface FillResult {
  usd: number; // usd spent (buy) or received (sell)
  qty: number;
  price: number;
  rawAmount?: string;
  decimals?: number;
  txSig?: string;
}
