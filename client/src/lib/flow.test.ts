import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChannelClosedError,
  Notifier,
  streamBlob,
  type BlockInfo,
  type ChannelLike,
  type Credit,
  type SourceLike,
  type StreamOptions,
} from './flow';

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

const sha256 = async (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

const base = { chunkSize: 64 * KiB, blockSize: 256 * KiB, highWater: 256 * KiB, window: 1024 * KiB, pollMs: 20 };

/** Options for one transfer, with a credit whose acks track what the fake network delivered unless overridden. */
function options(
  channel: FakeChannel,
  changed: Notifier,
  source: SourceLike,
  extra: Partial<StreamOptions> & { acked?: () => number } = {},
): StreamOptions & { blocks: BlockInfo[] } {
  const { acked = () => channel.delivered, ...rest } = extra;
  const credit: Credit = {
    sent: 0,
    get acked() {
      return acked();
    },
  };
  const blocks: BlockInfo[] = [];
  return {
    ...base,
    source,
    channel,
    offset: 0,
    credit,
    changed,
    signal: new AbortController().signal,
    digest: sha256,
    onBlock: (b) => blocks.push(b),
    blocks,
    ...rest,
  };
}

describe('streamBlob', () => {
  it('sends every byte, in order, in chunk-sized messages', async () => {
    const data = randomBytes(3 * 1024 * KiB + 123);
    const changed = new Notifier();
    const channel = new FakeChannel(changed);
    pump(() => channel.transmit(128 * KiB));

    await streamBlob(options(channel, changed, new Blob([data])));

    expect(channel.bytes().equals(data)).toBe(true);
    expect(channel.sent.every((c) => c.byteLength <= base.chunkSize)).toBe(true);
  });

  it('announces each block, aligned, with the SHA-256 of exactly its bytes', async () => {
    const data = randomBytes(3 * 256 * KiB + 99);
    const changed = new Notifier();
    const channel = new FakeChannel(changed);
    pump(() => channel.transmit(256 * KiB));
    const o = options(channel, changed, new Blob([data]));

    await streamBlob(o);

    expect(o.blocks.map((b) => [b.offset, b.size])).toEqual([
      [0, 256 * KiB],
      [256 * KiB, 256 * KiB],
      [512 * KiB, 256 * KiB],
      [768 * KiB, 99],
    ]);
    for (const b of o.blocks) {
      expect(b.sha256).toBe(await sha256(data.subarray(b.offset, b.offset + b.size)));
    }
  });

  it('announces a block before any of its bytes', async () => {
    const data = randomBytes(600 * KiB);
    const changed = new Notifier();
    const channel = new FakeChannel(changed);
    pump(() => channel.transmit(256 * KiB));
    const events: string[] = [];
    const o = options(channel, changed, new Blob([data]), {
      onBlock: (b) => events.push(`block@${b.offset}`),
      onSent: (pos) => events.push(`data@${pos}`),
    });

    await streamBlob(o);

    expect(events.indexOf('block@0')).toBe(0);
    expect(events.indexOf('block@262144')).toBe(events.indexOf('data@262144') + 1);
    expect(events.indexOf('block@524288')).toBe(events.indexOf('data@524288') + 1);
  });

  it('never lets bufferedAmount exceed highWater + one chunk (back-pressure)', async () => {
    const data = randomBytes(4 * 1024 * KiB);
    const changed = new Notifier();
    const channel = new FakeChannel(changed);
    // A slow network: 32 KiB per tick.
    pump(() => channel.transmit(32 * KiB));

    await streamBlob(options(channel, changed, new Blob([data])));

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

    const o = options(channel, changed, new Blob([data]), {
      highWater: 8 * 1024 * KiB,
      acked: () => acked,
      onSent: () => {
        maxAhead = Math.max(maxAhead, o.credit.sent - acked);
      },
    });
    await streamBlob(o);

    expect(maxAhead).toBeLessThanOrEqual(base.window + base.chunkSize);
    expect(channel.bytes().equals(data)).toBe(true);
  });

  it('counts flow-control credit across files sent over the same channel', async () => {
    const changed = new Notifier();
    const channel = new FakeChannel(changed);
    pump(() => channel.transmit(256 * KiB));
    const o = options(channel, changed, new Blob([randomBytes(300 * KiB)]));
    await streamBlob(o);
    await streamBlob({ ...o, source: new Blob([randomBytes(200 * KiB)]) });
    expect(o.credit.sent).toBe(500 * KiB);
  });

  it('holds at most two blocks in memory (current + one prefetch)', async () => {
    const data = randomBytes(2 * 1024 * KiB);
    const changed = new Notifier();
    const channel = new FakeChannel(changed);
    const source = new CountingSource(new Blob([data]));
    pump(() => channel.transmit(64 * KiB));

    await streamBlob(options(channel, changed, source));

    expect(source.maxInFlight).toBe(1);
    expect(source.reads).toBe(Math.ceil(data.length / base.blockSize));
  });

  it('resumes from a block boundary', async () => {
    const data = randomBytes(1024 * KiB + 5);
    const offset = 2 * base.blockSize;
    const changed = new Notifier();
    const channel = new FakeChannel(changed);
    pump(() => channel.transmit(256 * KiB));
    const o = options(channel, changed, new Blob([data]), { offset });

    await streamBlob(o);

    expect(channel.bytes().equals(data.subarray(offset))).toBe(true);
    expect(o.blocks[0]!.offset).toBe(offset);
  });

  it('handles empty files and offset === size', async () => {
    const changed = new Notifier();
    const channel = new FakeChannel(changed);
    const empty = options(channel, changed, new Blob([]));
    await streamBlob(empty);
    const end = options(channel, changed, new Blob([new Uint8Array(10)]), { offset: 10 });
    await streamBlob(end);
    expect(channel.sent).toHaveLength(0);
    expect(empty.blocks).toHaveLength(0);
    expect(end.blocks).toHaveLength(0);
  });

  it('rejects an out-of-range or unaligned offset', async () => {
    const changed = new Notifier();
    const source = new Blob([new Uint8Array(600 * KiB)]);
    const channel = new FakeChannel(changed);
    await expect(streamBlob(options(channel, changed, source, { offset: 600 * KiB + 1 }))).rejects.toThrow(RangeError);
    await expect(streamBlob(options(channel, changed, source, { offset: 1000 }))).rejects.toThrow('block boundary');
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

    await expect(streamBlob(options(channel, changed, new Blob([data])))).rejects.toBeInstanceOf(ChannelClosedError);
    expect(channel.bytes().length).toBeLessThan(data.length);
  });

  it('treats a channel that refuses data as closed', async () => {
    const changed = new Notifier();
    const channel = new FakeChannel(changed);
    channel.send = () => {
      throw new DOMException('Failure to send data', 'OperationError');
    };
    await expect(streamBlob(options(channel, changed, new Blob([randomBytes(1000)])))).rejects.toBeInstanceOf(
      ChannelClosedError,
    );
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

    await expect(streamBlob(options(channel, changed, new Blob([data]), { signal: ac.signal }))).rejects.toThrow(
      'user cancelled',
    );
    expect(channel.bytes().length).toBe(sentAtAbort);
  });

  it('propagates read errors', async () => {
    const changed = new Notifier();
    const broken: SourceLike = {
      size: 1024,
      slice: () => ({ arrayBuffer: () => Promise.reject(new Error('NotReadableError')) }),
    };
    await expect(streamBlob(options(new FakeChannel(changed), changed, broken))).rejects.toThrow('NotReadableError');
  });

  it('fails if the file got shorter since it was picked', async () => {
    const changed = new Notifier();
    const shrunk: SourceLike = {
      size: 1024,
      slice: () => ({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)) }),
    };
    await expect(streamBlob(options(new FakeChannel(changed), changed, shrunk))).rejects.toThrow('changed size');
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
