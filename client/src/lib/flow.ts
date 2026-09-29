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
  constructor(cause?: unknown) {
    super('data channel closed', { cause });
    this.name = 'ChannelClosedError';
  }
}

/** Connection-wide flow-control counters, shared by every file sent over one data channel. */
export interface Credit {
  /** Binary bytes handed to `send()` on this channel. */
  sent: number;
  /** Binary bytes the receiver says it has finished with (written to disk or discarded). */
  acked: number;
}

export interface BlockInfo {
  offset: number;
  size: number;
  sha256: string;
}

export interface StreamOptions {
  source: SourceLike;
  channel: ChannelLike;
  /** First byte to send: 0, a multiple of `blockSize` (a receiver resuming), or the file size (nothing left). */
  offset: number;
  blockSize: number;
  chunkSize: number;
  /** Pause while `channel.bufferedAmount` exceeds this. */
  highWater: number;
  /** Pause while `credit.sent - credit.acked` reaches this. */
  window: number;
  credit: Credit;
  /** Notified on `bufferedamountlow`, on every ack, and on close/abort. */
  changed: Notifier;
  signal: AbortSignal;
  /** Hex SHA-256 of one block. */
  digest(data: Uint8Array<ArrayBuffer>): Promise<string>;
  /** Announce a block. Called just before its bytes are sent. */
  onBlock(block: BlockInfo): void;
  /** Called after each chunk is handed to the channel with the new absolute position. */
  onSent?: (position: number) => void;
  /** Fallback poll interval in case an event is missed. */
  pollMs?: number;
}

/**
 * Send `source[offset..size)` as blocks: for each block, {@link StreamOptions.onBlock} announces its offset, size and
 * SHA-256, then its bytes follow as `chunkSize` messages.
 *
 * - Reads and hashes the next block while the current one is being sent, so the disk, the hash and the network all
 *   stay busy. At most two blocks are in memory at once.
 * - Never lets `bufferedAmount` exceed `highWater + chunkSize`.
 * - Never lets `credit.sent - credit.acked` exceed `window + chunkSize`.
 *
 * Rejects with {@link ChannelClosedError} if the channel closes (or refuses data), with the signal's reason if
 * aborted, or with the read error if the file can't be read.
 */
export async function streamBlob(o: StreamOptions): Promise<void> {
  const size = o.source.size;
  if (o.offset < 0 || o.offset > size) throw new RangeError(`offset ${o.offset} outside file of ${size} bytes`);
  if (o.offset % o.blockSize !== 0 && o.offset !== size) {
    throw new RangeError(`offset ${o.offset} is not on a block boundary`);
  }
  if (o.chunkSize <= 0 || o.blockSize <= 0) throw new RangeError('chunkSize and blockSize must be positive');

  const load = (start: number): Promise<{ bytes: Uint8Array<ArrayBuffer>; sha256: string }> => {
    const end = Math.min(start + o.blockSize, size);
    const p = o.source
      .slice(start, end)
      .arrayBuffer()
      .then(async (buf) => {
        const bytes = new Uint8Array(buf);
        if (bytes.byteLength !== end - start) throw new Error('file changed size while it was being sent');
        return { bytes, sha256: await o.digest(bytes) };
      });
    // Avoid an unhandled rejection if we bail out before awaiting a prefetch.
    p.catch(() => undefined);
    return p;
  };

  let position = o.offset;
  let pending = position < size ? load(position) : null;

  while (pending) {
    const { bytes, sha256 } = await pending;
    const nextStart = position + bytes.byteLength;
    pending = nextStart < size ? load(nextStart) : null;

    checkAlive(o);
    o.onBlock({ offset: position, size: bytes.byteLength, sha256 });
    for (let off = 0; off < bytes.byteLength; off += o.chunkSize) {
      await waitForCapacity(o);
      const chunk = bytes.subarray(off, Math.min(off + o.chunkSize, bytes.byteLength));
      try {
        o.channel.send(chunk);
      } catch (err) {
        // A channel that is being torn down can refuse data before its readyState says so.
        throw new ChannelClosedError(err);
      }
      o.credit.sent += chunk.byteLength;
      position += chunk.byteLength;
      o.onSent?.(position);
    }
  }
}

function checkAlive(o: StreamOptions): void {
  if (o.signal.aborted) throw o.signal.reason ?? new DOMException('aborted', 'AbortError');
  if (o.channel.readyState !== 'open') throw new ChannelClosedError();
}

async function waitForCapacity(o: StreamOptions): Promise<void> {
  for (;;) {
    checkAlive(o);
    if (o.channel.bufferedAmount <= o.highWater && o.credit.sent - o.credit.acked < o.window) return;
    await o.changed.wait(o.pollMs ?? 250);
  }
}
