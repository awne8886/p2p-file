/**
 * Chunked, back-pressured streaming of a Blob over a data channel.
 *
 * Everything here is written against tiny structural interfaces
 * ({@link ChannelLike}, {@link SourceLike}) so it can be unit-tested without a
 * browser or a real RTCDataChannel.
 */

/** Wakes up everyone waiting on "something changed" (buffer drained, ack arrived, channel closed…). */
export class Notifier {
  private waiters = new Set<() => void>();

  notify(): void {
    const waiters = this.waiters;
    this.waiters = new Set();
    for (const w of waiters) w();
  }

  /** Resolves on the next {@link notify}, or after `timeoutMs` as a safety net against missed events. */
  wait(timeoutMs = 0): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (timer !== undefined) clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      this.waiters.add(done);
      if (timeoutMs > 0) timer = setTimeout(done, timeoutMs);
    });
  }
}

export interface ChannelLike {
  readonly readyState: string;
  readonly bufferedAmount: number;
  send(data: Uint8Array<ArrayBuffer>): void;
}

export interface SourceLike {
  readonly size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

export class ChannelClosedError extends Error {
  constructor() {
    super('data channel closed');
    this.name = 'ChannelClosedError';
  }
}

export interface StreamOptions {
  source: SourceLike;
  channel: ChannelLike;
  /** First byte to send (non-zero when a receiver resumes). */
  offset: number;
  chunkSize: number;
  readSize: number;
  /** Pause while `channel.bufferedAmount` exceeds this. */
  highWater: number;
  /** Pause while more than this many bytes are sent but not yet acknowledged. */
  window: number;
  /** Bytes of this file the receiver has acknowledged (absolute offset). */
  acked: () => number;
  /** Notified on `bufferedamountlow`, on every ack, and on close/abort. */
  changed: Notifier;
  signal: AbortSignal;
  /** Called after each chunk is handed to the channel with the new absolute position. */
  onSent?: (position: number) => void;
  /** Fallback poll interval in case an event is missed. */
  pollMs?: number;
}

/**
 * Send `source[offset..size)` as `chunkSize` messages.
 *
 * - Never reads more than two `readSize` blocks into memory (current + prefetch).
 * - Never lets `bufferedAmount` exceed `highWater + chunkSize`.
 * - Never gets more than `window + chunkSize` bytes ahead of the receiver's acks.
 *
 * Rejects with {@link ChannelClosedError} if the channel closes, with the
 * signal's reason if aborted, or with the read error if the file can't be read.
 */
export async function streamBlob(o: StreamOptions): Promise<void> {
  const size = o.source.size;
  if (o.offset < 0 || o.offset > size) throw new RangeError(`offset ${o.offset} outside file of ${size} bytes`);
  if (o.chunkSize <= 0 || o.readSize <= 0) throw new RangeError('chunkSize and readSize must be positive');

  const read = (start: number): Promise<ArrayBuffer> => {
    const p = o.source.slice(start, Math.min(start + o.readSize, size)).arrayBuffer();
    // Avoid an unhandled rejection if we bail out before awaiting a prefetch.
    p.catch(() => undefined);
    return p;
  };

  let position = o.offset;
  let pending: Promise<ArrayBuffer> | null = position < size ? read(position) : null;

  while (pending) {
    const block = new Uint8Array(await pending);
    if (block.byteLength === 0) throw new Error('file became shorter while it was being sent');
    const nextStart = position + block.byteLength;
    pending = nextStart < size ? read(nextStart) : null;

    for (let off = 0; off < block.byteLength; off += o.chunkSize) {
      await waitForCapacity(o, position);
      const chunk = block.subarray(off, Math.min(off + o.chunkSize, block.byteLength));
      o.channel.send(chunk);
      position += chunk.byteLength;
      o.onSent?.(position);
    }
  }
}

async function waitForCapacity(o: StreamOptions, position: number): Promise<void> {
  for (;;) {
    if (o.signal.aborted) throw o.signal.reason ?? new DOMException('aborted', 'AbortError');
    if (o.channel.readyState !== 'open') throw new ChannelClosedError();
    if (o.channel.bufferedAmount <= o.highWater && position - o.acked() < o.window) return;
    await o.changed.wait(o.pollMs ?? 250);
  }
}
