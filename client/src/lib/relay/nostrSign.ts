import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/** A signed Nostr event (NIP-01). */
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export type Sign = (kind: number, tags: string[][], content: string) => NostrEvent;

/**
 * Relays only accept events signed by the key they name. A throwaway key per page is enough: what the event
 * carries is sealed with the share's key anyway, and receivers don't check who signed it.
 */
export function createSigner(): Sign {
  const secret = schnorr.utils.randomSecretKey();
  const pubkey = bytesToHex(schnorr.getPublicKey(secret));
  return (kind, tags, content) => {
    const created_at = Math.floor(Date.now() / 1000);
    const hash = sha256(utf8ToBytes(JSON.stringify([0, pubkey, created_at, kind, tags, content])));
    return {
      id: bytesToHex(hash),
      pubkey,
      created_at,
      kind,
      tags,
      content,
      sig: bytesToHex(schnorr.sign(hash, secret)),
    };
  };
}
