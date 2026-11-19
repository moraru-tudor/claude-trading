import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../config.js";

/**
 * Tick stream: one Solana websocket subscription per held coin's pool. Every swap that touches the
 * pool is a "tick", which makes the desk re-check that position immediately instead of waiting for
 * the next per-second poll. Works for any DEX, since it listens for transactions mentioning the pool.
 *
 * Use a paid RPC (Helius, Triton, QuickNode) in live mode: the public endpoint drops websockets often.
 * If the websocket fails, the desk keeps working on per-second polling alone.
 */
export class TickStream {
  private conn: Connection | null = null;
  private subs = new Map<string, { pair: string; id: number }>();
  ticks = 0;
  lastTickAt = 0;
  error = "";

  constructor(private onTick: (mint: string) => void) {}

  private connection() {
    if (!this.conn) {
      const wsEndpoint = config.wsUrl || config.rpcUrl.replace(/^http/, "ws");
      this.conn = new Connection(config.rpcUrl, { commitment: "processed", wsEndpoint });
    }
    return this.conn;
  }

  /** Make the subscriptions match exactly the given pools. */
  sync(pools: { mint: string; pair?: string }[]) {
    const want = new Map(pools.filter((p) => p.pair).map((p) => [p.mint, p.pair!]));
    for (const [mint, s] of this.subs) {
      if (want.get(mint) !== s.pair) {
        this.connection().removeOnLogsListener(s.id).catch(() => {});
        this.subs.delete(mint);
      }
    }
    for (const [mint, pair] of want) {
      if (this.subs.has(mint)) continue;
      try {
        const id = this.connection().onLogs(
          new PublicKey(pair),
          (l) => {
            if (l.err) return;
            this.ticks++;
            this.lastTickAt = Date.now();
            this.onTick(mint);
          },
          "processed",
        );
        this.subs.set(mint, { pair, id });
        this.error = "";
      } catch (e) {
        this.error = `tick stream: ${(e as Error).message}`;
      }
    }
  }

  get size() {
    return this.subs.size;
  }
}
