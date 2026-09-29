import { describe, expect, it } from 'vitest';
import { SpeedMeter } from './speed';

describe('SpeedMeter', () => {
  it('computes bytes/second over its window and an ETA', () => {
    let now = 0;
    const m = new SpeedMeter(3000, () => now);
    for (let t = 0; t <= 2000; t += 100) {
      now = t;
      m.push(t * 1000); // 1 MB/s
    }
    expect(m.bytesPerSecond).toBeCloseTo(1_000_000, -3);
    expect(m.eta(4_000_000)).toBeCloseTo(2, 1);
  });

  it('reports 0 / Infinity without enough history', () => {
    const m = new SpeedMeter(3000, () => 0);
    m.push(100);
    expect(m.bytesPerSecond).toBe(0);
    expect(m.eta(1000)).toBe(Infinity);
  });
});
