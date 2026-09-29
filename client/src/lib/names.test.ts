import { describe, expect, it } from 'vitest';
import { sanitizeName, uniqueNames } from './names';

describe('sanitizeName', () => {
  it('removes path separators and control characters', () => {
    expect(sanitizeName('../../etc/passwd')).toBe('__.._etc_passwd');
    expect(sanitizeName('a\\b/c.txt')).toBe('a_b_c.txt');
    expect(sanitizeName('bad\u0000\u001fname.txt')).toBe('badname.txt');
  });

  it('never returns an empty or hidden name', () => {
    expect(sanitizeName('')).toBe('file');
    expect(sanitizeName('   ')).toBe('file');
    expect(sanitizeName('.env')).toBe('_env');
  });

  it('caps the length at 255', () => {
    expect(sanitizeName('x'.repeat(1000))).toHaveLength(255);
  });
});

describe('uniqueNames', () => {
  it('suffixes duplicates before the extension, case-insensitively', () => {
    expect(uniqueNames(['a.txt', 'A.txt', 'a.txt', 'b', 'b'])).toEqual([
      'a.txt',
      'A (1).txt',
      'a (2).txt',
      'b',
      'b (1)',
    ]);
  });

  it('does not collide with an existing suffixed name', () => {
    expect(uniqueNames(['a (1).txt', 'a.txt', 'a.txt'])).toEqual(['a (1).txt', 'a.txt', 'a (2).txt']);
  });
});
