import { describe, expect, it } from 'vitest';
import {
  AMBIGUOUS_CHARS,
  CODE_ALPHABET,
  cryptoRandomInt,
  generateCode,
  generateUniqueCode,
  isValidCode,
  MAX_CODE_LENGTH,
  normalizeCode,
} from './code.js';

describe('CODE_ALPHABET', () => {
  it('contains no ambiguous characters in any case', () => {
    for (const ch of AMBIGUOUS_CHARS) {
      expect(CODE_ALPHABET).not.toContain(ch);
      expect(CODE_ALPHABET).not.toContain(ch.toLowerCase());
      expect(CODE_ALPHABET.toUpperCase()).not.toContain(ch.toUpperCase());
    }
  });

  it('has no duplicate symbols', () => {
    expect(new Set(CODE_ALPHABET).size).toBe(CODE_ALPHABET.length);
  });
});

describe('generateCode', () => {
  it('produces 5-character codes by default, from the alphabet only', () => {
    for (let i = 0; i < 2000; i++) {
      const code = generateCode(cryptoRandomInt);
      expect(code).toHaveLength(5);
      expect([...code].every((c) => CODE_ALPHABET.includes(c))).toBe(true);
      expect(isValidCode(code)).toBe(true);
    }
  });

  it('supports 6-character codes', () => {
    expect(generateCode(cryptoRandomInt, 6)).toHaveLength(6);
  });

  it('rejects lengths outside 5–6', () => {
    expect(() => generateCode(cryptoRandomInt, 4)).toThrow(RangeError);
    expect(() => generateCode(cryptoRandomInt, 7)).toThrow(RangeError);
  });

  it('rejects a broken random source', () => {
    expect(() => generateCode(() => CODE_ALPHABET.length)).toThrow(RangeError);
    expect(() => generateCode(() => -1)).toThrow(RangeError);
  });

  it('uses every symbol roughly uniformly', () => {
    const counts = new Map<string, number>();
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      for (const c of generateCode(cryptoRandomInt)) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    const expected = (n * 5) / CODE_ALPHABET.length;
    expect(counts.size).toBe(CODE_ALPHABET.length);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(expected * 0.85);
      expect(count).toBeLessThan(expected * 1.15);
    }
  });
});

describe('generateUniqueCode', () => {
  it('avoids codes that are taken', () => {
    const taken = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const code = generateUniqueCode(cryptoRandomInt, (c) => taken.has(c));
      expect(taken.has(code)).toBe(false);
      taken.add(code);
    }
  });

  it('falls back to a longer code when the short space is exhausted', () => {
    const code = generateUniqueCode(cryptoRandomInt, (c) => c.length === 5);
    expect(code).toHaveLength(MAX_CODE_LENGTH);
  });

  it('throws when no code can be found', () => {
    expect(() => generateUniqueCode(cryptoRandomInt, () => true)).toThrow();
  });
});

describe('normalizeCode / isValidCode', () => {
  it('is case-insensitive and trims whitespace', () => {
    expect(normalizeCode('  X7K4Q ')).toBe('x7k4q');
    expect(isValidCode('X7K4Q')).toBe(true);
  });

  it('rejects wrong lengths and ambiguous characters', () => {
    expect(isValidCode('x7k4')).toBe(false);
    expect(isValidCode('x7k4q2m')).toBe(false);
    expect(isValidCode('x0k4q')).toBe(false);
    expect(isValidCode('x1k4q')).toBe(false);
    expect(isValidCode('xlk4q')).toBe(false);
    expect(isValidCode('xok4q')).toBe(false);
    expect(isValidCode('x/k4q')).toBe(false);
  });
});

describe('cryptoRandomInt', () => {
  it('stays in range', () => {
    for (let i = 0; i < 5000; i++) {
      const v = cryptoRandomInt(31);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(31);
    }
  });

  it('validates its argument', () => {
    expect(() => cryptoRandomInt(0)).toThrow(RangeError);
    expect(() => cryptoRandomInt(1.5)).toThrow(RangeError);
  });
});
