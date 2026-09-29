/**
 * Short share codes.
 *
 * Codes are 5–6 characters drawn from an alphabet with every easily-confused
 * glyph removed: no `0/O/o`, no `1/l/I/i`. Codes are case-insensitive — they
 * are always generated and stored in lowercase, and user input is normalised
 * before lookup — so the uppercase lookalikes can never appear either.
 *
 * 31 symbols: 5 chars ≈ 28.6 M codes, 6 chars ≈ 887 M codes.
 */
export const CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

export const MIN_CODE_LENGTH = 5;
export const MAX_CODE_LENGTH = 6;
export const DEFAULT_CODE_LENGTH = 5;

/** Characters that must never appear in a code (in any case). */
export const AMBIGUOUS_CHARS = '0Oo1lIi';

const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${MIN_CODE_LENGTH},${MAX_CODE_LENGTH}}$`);

/** A source of uniformly-distributed integers in `[0, maxExclusive)`. */
export type RandomInt = (maxExclusive: number) => number;

/**
 * Generate a code of `length` characters using `randomInt`, which must be a
 * uniform source (e.g. `crypto.randomInt` on Node, or {@link cryptoRandomInt}).
 */
export function generateCode(randomInt: RandomInt, length: number = DEFAULT_CODE_LENGTH): string {
  if (!Number.isInteger(length) || length < MIN_CODE_LENGTH || length > MAX_CODE_LENGTH) {
    throw new RangeError(`code length must be an integer between ${MIN_CODE_LENGTH} and ${MAX_CODE_LENGTH}`);
  }
  let out = '';
  for (let i = 0; i < length; i++) {
    const idx = randomInt(CODE_ALPHABET.length);
    if (!Number.isInteger(idx) || idx < 0 || idx >= CODE_ALPHABET.length) {
      throw new RangeError(`randomInt returned out-of-range value ${idx}`);
    }
    out += CODE_ALPHABET[idx];
  }
  return out;
}

/**
 * Generate a code that is not already taken. Starts at `length` and, if the
 * space is crowded enough that `attemptsPerLength` random draws all collide,
 * moves on to the next length (up to {@link MAX_CODE_LENGTH}).
 */
export function generateUniqueCode(
  randomInt: RandomInt,
  isTaken: (code: string) => boolean,
  length: number = DEFAULT_CODE_LENGTH,
  attemptsPerLength = 12,
): string {
  for (let len = length; len <= MAX_CODE_LENGTH; len++) {
    for (let attempt = 0; attempt < attemptsPerLength; attempt++) {
      const code = generateCode(randomInt, len);
      if (!isTaken(code)) return code;
    }
  }
  throw new Error('could not allocate a unique share code');
}

/** Lowercase and trim user input so `X7K4Q ` finds the room `x7k4q`. */
export function normalizeCode(input: string): string {
  return input.trim().toLowerCase();
}

/** True if `input` (after normalisation) is a syntactically valid code. */
export function isValidCode(input: string): boolean {
  return CODE_RE.test(normalizeCode(input));
}

/** Uniform random integer from WebCrypto (browser or Node ≥ 19). Rejection-samples to avoid modulo bias. */
export function cryptoRandomInt(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 2 ** 32) {
    throw new RangeError('maxExclusive must be an integer in (0, 2^32]');
  }
  const limit = Math.floor(2 ** 32 / maxExclusive) * maxExclusive;
  const buf = new Uint32Array(1);
  const { crypto } = globalThis as unknown as { crypto: { getRandomValues(a: Uint32Array): Uint32Array } };
  for (;;) {
    crypto.getRandomValues(buf);
    const v = buf[0]!;
    if (v < limit) return v % maxExclusive;
  }
}
