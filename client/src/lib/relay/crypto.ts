/**
 * End-to-end protection for signaling that travels through public relays.
 *
 * Both ends know the share code, and nothing else. From it they derive, with a deliberately slow PBKDF2:
 *  - `room`: a public name for the share. Relays only ever see this, never the code, and turning it back into the
 *    code means trying every possible code at 200 000 PBKDF2 rounds each.
 *  - `key`: an AES-GCM key. Every signaling message is sealed with it, so relays can't read the session
 *    descriptions (which contain IP addresses and DTLS fingerprints) and can't forge or alter one. Without
 *    this, anyone watching a public relay could swap the fingerprints and read the files.
 *
 * The salt is fixed on purpose: a receiver must get from the code alone to the same room.
 *
 * Everyone with the link has the code, though, so the sender also signs what it sends with a key of its own
 * ({@link createHostSigner}). A receiver keeps to the first sender key it hears from and stops if a different one
 * answers: someone else with the link can't pose as the sender without being noticed, because the real sender
 * answers too.
 */

const ITERATIONS = 200_000;
const SALT = 'pizzadrop/signal/v1';
const IV_BYTES = 12;
const AAD = new TextEncoder().encode('pizzadrop');

export interface RoomKeys {
  /** 32 hex characters naming the share on relays. */
  room: string;
  key: CryptoKey;
}

export class InsecureContextError extends Error {
  constructor() {
    super('PizzaDrop needs a secure (https://) page to connect through public relays.');
    this.name = 'InsecureContextError';
  }
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new InsecureContextError();
  return s;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function deriveRoomKeys(code: string, iterations = ITERATIONS): Promise<RoomKeys> {
  const s = subtle();
  const base = await s.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(
    await s.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(SALT), iterations }, base, 384),
  );
  const key = await s.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { room: toHex(bits.slice(32, 48)), key };
}

/** Encrypt `plaintext` as base64url(iv ‖ ciphertext). The first 16 characters (the random IV) identify it. */
export async function seal(keys: RoomKeys, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, keys.key, enc.encode(plaintext)),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return toBase64Url(out);
}

/** Decrypt what {@link seal} produced; `null` if it wasn't sealed with this key or was altered. */
export async function unseal(keys: RoomKeys, wire: string): Promise<string | null> {
  const bytes = fromBase64Url(wire);
  if (!bytes || bytes.length <= IV_BYTES + 16) return null;
  try {
    const pt = await subtle().decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES), additionalData: AAD },
      keys.key,
      bytes.slice(IV_BYTES),
    );
    return dec.decode(pt);
  } catch {
    return null;
  }
}

export interface HostSigner {
  /** base64url of the raw P-256 public key. */
  publicKey: string;
  sign(data: string): Promise<string>;
}

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

/** A signing key for one share, created by the sender. */
export async function createHostSigner(): Promise<HostSigner> {
  const s = subtle();
  const pair = await s.generateKey(ECDSA, false, ['sign', 'verify']);
  const publicKey = toBase64Url(new Uint8Array(await s.exportKey('raw', pair.publicKey)));
  return {
    publicKey,
    sign: async (data) => toBase64Url(new Uint8Array(await s.sign(SIGN, pair.privateKey, enc.encode(data)))),
  };
}

const verifiers = new Map<string, Promise<CryptoKey | null>>();

/** True if `sig` is `publicKey`'s signature of `data`. */
export async function verifyHost(publicKey: string, data: string, sig: string): Promise<boolean> {
  let key = verifiers.get(publicKey);
  if (!key) {
    if (verifiers.size >= 16) verifiers.clear(); // one sender per share; anything more is noise
    const raw = fromBase64Url(publicKey);
    key = raw
      ? subtle()
          .importKey('raw', raw, ECDSA, false, ['verify'])
          .catch(() => null)
      : Promise.resolve(null);
    verifiers.set(publicKey, key);
  }
  const k = await key;
  const signature = fromBase64Url(sig);
  if (!k || !signature) return false;
  try {
    return await subtle().verify(SIGN, k, signature, enc.encode(data));
  } catch {
    return false;
  }
}

/** A sealed message's id: its IV, which is random per message. Lets duplicates be dropped before decrypting. */
export function wireId(wire: string): string {
  return wire.slice(0, 16);
}

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
