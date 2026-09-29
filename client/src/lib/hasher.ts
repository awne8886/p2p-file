import type { HashRequest, HashResponse } from './hashProtocol';

function spawn(): Worker {
  return new Worker(new URL('../workers/hash.worker.ts', import.meta.url), { type: 'module', name: 'sha256' });
}

type Pending = { resolve(hex: string): void; reject(err: Error): void; onProgress?: (bytes: number) => void };

class WorkerClient {
  protected readonly worker = spawn();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  constructor() {
    this.worker.onmessage = (ev: MessageEvent<HashResponse>) => {
      const msg = ev.data;
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.type === 'progress') {
        p.onProgress?.(msg.bytes);
        return;
      }
      this.pending.delete(msg.id);
      if (msg.type === 'digest') p.resolve(msg.hex);
      else p.reject(new Error(msg.message));
    };
    this.worker.onerror = (ev) => {
      const err = new Error(ev.message || 'hash worker crashed');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  protected request(make: (id: number) => HashRequest, onProgress?: (bytes: number) => void): Promise<string> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage(make(id));
    });
  }

  terminate(): void {
    this.worker.terminate();
    const err = new Error('hasher terminated');
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}

/**
 * Sender side: fingerprints each file once, in the background, as soon as it
 * is dropped. The digest is announced to receivers at the end of each file.
 */
export class FileHasher extends WorkerClient {
  private readonly digests = new Map<number, Promise<string>>();

  constructor(
    private readonly files: readonly File[],
    onProgress?: (hashedBytes: number) => void,
  ) {
    super();
    const done = new Array<number>(files.length).fill(0);
    const report = () => onProgress?.(done.reduce((a, b) => a + b, 0));
    files.forEach((file, i) => {
      const p = this.request(
        (id) => ({ type: 'hash-file', id, file }),
        (bytes) => {
          done[i] = bytes;
          report();
        },
      );
      p.then(
        () => {
          done[i] = file.size;
          report();
        },
        () => undefined,
      );
      this.digests.set(i, p);
    });
  }

  digest(index: number): Promise<string> {
    const p = this.digests.get(index);
    if (!p) return Promise.reject(new RangeError(`no file #${index}`));
    return p;
  }

  get totalBytes(): number {
    return this.files.reduce((a, f) => a + f.size, 0);
  }
}

/**
 * Receiver side: a running hash fed with every chunk as it arrives. Messages
 * are processed in order by the worker, so `digest()` covers exactly the bytes
 * passed to `update()` before it, and then starts a fresh hash.
 */
export class StreamHasher extends WorkerClient {
  update(chunk: ArrayBuffer): void {
    // Structured clone copies the buffer, so the caller keeps using its own.
    this.worker.postMessage({ type: 'update', data: chunk } satisfies HashRequest);
  }

  digest(): Promise<string> {
    return this.request((id) => ({ type: 'digest', id }));
  }
}
