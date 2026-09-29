import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ChannelClosedError, Notifier, streamBlob, type ChannelLike, type SourceLike } from './flow';

const KiB = 1024;

/** A fake RTCDataChannel: `send` grows `bufferedAmount`; a pump "transmits" it away over time. */
class FakeChannel implements ChannelLike {
  readyState = 'open';
  bufferedAmount = 0;
  maxBuffered = 0;
  sent: Uint8Array[] = [];
  delivered = 0;

  constructor(private readonly changed: Notifier) {}

  send(data: Uint8Array<ArrayBuffer>): void {
    if (this.readyState !== 'open') throw new Error('send on closed channel');
    this.sent.push(data.slice());
    this.bufferedAmount += data.byteLength;
    this.maxBuffered = Math.max(this.maxBuffered, this.bufferedAmount);
  }

  /** Move up to `n` buffered bytes onto the "wire". */
  transmit(n: number): void {
    const moved = Math.min(n, this.bufferedAmount);
    this.bufferedAmount -= moved;
    this.delivered += moved;
    this.changed.notify(); // like `bufferedamountlow`
  }

  bytes(): Buffer {
    return Buffer.concat(this.sent);
  }
}

/** Wraps a Blob and records how many reads are in flight at once. */
class CountingSource implements SourceLike {
  inFlight = 0;
  maxInFlight = 0;
  reads = 0;
  constructor(private readonly blob: Blob) {}
  get size() {
    return this.blob.size;
  }
  slice(start: number, end: number) {
    const part = this.blob.slice(start, end);
    return {
      arrayBuffer: async () => {
        this.reads++;
        this.inFlight++;
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        try {
          await new Promise((r) => setTimeout(r, 1));
          return await part.arrayBuffer();
        } finally {
          this.inFlight--;
        }
      },
    };
  }
}

const pumps: Array<ReturnType<typeof setInterval>> = [];
afterEach(() => {
  for (const p of pumps.splice(0)) clearInterval(p);
});

function pump(fn: () => void, ms = 1) {
  const id = setInterval(fn, ms);
  pumps.push(id);
  return id;
}

const base = { chunkSize: 64 * KiB, readSize: 256 * KiB, highWater: 256 * KiB, window: 1024 * KiB, pollMs: 20 };

