import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../config.js";
import { buildSwap, quote, SOL_MINT } from "../sources/jupiter.js";
import { countCall } from "../sources/market.js";
import type { FillResult, Position, TokenSnapshot } from "../types.js";

/**
 * EXECUTOR – turns decisions into fills.
 *  PaperExecutor: realistic fills against live prices (fees + AMM price impact), no chain calls.
 *  LiveExecutor: Jupiter quote → swap tx → signed by YOUR dedicated wallet → sent to Solana.
 *  The wallet is a normal Solana keypair: import the same key into Phantom to watch every trade.
 */
export interface Executor {
  readonly label: string;
  buy(t: TokenSnapshot, usd: number, solPx: number): Promise<FillResult>;
  sell(p: Position, t: TokenSnapshot | undefined, solPx: number): Promise<FillResult>;
  /** live: real SOL balance in USD; paper: undefined (core tracks cash itself) */
  cashUsd?(solPx: number): Promise<number>;
  address?: string;
}

/** price impact of `usd` against a constant-product pool whose total liquidity is `liq` */
const impact = (usd: number, liq: number) => Math.min(0.5, usd / Math.max(liq / 2, 1));

export class PaperExecutor implements Executor {
  readonly label = "paper";
  async buy(t: TokenSnapshot, usd: number): Promise<FillResult> {
    const px = t.priceUsd * (1 + impact(usd, t.liquidityUsd) + config.paperFeePct / 100);
    return { usd, qty: usd / px, price: px };
  }
  async sell(p: Position, t: TokenSnapshot | undefined): Promise<FillResult> {
    const mkt = t?.priceUsd ?? p.lastPrice;
    const gross = p.qty * mkt;
    const usd = gross * (1 - impact(gross, t?.liquidityUsd ?? p.liquidityUsd) - config.paperFeePct / 100);
    return { usd: Math.max(0, usd), qty: p.qty, price: mkt };
  }
}

export function loadKeypair(secret: string): Keypair {
  const s = secret.trim();
  const bytes = s.startsWith("[") ? Uint8Array.from(JSON.parse(s)) : bs58.decode(s);
  return Keypair.fromSecretKey(bytes);
}

export class LiveExecutor implements Executor {
  readonly label = "live";
  private kp: Keypair;
  private conn: Connection;
  readonly address: string;

  constructor() {
    this.kp = loadKeypair(config.walletSecret);
    this.conn = new Connection(config.rpcUrl, "confirmed");
    this.address = this.kp.publicKey.toBase58();
  }

  async cashUsd(solPx: number) {
    countCall("solana");
    const lamports = await this.conn.getBalance(this.kp.publicKey);
    return Math.max(0, lamports / 1e9 - config.solFeeReserve) * solPx;
  }

  private async tokenBalance(mint: string): Promise<{ raw: bigint; decimals: number }> {
    countCall("solana");
    const res = await this.conn.getParsedTokenAccountsByOwner(this.kp.publicKey, { mint: new PublicKey(mint) });
    let raw = 0n, decimals = 0;
    for (const a of res.value) {
      const info = (a.account.data as { parsed: { info: { tokenAmount: { amount: string; decimals: number } } } }).parsed.info.tokenAmount;
      raw += BigInt(info.amount); decimals = info.decimals;
    }
    return { raw, decimals };
  }

  private async signAndSend(b64: string): Promise<string> {
    const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
    tx.sign([this.kp]);
    countCall("solana");
    const sig = await this.conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    const bh = await this.conn.getLatestBlockhash("confirmed");
    const conf = await this.conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
    if (conf.value.err) throw new Error(`tx failed ${sig}: ${JSON.stringify(conf.value.err)}`);
    return sig;
  }

  async buy(t: TokenSnapshot, usd: number, solPx: number): Promise<FillResult> {
    const lamports = BigInt(Math.floor((usd / solPx) * 1e9));
    const before = await this.tokenBalance(t.mint);
    const q = await quote(SOL_MINT, t.mint, lamports);
    if (Number(q.priceImpactPct) > 0.05) throw new Error(`price impact ${(Number(q.priceImpactPct) * 100).toFixed(1)}% too high`);
    const sig = await this.signAndSend(await buildSwap(q, this.address));
    const after = await this.tokenBalance(t.mint);
    const got = after.raw - before.raw;
    const qty = Number(got) / 10 ** after.decimals;
    return { usd, qty, price: qty > 0 ? usd / qty : t.priceUsd, rawAmount: got.toString(), decimals: after.decimals, txSig: sig };
  }

  async sell(p: Position, t: TokenSnapshot | undefined, solPx: number): Promise<FillResult> {
    const bal = await this.tokenBalance(p.mint);
    if (bal.raw === 0n) return { usd: 0, qty: 0, price: t?.priceUsd ?? p.lastPrice };
    const q = await quote(p.mint, SOL_MINT, bal.raw);
    const sig = await this.signAndSend(await buildSwap(q, this.address));
    const usd = (Number(q.outAmount) / 1e9) * solPx;
    const qty = Number(bal.raw) / 10 ** bal.decimals;
    return { usd, qty, price: qty ? usd / qty : 0, txSig: sig };
  }
}
