import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../src/config.js";
import { applyStrategy, bounds } from "../src/strategy.js";

test("Claude can never raise risk above the .env limits", () => {
  const before = { max: config.maxPositionPct, stop: config.stopLossPct, open: config.maxOpenPositions, liq: config.minLiquidityUsd };
  const changes = applyStrategy({ maxPositionPct: 90, stopLossPct: 50, maxOpenPositions: 40, minLiquidityUsd: 10 });
  assert.equal(config.maxPositionPct, before.max);
  assert.equal(config.stopLossPct, before.stop);
  assert.equal(config.maxOpenPositions, before.open);
  assert.equal(config.minLiquidityUsd, before.liq);
  assert.equal(changes.length, 0);
});

test("Claude can make the desk more careful", () => {
  const changes = applyStrategy({ maxPositionPct: 4, stopLossPct: 5, maxOpenPositions: 2.4, minLiquidityUsd: 40_000 });
  assert.equal(config.maxPositionPct, 4);
  assert.equal(config.stopLossPct, 5);
  assert.equal(config.maxOpenPositions, 2);
  assert.equal(config.minLiquidityUsd, 40_000);
  assert.ok(config.minPositionPct <= config.maxPositionPct);
  assert.equal(changes.length, 4);
});

test("exit tuning is clamped to sane ranges and junk is ignored", () => {
  applyStrategy({ takeProfitPct: 9999, trailPct: -3, maxHoldMin: "abc", bogus: 5 } as Record<string, unknown>);
  assert.equal(config.takeProfitPct, bounds.takeProfitPct[1]);
  assert.equal(config.trailPct, bounds.trailPct[0]);
});
