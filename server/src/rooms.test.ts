import type { ServerMessage } from '@pizzadrop/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { RoomManager, type Conn } from './rooms.js';

class FakeConn implements Conn {
  inbox: ServerMessage[] = [];
  constructor(readonly id: string) {}
  send(msg: ServerMessage) {
    this.inbox.push(msg);
  }
  last<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }> | undefined {
    return [...this.inbox].reverse().find((m) => m.t === t) as Extract<ServerMessage, { t: T }> | undefined;
  }
}

const offer = { kind: 'description' as const, description: { type: 'offer' as const, sdp: 'v=0' } };
const answer = { kind: 'description' as const, description: { type: 'answer' as const, sdp: 'v=0' } };

describe('RoomManager', () => {
  let now: number;
  let rooms: RoomManager;
  let n = 0;
  const conn = () => new FakeConn(`c${++n}`);

  beforeEach(() => {
    now = 1_000_000;
    rooms = new RoomManager({
      codeLength: 5,
      roomIdleTtlMs: 60_000,
      hostGraceMs: 10_000,
      maxPeersPerRoom: 2,
      now: () => now,
    });
  });

  function host() {
    const h = conn();
    rooms.handle(h, { t: 'host' });
    const hosted = h.last('hosted')!;
    return { h, code: hosted.code, token: hosted.token };
  }

  it('issues a short code', () => {
    const { code } = host();
    expect(code).toMatch(/^[23456789a-hjkmnp-z]{5}$/);
    expect(rooms.roomCount).toBe(1);
  });

  it('introduces receivers and relays signaling both ways', () => {
    const { h, code } = host();
    const r = conn();
    rooms.handle(r, { t: 'join', code: code.toUpperCase(), clientId: 'tab-1' });
    const joined = r.last('joined')!;
    const pj = h.last('peer-joined')!;
    expect(pj).toEqual({ t: 'peer-joined', peerId: joined.peerId, clientId: 'tab-1' });

    rooms.handle(h, { t: 'signal', to: joined.peerId, data: offer });
    expect(r.last('signal')).toEqual({ t: 'signal', data: offer });

    rooms.handle(r, { t: 'signal', data: answer });
    expect(h.last('signal')).toEqual({ t: 'signal', from: joined.peerId, data: answer });
  });

  it('keeps receivers isolated from each other', () => {
    const { h, code } = host();
    const r1 = conn();
    const r2 = conn();
    rooms.handle(r1, { t: 'join', code, clientId: 'a' });
    rooms.handle(r2, { t: 'join', code, clientId: 'b' });
    rooms.handle(h, { t: 'signal', to: r1.last('joined')!.peerId, data: offer });
    expect(r1.last('signal')).toBeDefined();
    expect(r2.last('signal')).toBeUndefined();
  });

  it('rejects unknown codes and full rooms', () => {
    const r = conn();
    rooms.handle(r, { t: 'join', code: 'zzzzz', clientId: 'a' });
    expect(r.last('error')?.code).toBe('not-found');

    const { code } = host();
    rooms.handle(conn(), { t: 'join', code, clientId: 'a' });
    rooms.handle(conn(), { t: 'join', code, clientId: 'b' });
    const third = conn();
    rooms.handle(third, { t: 'join', code, clientId: 'c' });
    expect(third.last('error')?.code).toBe('room-full');
  });

  it('tells the host when a receiver leaves', () => {
    const { h, code } = host();
    const r = conn();
    rooms.handle(r, { t: 'join', code, clientId: 'a' });
    const { peerId } = r.last('joined')!;
    rooms.disconnect(r);
    expect(h.last('peer-left')).toEqual({ t: 'peer-left', peerId });
    expect(rooms.peerCount).toBe(0);
  });

  it('releases the code immediately when the sender stops sharing', () => {
    const { h, code } = host();
    const r = conn();
    rooms.handle(r, { t: 'join', code, clientId: 'a' });
    rooms.handle(h, { t: 'close' });
    expect(r.last('host-left')).toBeDefined();
    expect(rooms.roomCount).toBe(0);
  });

  it('keeps the code through a short sender disconnect and lets it resume with its token', () => {
    const { h, code, token } = host();
    rooms.disconnect(h);
    now += 5_000;
    rooms.sweep();
    expect(rooms.roomCount).toBe(1);

    const r = conn();
    rooms.handle(r, { t: 'join', code, clientId: 'a' });
    expect(r.last('joined')).toBeDefined();

    const h2 = conn();
    rooms.handle(h2, { t: 'host', resume: { code, token } });
    const hosted = h2.last('hosted')!;
    expect(hosted.code).toBe(code);
    expect(hosted.peers).toEqual([{ peerId: r.last('joined')!.peerId, clientId: 'a' }]);
  });

  it('refuses a resume with the wrong token and issues a fresh code instead', () => {
    const { h, code } = host();
    rooms.disconnect(h);
    const h2 = conn();
    rooms.handle(h2, { t: 'host', resume: { code, token: 'wrong' } });
    expect(h2.last('hosted')!.code).not.toBe(code);
  });

  it('expires the code when the sender does not come back within the grace period', () => {
    const { h, code } = host();
    const r = conn();
    rooms.handle(r, { t: 'join', code, clientId: 'a' });
    rooms.disconnect(h);
    now += 10_000;
    rooms.sweep();
    expect(rooms.roomCount).toBe(0);
    expect(r.last('host-left')).toBeDefined();
  });

  it('expires idle codes after the TTL and tells the sender', () => {
    const { h } = host();
    now += 59_000;
    rooms.sweep();
    expect(rooms.roomCount).toBe(1);
    now += 1_000;
    rooms.sweep();
    expect(rooms.roomCount).toBe(0);
    expect(h.last('expired')).toBeDefined();
  });

  it('activity resets the idle TTL', () => {
    const { code } = host();
    now += 50_000;
    rooms.handle(conn(), { t: 'join', code, clientId: 'a' });
    now += 50_000;
    rooms.sweep();
    expect(rooms.roomCount).toBe(1);
  });

  it('requires a target for sender signals and membership for any signal', () => {
    const { h } = host();
    rooms.handle(h, { t: 'signal', data: offer });
    expect(h.last('error')?.code).toBe('bad-request');
    const stranger = conn();
    rooms.handle(stranger, { t: 'signal', data: offer });
    expect(stranger.last('error')?.code).toBe('not-in-room');
  });
});
