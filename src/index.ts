import { LiveExecutor, PaperExecutor, type Executor } from "./agents/executor.js";
import { config, validateConfig } from "./config.js";
import { Desk } from "./core.js";
import type { Market } from "./sources/market.js";
import { RealMarket } from "./sources/real.js";
import { SimMarket } from "./sources/sim.js";
import { startServer } from "./server.js";

validateConfig(config);

const market: Market = config.mode === "demo" ? new SimMarket() : new RealMarket();
const exec: Executor = config.mode === "live" ? new LiveExecutor() : new PaperExecutor();
const desk = new Desk(market, exec);

const modeNote =
  config.mode === "demo" ? "  (simulated market — numbers are not real)"
  : config.mode === "paper" ? "  (real prices, fake money)"
  : "  ⚠ REAL MONEY";

console.log(`
  Claude Trading Desk
  mode      ${config.mode.toUpperCase()}${modeNote}
  analyst   ${config.analyst === "claude" ? `Claude (${config.analystModel}, effort ${config.analystEffort})` : "rules (set ANTHROPIC_API_KEY to use Claude)"}
  speed     prices every ${config.monitorIntervalMs} ms (${config.priceSource})${config.tickStream ? " + on every swap tick" : ""} · scan every ${config.scanIntervalSec} s
  bankroll  $${config.startUsd}   stop -${config.stopLossPct}%   size ${config.minPositionPct}-${config.maxPositionPct}%   max open ${config.maxOpenPositions}
  wallet    ${exec.address ?? `— (no wallet in ${config.mode} mode)`}`);

startServer(desk);

// Fixed-rate loops: the next run is timed from when this one STARTED, so a 1 s monitor really
// checks once per second. Runs never overlap; a slow call only delays itself.
const loop = (fn: () => Promise<unknown>, ms: number) => {
  const run = async () => {
    const t0 = Date.now();
    await fn().catch((e) => console.error(e));
    setTimeout(run, Math.max(0, ms - (Date.now() - t0)));
  };
  void run();
};
loop(() => desk.scanOnce(), config.scanIntervalSec * 1000);
loop(() => desk.monitorOnce(), config.monitorIntervalMs);
setInterval(() => desk.save(), 10_000).unref();

const shutdown = () => {
  desk.save();
  console.log("\nstate saved. open positions stay open; restart to keep managing them.");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
