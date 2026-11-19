import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { analyse } from "./agents/analyst.js";
import type { Executor } from "./agents/executor.js";
import { exitSignal, sizeTrade } from "./agents/risk.js";
import { Safety } from "./agents/safety.js";
import { Scanner } from "./agents/scanner.js";
import { reviewStrategy } from "./agents/strategist.js";
import { config } from "./config.js";
import { notify } from "./notify.js";
import { applyStrategy, currentStrategy, describeChanges, type Strategy } from "./strategy.js";
import { calls, type Market } from "./sources/market.js";
import type { AgentName, AgentStatus, Decision, Position, TokenSnapshot, Trade } from "./types.js";
import { fmtCompact, fmtUsd, uid } from "./util.js";

interface Persisted {
  mode: string;
  startedAt: number;
  startUsd: number;
  cashUsd: number;
  positions: Position[];
  trades: Trade[];
  decisions: Decision[];
  equity: { t: number; v: number }[];
  wins: number;
  losses: number;
  coins: string[];
  paused: boolean;
  pauseReason: string;
  strategy?: Partial<Strategy>;
  sweptUsd?: number;
  lastReview?: { at: number; text: string };
}

/**
 * Core – the orchestrator (the "Grok core" box in the video, Claude-powered here).
 * Runs two loops: scan→safety→analyst→risk→executor for entries, and a monitor loop for exits.
 */
export class Desk extends EventEmitter {
  s: Persisted;
  agents: Record<AgentName, AgentStatus>;
  ticker = new Map<string, TokenSnapshot>();
  private scanner: Scanner;
  private safety: Safety;
  private file: string;
  private busy = false;
  private lastEquity = 0;
  private solPx = 0;
  error = "";

  constructor(private market: Market, private exec: Executor) {
    super();
    this.scanner = new Scanner(market);
    this.safety = new Safety(market);
    this.file = path.join(config.dataDir, `state-${config.mode}.json`);
    const src = market.kind === "sim" ? "sim" : undefined;
    const a = (source: string): AgentStatus => ({ text: "starting…", source: src ?? source, updatedAt: Date.now() });
    this.agents = {
      scanner: a("dexscreener"), safety: a("rugcheck+jupiter"), analyst: a(config.analyst === "claude" ? "claude" : "rules"),
      risk: a("risk engine"), executor: a(exec.label === "live" ? "jupiter→solana" : "paper"),
    };
    this.s = this.load() ?? this.fresh();
    if (this.s.strategy) applyStrategy(this.s.strategy); // keep Claude's earlier adjustments across restarts
    this.lastEquity = this.s.equity.at(-1)?.v ?? this.s.startUsd;
  }

  private fresh(): Persisted {
    return {
      mode: config.mode, startedAt: Date.now(), startUsd: config.startUsd, cashUsd: config.startUsd,
      positions: [], trades: [], decisions: [], equity: [{ t: Date.now(), v: config.startUsd }],
      wins: 0, losses: 0, coins: [], paused: false, pauseReason: "",
    };
  }

  private load(): Persisted | null {
    if (config.reset || !fs.existsSync(this.file)) return null;
    try {
      const p = JSON.parse(fs.readFileSync(this.file, "utf8")) as Persisted;
      return p.mode === config.mode ? p : null;
    } catch { return null; }
  }

