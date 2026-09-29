/**
 * Token-bucket rate limiter keyed by an arbitrary string (usually a client IP).
 * Buckets that have been full for a while are dropped by {@link prune} so the
 * map cannot grow without bound.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updated: number }>();

  constructor(
    /** Maximum burst. */
    private readonly capacity: number,
    /** Tokens added per second. */
    private readonly refillPerSec: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Try to spend `cost` tokens for `key`. Returns false if the caller is over the limit. */
  take(key: string, cost = 1): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, updated: t };
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.updated) / 1000) * this.refillPerSec);
    b.updated = t;
    const ok = b.tokens >= cost;
    if (ok) b.tokens -= cost;
    this.buckets.set(key, b);
    return ok;
  }

  prune(): void {
    const t = this.now();
    const fullAfterMs = (this.capacity / this.refillPerSec) * 1000;
    for (const [key, b] of this.buckets) {
      if (t - b.updated > fullAfterMs) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}
