/**
 * Transfer speed over a sliding window, plus ETA. Robust to bursty progress
 * (acks arrive in 1 MiB steps) because it looks at a few seconds of history.
 */
export class SpeedMeter {
  private samples: Array<{ t: number; bytes: number }> = [];

  constructor(
    private readonly windowMs = 3000,
    private readonly now: () => number = () => performance.now(),
  ) {}

  reset(): void {
    this.samples = [];
  }

  /** Record the cumulative byte count. */
  push(bytes: number): void {
    const t = this.now();
    this.samples.push({ t, bytes });
    const cutoff = t - this.windowMs;
    while (this.samples.length > 2 && this.samples[1]!.t < cutoff) this.samples.shift();
  }

  /** Bytes per second, or 0 if there isn't enough history yet. */
  get bytesPerSecond(): number {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last || last.t - first.t < 250) return 0;
    return Math.max(0, ((last.bytes - first.bytes) / (last.t - first.t)) * 1000);
  }

  /** Seconds until `total` at the current speed, or `Infinity` if unknown. */
  eta(total: number): number {
    const last = this.samples[this.samples.length - 1];
    const bps = this.bytesPerSecond;
    if (!last || bps <= 0) return Infinity;
    return Math.max(0, (total - last.bytes) / bps);
  }
}