  save() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(this.file + ".tmp", JSON.stringify(this.s));
    fs.renameSync(this.file + ".tmp", this.file);
  }

  get sessionEnd() { return this.s.startedAt + config.sessionHours * 3_600_000; }
  get sessionOver() { return Date.now() > this.sessionEnd; }
  positionsValue() { return this.s.positions.reduce((a, p) => a + p.qty * p.lastPrice, 0); }
  /** Everything the session is worth, including profits already swept to your main wallet. */
  equity() { return this.s.cashUsd + this.positionsValue() + (this.s.sweptUsd ?? 0); }

  private setAgent(n: AgentName, patch: Partial<AgentStatus>) {
    this.agents[n] = { ...this.agents[n], ...patch, updatedAt: Date.now() };
  }

  private decide(d: Omit<Decision, "ts">) {
    this.s.decisions.unshift({ ts: Date.now(), ...d });
    this.s.decisions.length = Math.min(this.s.decisions.length, 300);
  }

  setPaused(p: boolean, reason = "") {
    if (this.s.paused === p) return;
    this.s.paused = p; this.s.pauseReason = p ? reason || "paused from dashboard" : "";
    notify(p ? `⏸ Desk paused: ${this.s.pauseReason}` : "▶ Desk resumed", { tags: p ? "pause_button" : "arrow_forward" });
    this.save();
  }

  // ───────────────────────── Claude core (strategy) ─────────────────────────
  strategy() {
    return { strategy: currentStrategy(), lastReview: this.s.lastReview ?? null };
  }

  /** Used by the strategist and by Claude in a chat (set_strategy tool). Always clamped. */
  setStrategy(patch: Partial<Record<string, unknown>>, by: string) {
    const changes = applyStrategy(patch);
    if (changes.length) {
      this.s.strategy = currentStrategy();
      const text = `${by}: ${describeChanges(changes)}`;
      this.decide({ side: "CORE", symbol: "DESK", text });
      notify(`🧠 ${text}`, { tags: "brain" });
      this.save();
    }
    return changes;
  }

  private reviewing = false;
  async reviewOnce() {
    if (config.analyst !== "claude" || this.reviewing) return;
    this.reviewing = true;
    try {
      const plan = await reviewStrategy({
        equityUsd: this.equity(), startUsd: this.s.startUsd, minutesIn: (Date.now() - this.s.startedAt) / 60_000,
        paused: this.s.paused, trades: this.s.trades, decisions: this.s.decisions, openPositions: this.s.positions.length,
      });
      const changes = this.setStrategy(plan.changes as Record<string, unknown>, "Claude");
      if (plan.pause_new_entries) this.setPaused(true, `Claude: ${plan.reason}`);
      const text = changes.length || plan.pause_new_entries ? plan.reason : `no change · ${plan.reason}`;
      this.s.lastReview = { at: Date.now(), text: `${plan.assessment} ${text}`.trim() };
      if (!changes.length) this.decide({ side: "CORE", symbol: "DESK", text: `review: ${text}` });
      this.save();
    } catch (e) {
      console.error("[strategist]", (e as Error).message);
    } finally {
      this.reviewing = false;
    }
  }

  // ───────────────────────── profit sweep (live) ─────────────────────────
  async sweepOnce() {
    if (!config.profitSweepAddress || !this.exec.sweep) return;
    const excess = this.equity() - this.s.startUsd - (this.s.sweptUsd ?? 0);
    if (excess < config.sweepStepUsd) return;
    const amount = Math.min(excess, this.s.cashUsd - 1); // only idle cash, never position money
    if (amount < config.sweepStepUsd) return;
    try {
      const px = this.solPx || (await this.market.solPriceUsd());
      const sig = await this.exec.sweep(amount, px, config.profitSweepAddress);
      this.s.sweptUsd = (this.s.sweptUsd ?? 0) + amount;
      this.s.cashUsd -= amount;
      this.decide({ side: "CORE", symbol: "SOL", text: `swept ${fmtUsd(amount)} profit to your main wallet · ${sig.slice(0, 8)}…` });
      notify(`💸 Swept ${fmtUsd(amount)} profit to your main wallet`, { tags: "moneybag" });
      this.save();
    } catch (e) {
      console.error("[sweep]", (e as Error).message);
    }
  }

  // ───────────────────────── entry pipeline ─────────────────────────
  async scanOnce() {
    if (this.busy) return;
    this.busy = true;
    try {
      this.solPx = await this.market.solPriceUsd();
      if (this.exec.cashUsd) this.s.cashUsd = await this.exec.cashUsd(this.solPx);
      const held = new Set(this.s.positions.map((p) => p.mint));
      const { scanned, picks } = await this.scanner.scan(held);
      const top = picks[0];
      this.setAgent("scanner", { text: `${this.scanner.perHour().toLocaleString()}/h → ${top ? "$" + top.symbol : "none qualify yet"}`, symbol: top?.symbol, icon: top?.icon });
      for (const t of picks) this.ticker.set(t.mint, t);
      if (this.s.paused || this.sessionOver) {
        this.setAgent("risk", { text: this.s.paused ? `paused · ${this.s.pauseReason}` : "session over · managing exits only" });
        return;
      }
      for (const t of picks) await this.consider(t);
      this.error = "";
    } catch (e) {
      this.error = (e as Error).message;
      console.error("[scan]", this.error);
    } finally {
      this.busy = false;
    }
  }

  private async consider(t: TokenSnapshot) {
    const safety = await this.safety.check(t);
    this.setAgent("safety", {
      symbol: t.symbol, icon: t.icon, ok: safety.ok,
      text: `$${t.symbol} honeypot ${safety.honeypot === "pass" ? "✓" : "✗"} · LP ${safety.lp === "pass" ? "✓" : safety.lp === "fail" ? "✗" : "?"}${safety.ok ? "" : " · " + safety.reasons[0]}`,
    });
    if (!safety.ok) {
      this.decide({ side: "SKIP", symbol: t.symbol, icon: t.icon, text: `safety: ${safety.reasons.slice(0, 2).join(", ")}` });
      return;
    }

    const v = await analyse(t, safety, { openPositions: this.s.positions.length, equityUsd: this.equity() });
    this.setAgent("analyst", { symbol: t.symbol, icon: t.icon, ok: v.action === "buy", text: `$${t.symbol} bull ${v.bullScore}/bear ${v.bearScore} → ${v.action}` });
    if (v.action !== "buy") {
      this.decide({ side: "SKIP", symbol: t.symbol, icon: t.icon, text: `bull ${v.bullScore}/bear ${v.bearScore} · ${v.bear[0] ?? v.rationale}` });
      return;
    }

    const r = sizeTrade(v, t, {
      equityUsd: this.equity(), cashUsd: this.s.cashUsd, positions: this.s.positions,
      sessionStartEquity: this.s.startUsd, paused: this.s.paused, sessionOver: this.sessionOver,
    });
    this.setAgent("risk", { text: r.allow ? `size ${r.sizePct.toFixed(1)}% · stop -${r.stopPct}%` : r.reason, symbol: t.symbol, icon: t.icon, ok: r.allow });
    if (!r.allow) {
      if (/loss limit/.test(r.reason)) { this.setPaused(true, r.reason); notify(`🛑 Loss limit hit: ${r.reason}`, { priority: 5, tags: "rotating_light" }); }
      this.decide({ side: "SKIP", symbol: t.symbol, icon: t.icon, text: `risk: ${r.reason}` });
      return;
    }

    try {
      const fill = await this.exec.buy(t, r.sizeUsd, this.solPx);
      const pos: Position = {
        id: uid(), mint: t.mint, symbol: t.symbol, icon: t.icon, entryPrice: fill.price, qty: fill.qty,
        rawAmount: fill.rawAmount, decimals: fill.decimals, costUsd: fill.usd, openedAt: Date.now(),
        highPrice: fill.price, lastPrice: t.priceUsd, takeProfitPct: v.takeProfitPct, stopPct: r.stopPct,
        marketCap: t.marketCap, liquidityUsd: t.liquidityUsd, pairAddress: t.pairAddress, lastPriceAt: Date.now(),
      };
      this.s.positions.push(pos);
      this.s.cashUsd -= fill.usd;
      if (!this.s.coins.includes(t.mint)) this.s.coins.push(t.mint);
      const reason = v.bull[0] ?? v.rationale;
      this.s.trades.push({ id: uid(), ts: Date.now(), side: "BUY", mint: t.mint, symbol: t.symbol, icon: t.icon, usd: fill.usd, reason, txSig: fill.txSig });
      this.decide({ side: "BUY", symbol: t.symbol, icon: t.icon, text: reason, usd: fill.usd });
      this.setAgent("executor", { text: `BUY $${t.symbol} ${fmtUsd(fill.usd)}`, symbol: t.symbol, icon: t.icon, ok: true });
      notify(`BUY $${t.symbol} ${fmtUsd(fill.usd)} · mcap ${fmtCompact(t.marketCap)}`, { title: "Bought", tags: "green_circle", priority: 2 });
      this.emit("toast", { kind: "buy", symbol: t.symbol, icon: t.icon, line: `mcap ${fmtCompact(t.marketCap)} · ${fmtUsd(fill.usd)} · ${this.signedBy()}` });
      this.save();
    } catch (e) {
      this.setAgent("executor", { text: `BUY $${t.symbol} failed`, ok: false });
      this.decide({ side: "SKIP", symbol: t.symbol, icon: t.icon, text: `execution failed: ${(e as Error).message.slice(0, 80)}` });
    }
  }

  private signedBy() {
    return this.exec.label === "live" ? "signed by bot wallet (Phantom)" : this.market.kind === "sim" ? "demo fill" : "paper fill";
  }

  // ───────────────────────── exit monitor ─────────────────────────
  // Runs every MONITOR_INTERVAL_MS (default 1 s) and, with the tick stream on, right after every swap
  // in a held coin's pool. Only one check runs at a time; a check requested meanwhile runs right after.
  private checking = false;
  private recheck = false;
  private lastTickCheck = 0;
  private closing = new Set<string>();
  private lastSnapAt = 0;
  checks = 0;
  private checkLog: number[] = [];
  lastCheckMs = 0;
  lastCheckAt = 0;

  async monitorOnce() {
    this.market.syncTicks(this.s.positions.map((p) => ({ mint: p.mint, pair: p.pairAddress })), (m) => this.onTick(m));
    await this.checkPositions();
    this.sampleEquity();
  }

  private onTick(_mint: string) {
    const now = Date.now();
    if (now - this.lastTickCheck < config.tickDebounceMs) return;
    this.lastTickCheck = now;
    void this.checkPositions();
  }

  private async checkPositions(): Promise<void> {
    if (!this.s.positions.length) return;
    if (this.checking) { this.recheck = true; return; }
    this.checking = true;
    const t0 = Date.now();
    try {
      const px = await this.market.priceTick(this.s.positions.map((p) => p.mint));
      const now = Date.now();
      this.checks++; this.checkLog.push(now);
      this.lastCheckMs = now - t0; this.lastCheckAt = now;
      for (const p of [...this.s.positions]) {
        const q = px.get(p.mint);
        if (q && q.price > 0) {
          p.lastPrice = q.price; p.lastPriceAt = now; p.highPrice = Math.max(p.highPrice, q.price);
          if (q.snap) { p.marketCap = q.snap.marketCap; p.liquidityUsd = q.snap.liquidityUsd; this.ticker.set(p.mint, q.snap); }
        }
        const why = exitSignal(p, p.lastPrice);
        if (why && !this.closing.has(p.id)) void this.close(p, q?.snap, why);
      }
      // with a price-only source, refresh liquidity / mcap every 15 s for slippage and display
      if (config.priceSource === "jupiter" && now - this.lastSnapAt > 15_000) {
        this.lastSnapAt = now;
        const snaps = await this.market.snapshots(this.s.positions.map((p) => p.mint)).catch(() => new Map<string, TokenSnapshot>());
        for (const p of this.s.positions) { const t = snaps.get(p.mint); if (t) { p.marketCap = t.marketCap; p.liquidityUsd = t.liquidityUsd; this.ticker.set(p.mint, t); } }
      }
    } catch (e) {
      console.error("[monitor]", (e as Error).message);
    } finally {
      this.checking = false;
      if (this.recheck) { this.recheck = false; setTimeout(() => void this.checkPositions(), 0); }
    }
  }

  checksPerMin() {
    const cut = Date.now() - 60_000;
    while (this.checkLog.length && this.checkLog[0] < cut) this.checkLog.shift();
    return this.checkLog.length;
  }

  async close(p: Position, t: TokenSnapshot | undefined, why: string) {
    if (this.closing.has(p.id)) return;
    this.closing.add(p.id);
    try {
      const fill = await this.exec.sell(p, t, this.solPx || (await this.market.solPriceUsd()));
      const pnl = fill.usd - p.costUsd;
      this.s.positions = this.s.positions.filter((x) => x.id !== p.id);
      this.s.cashUsd += fill.usd;
      if (pnl >= 0) this.s.wins++; else this.s.losses++;
      this.s.trades.push({ id: uid(), ts: Date.now(), side: "SELL", mint: p.mint, symbol: p.symbol, icon: p.icon, usd: fill.usd, pnlUsd: pnl, reason: why, txSig: fill.txSig });
      this.decide({ side: "SELL", symbol: p.symbol, icon: p.icon, text: `${why} · ${this.signedBy()}`, pnlUsd: pnl });
      this.setAgent("executor", { text: `SELL $${p.symbol} ${pnl >= 0 ? "+" : ""}${fmtUsd(pnl)}`, symbol: p.symbol, icon: p.icon, ok: pnl >= 0 });
      notify(`SELL $${p.symbol} ${pnl >= 0 ? "+" : ""}${fmtUsd(pnl)} · ${why} · equity ${fmtUsd(this.equity())}`, { title: pnl >= 0 ? "Sold in profit" : "Sold at a loss", tags: pnl >= 0 ? "white_check_mark" : "small_red_triangle_down" });
      this.emit("toast", { kind: "sell", symbol: p.symbol, icon: p.icon, pnl, line: `mcap ${fmtCompact(p.marketCap)} · ${why} · ${this.signedBy()}` });
      this.save();
    } catch (e) {
      this.setAgent("executor", { text: `SELL $${p.symbol} failed, retrying`, ok: false });
      console.error("[close]", (e as Error).message);
    } finally {
      this.closing.delete(p.id);
    }
  }

  async closeAll(reason = "manual close") {
    const snaps = await this.market.snapshots(this.s.positions.map((p) => p.mint)).catch(() => new Map());
    for (const p of [...this.s.positions]) await this.close(p, snaps.get(p.mint), reason);
  }

  private sampleEquity() {
    const v = this.equity();
    const last = this.s.equity.at(-1);
    if (!last || Date.now() - last.t > 5_000 || Math.abs(v - this.lastEquity) > 0.01 * v) {
      this.s.equity.push({ t: Date.now(), v });
      if (this.s.equity.length > 4000) this.s.equity.splice(0, this.s.equity.length - 4000);
      this.lastEquity = v;
    }
  }

  // ───────────────────────── views ─────────────────────────
  snapshot() {
    const eq = this.equity();
    const hourAgo = this.s.equity.find((e) => e.t >= Date.now() - 3_600_000)?.v ?? this.s.startUsd;
    const step = Math.max(1, Math.ceil(this.s.equity.length / 300));
    return {
      mode: config.mode, market: this.market.kind, wallet: this.exec.address ?? null,
      analyst: config.analyst, analystModel: config.analyst === "claude" ? config.analystModel : null,
      now: Date.now(), startedAt: this.s.startedAt, sessionEnd: this.sessionEnd, sessionOver: this.sessionOver,
      startUsd: this.s.startUsd, equity: eq, cash: this.s.cashUsd, changeHour: eq - hourAgo,
      trades: this.s.trades.length, wins: this.s.wins, losses: this.s.losses,
      paused: this.s.paused, pauseReason: this.s.pauseReason, error: this.error,
      series: this.s.equity.filter((_, i) => i % step === 0 || i === this.s.equity.length - 1),
      sources: [
        { name: "Claude", note: config.analyst === "claude" ? config.analystModel : "rules (no API key)", calls: calls.claude, color: "#7c6cf2" },
        { name: "DexScreener", note: "scanner feed", calls: calls.dexscreener, color: "#14b8a6" },
        { name: "RugCheck+Jupiter", note: "safety + swaps", calls: calls.rugcheck + calls.jupiter, color: "#f59e0b" },
      ],
      agents: this.agents,
      positions: this.s.positions,
      decisions: this.s.decisions.slice(0, 40),
      ticker: [...this.ticker.values()].slice(-16).map((t) => ({ symbol: t.symbol, icon: t.icon, chg: t.chgH1 })),
      speed: (() => {
        const tk = this.market.tickStats();
        return {
          checkEveryMs: config.monitorIntervalMs, checksPerMin: this.checksPerMin(), lastCheckMs: this.lastCheckMs, lastCheckAt: this.lastCheckAt,
          scanEverySec: config.scanIntervalSec, priceSource: config.priceSource,
          tickStream: config.tickStream, ticks: tk.ticks, lastTickAt: tk.lastTickAt, streams: tk.streams, tickError: tk.error,
        };
      })(),
      strategy: currentStrategy(),
      lastReview: this.s.lastReview ?? null,
      sweptUsd: this.s.sweptUsd ?? 0,
      config: { stopLossPct: config.stopLossPct, maxPositionPct: config.maxPositionPct, sessionHours: config.sessionHours },
    };
  }

  recap() {
    const sells = this.s.trades.filter((t) => t.side === "SELL");
    const by = new Map<string, { symbol: string; icon?: string; pnl: number }>();
    for (const t of sells) {
      const e = by.get(t.mint) ?? { symbol: t.symbol, icon: t.icon, pnl: 0 };
      e.pnl += t.pnlUsd ?? 0; by.set(t.mint, e);
    }
    const ranked = [...by.values()].sort((a, b) => b.pnl - a.pnl);
    const eq = this.equity();
    return {
      startedAt: this.s.startedAt, end: Math.min(Date.now(), this.sessionEnd), mode: config.mode,
      putIn: this.s.startUsd, nowWorth: eq, multiple: eq / this.s.startUsd,
      trades: this.s.trades.length, coins: this.s.coins.length, sources: 3, agents: 5,
      best: ranked[0] ?? null, worst: ranked.at(-1) ?? null,
      winRate: sells.length ? this.s.wins / sells.length : 0, stopLossPct: config.stopLossPct,
    };
  }
}
