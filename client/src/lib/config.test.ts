import { describe, expect, it } from 'vitest';
import { pathSegment } from './config';

describe('pathSegment', () => {
  it('reads the code at the root of a domain', () => {
    expect(pathSegment('/', '/')).toBe('');
    expect(pathSegment('/x7k4q', '/')).toBe('x7k4q');
    expect(pathSegment('/x7k4q/', '/')).toBe('x7k4q');
  });

  it('reads the code under a GitHub Pages project path', () => {
    expect(pathSegment('/p2p-file/', '/p2p-file/')).toBe('');
    expect(pathSegment('/p2p-file', '/p2p-file/')).toBe('');
    expect(pathSegment('/p2p-file/x7k4qm', '/p2p-file/')).toBe('x7k4qm');
  });

  it('rejects paths outside the app', () => {
    expect(pathSegment('/other/x7k4q', '/p2p-file/')).toBeNull();
    expect(pathSegment('/p2p-files/x7k4q', '/p2p-file/')).toBeNull();
  });

  it('keeps nested paths intact so the router can reject them', () => {
    expect(pathSegment('/p2p-file/a/b', '/p2p-file/')).toBe('a/b');
  });
});
