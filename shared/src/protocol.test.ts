import { describe, expect, it } from 'vitest';
import {
  MAX_BLOCK_SIZE,
  parseClientMessage,
  parseReceiverMessage,
  parseSenderMessage,
  parseServerMessage,
  PROTOCOL_VERSION,
} from './protocol.js';

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

  it('carries connection-attempt ids on joins and connection ids on signals', () => {
    expect(parseClientMessage(j({ t: 'join', code: 'x7k4q', clientId: 'abc', attempt: 'a1b2c3' }))).toEqual({
      t: 'join',
      code: 'x7k4q',
      clientId: 'abc',
      attempt: 'a1b2c3',
    });
    const signal = { t: 'signal', data: { kind: 'candidate', candidate: null, conn: 'c0ffee' } };
    expect(parseClientMessage(j(signal))).toEqual(signal);
    expect(parseClientMessage(j({ t: 'join', code: 'x7k4q', clientId: 'abc', attempt: 7 }))).toBeNull();
    expect(
      parseClientMessage(j({ t: 'signal', data: { kind: 'candidate', candidate: null, conn: 'x'.repeat(33) } })),
    ).toBeNull();
    expect(parseServerMessage(j({ t: 'peer-joined', peerId: 'p', clientId: 'c', attempt: 'a' }))).toEqual({
      t: 'peer-joined',
      peerId: 'p',
      clientId: 'c',
      attempt: 'a',
    });
    expect(parseServerMessage(j({ t: 'peer-joined', peerId: 'p', clientId: 'c', attempt: {} }))).toBeNull();
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
  const file = { id: 0, name: 'a.txt', size: 3, type: '', lastModified: 0 };
  const hash = 'a'.repeat(64);

  it('parses manifests', () => {
    const manifest = { type: 'manifest', version: PROTOCOL_VERSION, files: [file, { ...file, id: 3, name: 'b' }] };
    expect(parseSenderMessage(j(manifest))).toEqual(manifest);
    // An empty share is representable (the UI says so); malformed entries are not.
    expect(parseSenderMessage(j({ ...manifest, files: [] }))).toEqual({ ...manifest, files: [] });
    expect(parseSenderMessage(j({ ...manifest, files: [{ ...file, name: '' }] }))).toBeNull();
    expect(parseSenderMessage(j({ ...manifest, files: [{ ...file, size: -1 }] }))).toBeNull();
    expect(parseSenderMessage(j({ ...manifest, files: [{ ...file, id: undefined }] }))).toBeNull();
    // Ids must be unique.
    expect(parseSenderMessage(j({ ...manifest, files: [file, { ...file, name: 'b' }] }))).toBeNull();
  });

  it('passes another protocol version through, so the receiver can say what went wrong', () => {
    const old = { type: 'manifest', version: 1, files: [{ name: 'a.txt', size: 3, type: '', lastModified: 0 }] };
    expect(parseSenderMessage(j(old))).toEqual({ type: 'manifest', version: 1, files: [] });
  });

  it('parses blocks and file ends', () => {
    const block = { type: 'block', seq: 1, id: 2, offset: 4194304, size: 4194304, sha256: hash };
    expect(parseSenderMessage(j(block))).toEqual(block);
    expect(parseSenderMessage(j({ ...block, sha256: 'A'.repeat(64) }))).toBeNull();
    expect(parseSenderMessage(j({ ...block, sha256: 'abc' }))).toBeNull();
    expect(parseSenderMessage(j({ ...block, size: 0 }))).toBeNull();
    // The receiver allocates `size` bytes, so it's capped.
    expect(parseSenderMessage(j({ ...block, size: MAX_BLOCK_SIZE }))).not.toBeNull();
    expect(parseSenderMessage(j({ ...block, size: MAX_BLOCK_SIZE + 1 }))).toBeNull();
    expect(parseSenderMessage(j({ type: 'file-end', seq: 1, id: 0 }))).toEqual({ type: 'file-end', seq: 1, id: 0 });
    expect(parseSenderMessage(j({ type: 'file-end', seq: 1 }))).toBeNull();
  });

  it('parses receiver messages', () => {
    const request = { type: 'request', seq: 3, files: [0, 2], offset: 4194304, written: 10, total: 99 };
    expect(parseReceiverMessage(j(request))).toEqual(request);
    expect(parseReceiverMessage(j({ ...request, files: [] }))).toBeNull();
    expect(parseReceiverMessage(j({ ...request, files: [-1] }))).toBeNull();
    expect(parseReceiverMessage(j({ ...request, offset: 1.5 }))).toBeNull();
    expect(parseReceiverMessage(j({ ...request, total: undefined }))).toBeNull();
    const ack = { type: 'ack', bytes: 5, written: 4, total: 9 };
    expect(parseReceiverMessage(j(ack))).toEqual(ack);
    expect(parseReceiverMessage(j({ ...ack, bytes: -1 }))).toBeNull();
    expect(parseReceiverMessage(j({ type: 'done' }))).toEqual({ type: 'done' });
    expect(parseReceiverMessage(j({ type: 'cancel' }))).toEqual({ type: 'cancel' });
  });
});
