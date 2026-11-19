import type { SafetyReport, TokenSnapshot } from "../types.js";
import { countCall, type Market } from "./market.js";

/**
 * Offline simulated market for MODE=demo. It exists so you can see the desk move without internet
 * or money. Its results mean NOTHING about real performance: rugs, fake pumps and chop are random.
 */
type Regime = "runner" | "rug" | "chop" | "honeypot";
interface SimToken {
  snap: TokenSnapshot;
  regime: Regime;
  born: number;
  last: number;
  turnAt: number; // runner reverses / rug pulls at this time
  hist: { t: number; p: number }[];
  dead: boolean;
}

const A = ["MOON", "PEPE", "DOGE", "CAT", "FROG", "WIF", "BONK", "GOAT", "CHAD", "NEKO", "BASED", "GIGA", "TURBO", "SHIB", "APE", "BRETT", "PNUT", "MOG"];
const B = ["", "AI", "INU", "X", "2", "KING", "SOL", "COIN", "MAX", "GPT", "DAO", "CEO"];
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const gauss = () => Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random());

export class SimMarket implements Market {
  readonly kind = "sim" as const;
  private tokens = new Map<string, SimToken>();
  private sol = 180;

  constructor() {
    for (let i = 0; i < 14; i++) this.spawn(Date.now() - rand(5, 120) * 60_000);
  }

  private spawn(born = Date.now()) {
    const sym = A[Math.floor(Math.random() * A.length)] + B[Math.floor(Math.random() * B.length)];
    const mint = "SIM" + Math.random().toString(36).slice(2, 12).toUpperCase() + "pump";
    const r = Math.random();
    const regime: Regime = r < 0.3 ? "runner" : r < 0.5 ? "rug" : r < 0.88 ? "chop" : "honeypot";
    const price = rand(0.00002, 0.004);
    const supply = 1_000_000_000;
    const t: SimToken = {
      regime, born, last: born, dead: false,
      turnAt: born + rand(4, 40) * 60_000,
      hist: [{ t: born, p: price }],
      snap: {
        mint, symbol: sym, name: sym.toLowerCase(), priceUsd: price,
        liquidityUsd: rand(18_000, 220_000), marketCap: price * supply,
        volM5: 0, volH1: 0, buysM5: 0, sellsM5: 0, buysH1: 0, sellsH1: 0,
        chgM5: 0, chgH1: 0, chgH24: 0, pairCreatedAt: born, dexId: "sim", pairAddress: mint + "pair",
      },
    };
    this.tokens.set(mint, t);
  }

  private step(t: SimToken, now = Date.now()) {
    let p = t.snap.priceUsd;
    while (t.last + 1000 <= now) {
      t.last += 1000;
      let drift = -0.00008, vol = 0.006;
      if (t.regime === "runner" || t.regime === "honeypot") drift = t.last < t.turnAt ? 0.0011 : -0.0012;
      if (t.regime === "rug" && t.last < t.turnAt) drift = 0.0004;
      p *= Math.exp(drift + vol * gauss());
      if (t.regime === "rug" && !t.dead && t.last >= t.turnAt) { p *= 0.08; t.dead = true; t.snap.liquidityUsd *= 0.05; }
      if (t.last % 15_000 < 1000) t.hist.push({ t: t.last, p });
    }
    t.hist = t.hist.filter((h) => h.t > now - 3_600_000);
    const at = (ms: number) => (t.hist.find((h) => h.t >= now - ms) ?? t.hist[0]).p;
    const chg = (ms: number) => (p / at(ms) - 1) * 100;
    const s = t.snap;
    s.priceUsd = p;
    s.marketCap = p * 1_000_000_000;
    s.chgM5 = chg(300_000); s.chgH1 = chg(3_600_000); s.chgH24 = s.chgH1;
    const activity = Math.max(5, 60 + s.chgM5 * 6) * (t.dead ? 0.1 : 1);
    s.buysM5 = Math.round(activity * (s.chgM5 > 0 ? 1.4 : 0.8));
    s.sellsM5 = Math.round(activity * (s.chgM5 > 0 ? 0.8 : 1.3));
    s.buysH1 = s.buysM5 * 9; s.sellsH1 = s.sellsM5 * 9;
    s.volM5 = activity * rand(80, 180); s.volH1 = s.volM5 * 10;
  }

  async discover() {
    countCall("dexscreener");
    if (Math.random() < 0.5) this.spawn();
    for (const [k, t] of this.tokens) if (Date.now() - t.born > 3 * 3_600_000) this.tokens.delete(k);
    return [...this.tokens.values()].map((t) => (this.step(t), { ...t.snap }));
  }

  async snapshots(mints: string[]) {
    countCall("dexscreener");
    const m = new Map<string, TokenSnapshot>();
    for (const id of mints) { const t = this.tokens.get(id); if (t) { this.step(t); m.set(id, { ...t.snap }); } }
    return m;
  }

  async safety(tok: TokenSnapshot): Promise<SafetyReport> {
    countCall("rugcheck"); countCall("jupiter"); countCall("jupiter");
    const t = this.tokens.get(tok.mint);
    const honeypot = t?.regime === "honeypot";
    const sneakyRug = t?.regime === "rug" && Math.random() < 0.5; // half of rugs are caught, half slip through
    return {
      ok: !honeypot && !sneakyRug,
      honeypot: honeypot ? "fail" : "pass",
      lp: sneakyRug ? "fail" : "pass",
      mintAuthority: false, freezeAuthority: false, riskScore: honeypot ? 80 : 10,
      roundTripLossPct: honeypot ? 100 : rand(1, 4),
      reasons: honeypot ? ["no sell route"] : sneakyRug ? ["LP only 12% locked"] : [],
    };
  }

  async solPriceUsd() { this.sol *= Math.exp(0.0005 * gauss()); return this.sol; }
}