describe('streamBlob', () => {
  it('sends every byte, in order, in chunk-sized messages', async () => {
    const data = randomBytes(3 * 1024 * KiB + 123);
    const changed = new Notifier();
    const channel = new FakeChannel(changed);
    pump(() => channel.transmit(128 * KiB));

    await streamBlob({
      ...base,
      source: new Blob([data]),
      channel,
      offset: 0,
      acked: () => channel.delivered,
      changed,
      signal: new AbortController().signal,
    });

    expect(channel.bytes().equals(data)).toBe(true);
    expect(channel.sent.every((c) => c.byteLength <= base.chunkSize)).toBe(true);
  });

  it('never lets bufferedAmount exceed highWater + one chunk (back-pressure)', async () => {
    const data = randomBytes(4 * 1024 * KiB);
    const changed = new Notifier();
    const channel = new FakeChannel(changed);
    // A slow network: 32 KiB per tick.
    pump(() => channel.transmit(32 * KiB));

    await streamBlob({
      ...base,
      source: new Blob([data]),
      channel,
      offset: 0,
      acked: () => channel.delivered,
      changed,
      signal: new AbortController().signal,
    });

    expect(channel.maxBuffered).toBeLessThanOrEqual(base.highWater + base.chunkSize);
    expect(channel.bytes().equals(data)).toBe(true);
  });

  it('never gets more than window + one chunk ahead of the receiver’s acks (flow control)', async () => {
    const data = randomBytes(6 * 1024 * KiB);
    const changed = new Notifier();
    const channel = new FakeChannel(changed);
    let acked = 0;
    let maxAhead = 0;
    // The network is fast, but the receiver's disk is slow: it acks 16 KiB per tick.
    pump(() => channel.transmit(1024 * KiB));
    pump(() => {
      acked = Math.min(channel.delivered, acked + 16 * KiB);
      changed.notify();
    });

    await streamBlob({
      ...base,
      highWater: 8 * 1024 * KiB,
      source: new Blob([data]),
      channel,
      offset: 0,
      acked: () => acked,
      changed,
      signal: new AbortController().signal,
      onSent: (pos) => {
        maxAhead = Math.max(maxAhead, pos - acked);
      },
    });

    expect(maxAhead).toBeLessThanOrEqual(base.window + base.chunkSize);
    expect(channel.bytes().equals(data)).toBe(true);
  });

  it('holds at most two read blocks in memory (current + one prefetch)', async () => {
    const data = randomBytes(2 * 1024 * KiB);
    const changed = new Notifier();
    const channel = new FakeChannel(changed);
    const source = new CountingSource(new Blob([data]));
    pump(() => channel.transmit(64 * KiB));

    await streamBlob({
      ...base,
      source,
      channel,
      offset: 0,
      acked: () => channel.delivered,
      changed,
      signal: new AbortController().signal,
    });

    expect(source.maxInFlight).toBe(1);
    expect(source.reads).toBe(Math.ceil(data.length / base.readSize));
  });

  it('resumes from an offset', async () => {
    const data = randomBytes(1024 * KiB);
    const offset = 300 * KiB + 7;
    const changed = new Notifier();
    const channel = new FakeChannel(changed);
    pump(() => channel.transmit(256 * KiB));

    await streamBlob({
      ...base,
      source: new Blob([data]),
      channel,
      offset,
      acked: () => offset + channel.delivered,
      changed,
      signal: new AbortController().signal,
    });

    expect(channel.bytes().equals(data.subarray(offset))).toBe(true);
  });

  it('handles empty files and offset === size', async () => {
    const changed = new Notifier();
    const channel = new FakeChannel(changed);
    const opts = { ...base, channel, acked: () => 0, changed, signal: new AbortController().signal };
    await streamBlob({ ...opts, source: new Blob([]), offset: 0 });
    await streamBlob({ ...opts, source: new Blob([new Uint8Array(10)]), offset: 10 });
    expect(channel.sent).toHaveLength(0);
  });

  it('rejects an out-of-range offset', async () => {
    const changed = new Notifier();
    await expect(
      streamBlob({
        ...base,
        source: new Blob([new Uint8Array(10)]),
        channel: new FakeChannel(changed),
        offset: 11,
        acked: () => 0,
        changed,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(RangeError);
  });

  it('stops with ChannelClosedError when the channel closes mid-transfer', async () => {
    const data = randomBytes(2 * 1024 * KiB);
    const changed = new Notifier();
    const channel = new FakeChannel(changed);
    pump(() => {
      channel.transmit(64 * KiB);
      if (channel.delivered >= 512 * KiB) {
        channel.readyState = 'closed';
        changed.notify();
      }
    });

    await expect(
      streamBlob({
        ...base,
        source: new Blob([data]),
        channel,
        offset: 0,
        acked: () => channel.delivered,
        changed,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ChannelClosedError);
    expect(channel.bytes().length).toBeLessThan(data.length);
  });

  it('stops promptly when aborted and sends nothing afterwards', async () => {
    const data = randomBytes(2 * 1024 * KiB);
    const changed = new Notifier();
    const channel = new FakeChannel(changed);
    const ac = new AbortController();
    let sentAtAbort = -1;
    pump(() => {
      channel.transmit(64 * KiB);
      if (sentAtAbort < 0 && channel.delivered >= 256 * KiB) {
        sentAtAbort = channel.bytes().length;
        ac.abort(new Error('user cancelled'));
        changed.notify();
      }
    });

    await expect(
      streamBlob({
        ...base,
        source: new Blob([data]),
        channel,
        offset: 0,
        acked: () => channel.delivered,
        changed,
        signal: ac.signal,
      }),
    ).rejects.toThrow('user cancelled');
    expect(channel.bytes().length).toBe(sentAtAbort);
  });

  it('propagates read errors', async () => {
    const changed = new Notifier();
    const broken: SourceLike = {
      size: 1024,
      slice: () => ({ arrayBuffer: () => Promise.reject(new Error('NotReadableError')) }),
    };
    await expect(
      streamBlob({
        ...base,
        source: broken,
        channel: new FakeChannel(changed),
        offset: 0,
        acked: () => 0,
        changed,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('NotReadableError');
  });
});

describe('Notifier', () => {
  it('wakes every waiter once', async () => {
    const n = new Notifier();
    let woke = 0;
    const waits = [n.wait().then(() => woke++), n.wait().then(() => woke++)];
    n.notify();
    await Promise.all(waits);
    expect(woke).toBe(2);
  });

  it('times out when nothing happens', async () => {
    const n = new Notifier();
    const t0 = Date.now();
    await n.wait(30);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
  });
});
