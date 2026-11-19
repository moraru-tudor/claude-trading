/**
 * Token-bucket rate limiter, one bucket per upstream endpoint, so per-second price checks never
 * trip the provider's limits (a 429 ban would blind the stop-losses, which is worse than being slow).
 *
 * Published limits (Nov 2026):
 *   DexScreener  /tokens/v1, /latest/dex/pairs : 300 req/min
 *   DexScreener  /token-profiles, /token-boosts: 60 req/min
 *   Jupiter lite (no key)                       : ~60 req/min   (JUPITER_RPM to raise with a paid key)
 *   RugCheck                                    : be polite, ~30 req/min
 * We stay ~10% under each.
 */
const JUPITER_RPM = Number(process.env.JUPITER_RPM) > 0 ? Number(process.env.JUPITER_RPM) : 54;

class Bucket {
  private tokens: number;
  private last = Date.now();
  private queue: (() => void)[] = [];
  private timer: NodeJS.Timeout | null = null;
  constructor(private perMin: number, private burst = Math.max(1, Math.ceil(perMin / 12))) {
    this.tokens = this.burst;
  }
  private refill() {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 60_000) * this.perMin);
    this.last = now;
  }
  private drain = () => {
    this.timer = null;
    this.refill();
    while (this.queue.length && this.tokens >= 1) {
      this.tokens -= 1;
      this.queue.shift()!();
    }
    if (this.queue.length) this.timer = setTimeout(this.drain, Math.ceil(((1 - this.tokens) * 60_000) / this.perMin));
  };
  take(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      if (!this.timer) this.drain();
    });
  }
  /** non-blocking: true if a request may go out right now */
  tryTake(): boolean {
    this.refill();
    if (this.queue.length || this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

const buckets: Record<string, Bucket> = {
  "dex-tokens": new Bucket(270),
  "dex-latest": new Bucket(54),
  jupiter: new Bucket(JUPITER_RPM),
  rugcheck: new Bucket(30),
};

export const limit = (name: keyof typeof buckets) => buckets[name].take();
export const tryLimit = (name: keyof typeof buckets) => buckets[name].tryTake();
