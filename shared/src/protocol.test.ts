import { describe, expect, it } from 'vitest';
import { parseClientMessage, parseReceiverMessage, parseSenderMessage, parseServerMessage } from './protocol.js';

const j = (v: unknown) => JSON.stringify(v);

describe('parseClientMessage', () => {
  it('accepts well-formed messages', () => {
    expect(parseClientMessage(j({ t: 'host' }))).toEqual({ t: 'host' });
    expect(parseClientMessage(j({ t: 'join', code: 'x7k4q', clientId: 'abc' }))).toEqual({
      t: 'join',
      code: 'x7k4q',
      clientId: 'abc',
    });
    const signal = { t: 'signal', to: 'p1', data: { kind: 'description', description: { type: 'offer', sdp: 'v=0' } } };
    expect(parseClientMessage(j(signal))).toEqual(signal);
    expect(parseClientMessage(j({ t: 'signal', data: { kind: 'candidate', candidate: null } }))).toEqual({
      t: 'signal',
      data: { kind: 'candidate', candidate: null },
    });
  });

  it('rejects garbage and malformed shapes', () => {
    expect(parseClientMessage('not json')).toBeNull();
    expect(parseClientMessage(j([1, 2]))).toBeNull();
    expect(parseClientMessage(j({ t: 'nope' }))).toBeNull();
    expect(parseClientMessage(j({ t: 'join', code: 'x7k4q' }))).toBeNull();
    expect(parseClientMessage(j({ t: 'join', code: 'x7k4q', clientId: '' }))).toBeNull();
    expect(
      parseClientMessage(j({ t: 'signal', data: { kind: 'description', description: { type: 'pranswer', sdp: '' } } })),
    ).toBeNull();
    expect(
      parseClientMessage(
        j({ t: 'signal', data: { kind: 'description', description: { type: 'offer', sdp: 'x'.repeat(40_000) } } }),
      ),
    ).toBeNull();
    expect(parseClientMessage(new ArrayBuffer(4))).toBeNull();
  });
});

describe('parseServerMessage', () => {
  it('validates hello and hosted', () => {
    expect(
      parseServerMessage(j({ t: 'hello', version: 1, iceServers: [{ urls: 'stun:x' }], publicUrl: null })),
    ).not.toBeNull();
    expect(parseServerMessage(j({ t: 'hello', version: 1, iceServers: [{ urls: 5 }], publicUrl: null }))).toBeNull();
    expect(parseServerMessage(j({ t: 'hosted', code: 'x7k4q', token: 't', expiresAt: 1, peers: [] }))).not.toBeNull();
    expect(parseServerMessage(j({ t: 'hosted', code: 'x7k4q', token: 't', expiresAt: 1, peers: [{}] }))).toBeNull();
  });
});

describe('peer messages', () => {
  it('parses sender messages', () => {
    const manifest = { type: 'manifest', version: 1, files: [{ name: 'a.txt', size: 3, type: '', lastModified: 0 }] };
    expect(parseSenderMessage(j(manifest))).toEqual(manifest);
    expect(parseSenderMessage(j({ type: 'manifest', version: 1, files: [] }))).toBeNull();
    expect(
      parseSenderMessage(j({ ...manifest, files: [{ name: '', size: 3, type: '', lastModified: 0 }] })),
    ).toBeNull();
    expect(
      parseSenderMessage(j({ ...manifest, files: [{ name: 'a', size: -1, type: '', lastModified: 0 }] })),
    ).toBeNull();
    expect(parseSenderMessage(j({ type: 'file-end', index: 0, sha256: 'a'.repeat(64) }))).not.toBeNull();
    expect(parseSenderMessage(j({ type: 'file-end', index: 0, sha256: 'A'.repeat(64) }))).toBeNull();
    expect(parseSenderMessage(j({ type: 'file-end', index: 0, sha256: 'abc' }))).toBeNull();
  });

  it('parses receiver messages', () => {
    expect(parseReceiverMessage(j({ type: 'request', index: 0, offset: 10 }))).toEqual({
      type: 'request',
      index: 0,
      offset: 10,
    });
    expect(parseReceiverMessage(j({ type: 'request', index: -1, offset: 0 }))).toBeNull();
    expect(parseReceiverMessage(j({ type: 'request', index: 0, offset: 1.5 }))).toBeNull();
    expect(parseReceiverMessage(j({ type: 'ack', index: 0, bytes: 5 }))).toEqual({ type: 'ack', index: 0, bytes: 5 });
    expect(parseReceiverMessage(j({ type: 'done' }))).toEqual({ type: 'done' });
  });
});
