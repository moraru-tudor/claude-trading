import assert from "node:assert/strict";
import { test } from "node:test";
import { rulesAnalyse } from "../src/agents/analyst.js";
import { exitSignal, sizeTrade } from "../src/agents/risk.js";
import { momentumScore } from "../src/agents/scanner.js";
import type { AnalystVerdict, Position, TokenSnapshot } from "../src/types.js";

const tok = (o: Partial<TokenSnapshot> = {}): TokenSnapshot => ({
  mint: "M", symbol: "TEST", name: "test", priceUsd: 1, liquidityUsd: 100_000, marketCap: 1_000_000,
  volM5: 10_000, volH1: 150_000, buysM5: 120, sellsM5: 60, buysH1: 900, sellsH1: 600,
  chgM5: 6, chgH1: 30, chgH24: 30, pairCreatedAt: Date.now() - 3_600_000, dexId: "raydium", pairAddress: "P", ...o,
});
const pos = (o: Partial<Position> = {}): Position => ({
  id: "1", mint: "M", symbol: "TEST", entryPrice: 1, qty: 5, costUsd: 5, openedAt: Date.now(), highPrice: 1,
  lastPrice: 1, takeProfitPct: 30, stopPct: 8, marketCap: 1, liquidityUsd: 1, ...o,
});
const verdict: AnalystVerdict = { action: "buy", bullScore: 4, bearScore: 0, confidence: 0.8, takeProfitPct: 30, bull: [], bear: [], rationale: "", by: "rules" };
const st = { equityUsd: 81, cashUsd: 81, positions: [] as Position[], sessionStartEquity: 81, paused: false, sessionOver: false };

test("stop loss fires at -8%", () => {
  assert.equal(exitSignal(pos(), 0.92), "stop loss");
  assert.equal(exitSignal(pos(), 0.90), "stop loss");
  assert.equal(exitSignal(pos(), 0.95), null);
});

test("take profit and trailing stop", () => {
  assert.equal(exitSignal(pos(), 1.31), "take profit");
  assert.equal(exitSignal(pos({ highPrice: 1.2 }), 1.07), "trailing stop");
  assert.equal(exitSignal(pos({ highPrice: 1.1 }), 1.0), null); // trail not armed below +15%
});

test("max hold time closes stale positions", () => {
  assert.equal(exitSignal(pos({ openedAt: Date.now() - 2 * 3_600_000 }), 1.01), "max hold time");
});

test("size stays within 3-8% and the USD cap", () => {
  const r = sizeTrade(verdict, tok(), st);
  assert.ok(r.allow);
  assert.ok(r.sizePct >= 3 && r.sizePct <= 8, `size ${r.sizePct}`);
  const big = sizeTrade(verdict, tok(), { ...st, equityUsd: 10_000, cashUsd: 10_000, sessionStartEquity: 10_000 });
  assert.ok(big.sizeUsd <= 25);
});

test("size is capped by pool liquidity", () => {
  const r = sizeTrade(verdict, tok({ liquidityUsd: 400 }), st);
  assert.ok(!r.allow || r.sizeUsd <= 2);
});

test("risk blocks: paused, max positions, loss limit, already holding", () => {
  assert.equal(sizeTrade(verdict, tok(), { ...st, paused: true }).allow, false);
  const four = [1, 2, 3, 4].map((i) => pos({ id: String(i), mint: "X" + i }));
  assert.equal(sizeTrade(verdict, tok(), { ...st, positions: four }).allow, false);
  assert.match(sizeTrade(verdict, tok(), { ...st, equityUsd: 50 }).reason, /loss limit/);
  assert.equal(sizeTrade(verdict, tok(), { ...st, positions: [pos()] }).allow, false);
});

test("scanner ignores dumps and vertical candles", () => {
  assert.ok(momentumScore(tok()) > 0);
  assert.equal(momentumScore(tok({ chgM5: -3 })), 0);
  assert.equal(momentumScore(tok({ chgM5: 90 })), 0);
  assert.equal(momentumScore(tok({ buysM5: 40, sellsM5: 80 })), 0);
});

test("rules analyst skips overextended thin coins", () => {
  assert.equal(rulesAnalyse(tok()).action, "buy");
  assert.equal(rulesAnalyse(tok({ chgH1: 300, liquidityUsd: 20_000, chgM5: 40, marketCap: 5_000_000 })).action, "skip");
});
