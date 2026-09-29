/// <reference lib="webworker" />
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { HashRequest, HashResponse } from '../lib/hashProtocol';

/**
 * Incremental SHA-256 off the main thread. WebCrypto's `digest()` needs the
 * whole input at once, which rules it out for multi-GB streams, so we use
 * @noble/hashes (audited, dependency-free) and feed it chunk by chunk.
 */
const ctx = self as unknown as DedicatedWorkerGlobalScope;
const SLICE = 4 * 1024 * 1024;

let running = sha256.create();
// File-mode jobs are serialised so two big files don't thrash the disk.
let queue: Promise<void> = Promise.resolve();

const reply = (msg: HashResponse) => ctx.postMessage(msg);

ctx.onmessage = (ev: MessageEvent<HashRequest>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'update':
      running.update(new Uint8Array(msg.data));
      break;
    case 'digest':
      reply({ type: 'digest', id: msg.id, hex: bytesToHex(running.digest()) });
      running = sha256.create();
      break;
    case 'hash-file':
      queue = queue.then(() => hashFile(msg.id, msg.file));
      break;
  }
};

async function hashFile(id: number, file: Blob): Promise<void> {
  try {
    const h = sha256.create();
    let lastReport = 0;
    for (let pos = 0; pos < file.size; pos += SLICE) {
      const buf = await file.slice(pos, Math.min(pos + SLICE, file.size)).arrayBuffer();
      h.update(new Uint8Array(buf));
      const now = performance.now();
      if (now - lastReport > 200) {
        lastReport = now;
        reply({ type: 'progress', id, bytes: pos + buf.byteLength });
      }
    }
    reply({ type: 'digest', id, hex: bytesToHex(h.digest()) });
  } catch (err) {
    reply({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
}
