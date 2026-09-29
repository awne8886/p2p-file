import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/**
 * SHA-256 of one block, as lowercase hex.
 *
 * WebCrypto runs natively and off the main thread (about 1 GB/s with SHA extensions, several times faster than any
 * JavaScript hash). It only exists in secure contexts, so plain `http://<lan-ip>` development falls back to
 * @noble/hashes on the main thread.
 */
export async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) return bytesToHex(new Uint8Array(await subtle.digest('SHA-256', data)));
  return bytesToHex(sha256(data));
}
