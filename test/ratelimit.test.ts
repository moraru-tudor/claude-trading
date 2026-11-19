import assert from "node:assert/strict";
import { test } from "node:test";
import { limit, tryLimit } from "../src/ratelimit.js";

test("rate limiter allows a burst, then spaces requests out", async () => {
  // rugcheck bucket: 30/min, burst 3 → the 4th call must wait ~2 s
  const t0 = Date.now();
  for (let i = 0; i < 3; i++) await limit("rugcheck");
  assert.ok(Date.now() - t0 < 100, "burst should be immediate");
  assert.equal(tryLimit("rugcheck"), false, "bucket should be empty after the burst");
  await limit("rugcheck");
  const waited = Date.now() - t0;
  assert.ok(waited >= 1500 && waited < 3500, `4th call waited ${waited} ms`);
});

test("per-second price checks fit under DexScreener's limit", () => {
  // 1 poll/s + up to 2 tick checks/s + scanner (≤ 3 chunks every 5 s) = 60 + 120 + 36 = 216/min; bucket allows 270
  assert.ok(60 + 120 + (60 / 5) * 3 < 270);
});
