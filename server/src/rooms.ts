import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import {
  generateUniqueCode,
  isValidCode,
  normalizeCode,
  type ClientMessage,
  type ErrorCode,
  type PeerInfo,
  type RandomInt,
  type ServerMessage,
} from '@pizzadrop/shared';

/** Anything we can push a message to — a WebSocket in production, a stub in tests. */
export interface Conn {
  readonly id: string;
  send(msg: ServerMessage): void;
}

export interface RoomOptions {
  codeLength: number;
  roomIdleTtlMs: number;
  hostGraceMs: number;
  maxPeersPerRoom: number;
  now?: () => number;
  randomInt?: RandomInt;
}

interface Peer {
  conn: Conn;
  clientId: string;
}

interface Room {
  code: string;
  token: string;
  host: Conn | null;
  /** When the host's socket dropped without a clean close; `null` while connected. */
  hostGoneAt: number | null;
  peers: Map<string, Peer>;
  lastActivity: number;
}

type Membership = { room: Room; role: 'host' } | { room: Room; role: 'peer'; peerId: string };

/**
 * All signaling state. Pure logic — no sockets, no timers — so it can be unit
 * tested; the WebSocket layer calls {@link handle}, {@link disconnect} and
 * {@link sweep}.
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly members = new Map<string, Membership>();
  private readonly now: () => number;
  private readonly randomInt: RandomInt;

  constructor(private readonly opts: RoomOptions) {
    this.now = opts.now ?? Date.now;
    this.randomInt = opts.randomInt ?? ((max) => randomInt(max));
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  get peerCount(): number {
    let n = 0;
    for (const r of this.rooms.values()) n += r.peers.size;
    return n;
  }

  handle(conn: Conn, msg: ClientMessage): void {
    switch (msg.t) {
      case 'host':
        return this.host(conn, msg.resume);
      case 'join':
        return this.join(conn, msg.code, msg.clientId);
      case 'signal':
        return this.signal(conn, msg);
      case 'close':
        return this.closeRoom(conn);
      case 'leave':
        return this.leave(conn);
    }
  }

  /** Socket closed (tab closed, network loss…). */
  disconnect(conn: Conn): void {
    const m = this.members.get(conn.id);
    if (!m) return;
    this.members.delete(conn.id);
    if (m.role === 'peer') {
      this.removePeer(m.room, m.peerId);
      return;
    }
    const room = m.room;
    if (room.host !== conn) return;
    room.host = null;
    if (this.opts.hostGraceMs <= 0) {
      this.destroy(room);
    } else {
      room.hostGoneAt = this.now();
    }
  }

  /** Expire idle rooms and rooms whose host never came back. Call periodically. */
  sweep(): void {
    const t = this.now();
    for (const room of [...this.rooms.values()]) {
      if (room.hostGoneAt !== null && t - room.hostGoneAt >= this.opts.hostGraceMs) {
        this.destroy(room);
      } else if (t - room.lastActivity >= this.opts.roomIdleTtlMs) {
        room.host?.send({ t: 'expired' });
        this.destroy(room);
      }
    }
  }

  // ─── Handlers ────────────────────────────────────────────────────────────

  private host(conn: Conn, resume?: { code: string; token: string }): void {
    const existing = this.members.get(conn.id);
    if (existing?.role === 'host') {
      return this.error(conn, 'already-hosting', 'This connection is already hosting a code.');
    }
    if (existing) this.leave(conn);

    if (resume) {
      const room = this.rooms.get(normalizeCode(resume.code));
      if (room && room.host === null && safeEqual(room.token, resume.token)) {
        room.host = conn;
        room.hostGoneAt = null;
        this.touch(room);
        this.members.set(conn.id, { room, role: 'host' });
        this.sendHosted(conn, room);
        return;
      }
      // Fall through: the old code is gone, so issue a fresh one. The client
      // notices the code changed and updates the link it shows.
    }

    const code = generateUniqueCode(this.randomInt, (c) => this.rooms.has(c), this.opts.codeLength);
    const room: Room = {
      code,
      token: randomBytes(24).toString('hex'),
      host: conn,
      hostGoneAt: null,
      peers: new Map(),
      lastActivity: this.now(),
    };
    this.rooms.set(code, room);
    this.members.set(conn.id, { room, role: 'host' });
    this.sendHosted(conn, room);
  }

  private join(conn: Conn, rawCode: string, clientId: string): void {
    const existing = this.members.get(conn.id);
    if (existing?.role === 'host') {
      return this.error(conn, 'bad-request', 'A hosting connection cannot join another code.');
    }
    if (existing) this.leave(conn);

    const code = normalizeCode(rawCode);
    const room = isValidCode(code) ? this.rooms.get(code) : undefined;
    if (!room) return this.error(conn, 'not-found', 'This link has expired or never existed.');
    if (room.peers.size >= this.opts.maxPeersPerRoom) {
      return this.error(conn, 'room-full', 'Too many people are downloading this right now. Try again shortly.');
    }

    const peerId = randomBytes(8).toString('hex');
    room.peers.set(peerId, { conn, clientId });
    this.members.set(conn.id, { room, role: 'peer', peerId });
    this.touch(room);
    conn.send({ t: 'joined', peerId });
    // While the host is reconnecting (grace period) the peer waits; the host
    // learns about it from the `peers` list in its next `hosted` message.
    room.host?.send({ t: 'peer-joined', peerId, clientId });
  }

  private signal(conn: Conn, msg: Extract<ClientMessage, { t: 'signal' }>): void {
    const m = this.members.get(conn.id);
    if (!m) return this.error(conn, 'not-in-room', 'Join or host a code first.');
    const { room } = m;
    this.touch(room);

    if (m.role === 'host') {
      if (!msg.to) return this.error(conn, 'bad-request', 'Signals from the sender need a `to` peer id.');
      const peer = room.peers.get(msg.to);
      if (!peer) return this.error(conn, 'unknown-peer', 'That receiver has left.');
      peer.conn.send({ t: 'signal', data: msg.data });
    } else {
      // Dropped silently while the host is reconnecting; the receiver retries.
      room.host?.send({ t: 'signal', from: m.peerId, data: msg.data });
    }
  }

  private closeRoom(conn: Conn): void {
    const m = this.members.get(conn.id);
    if (m?.role !== 'host') return;
    this.destroy(m.room);
  }

  private leave(conn: Conn): void {
    const m = this.members.get(conn.id);
    if (m?.role !== 'peer') return;
    this.members.delete(conn.id);
    this.removePeer(m.room, m.peerId);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private removePeer(room: Room, peerId: string): void {
    if (!room.peers.delete(peerId)) return;
    room.host?.send({ t: 'peer-left', peerId });
  }

  private destroy(room: Room): void {
    if (this.rooms.get(room.code) !== room) return;
    this.rooms.delete(room.code);
    for (const [, peer] of room.peers) {
      this.members.delete(peer.conn.id);
      peer.conn.send({ t: 'host-left' });
    }
    room.peers.clear();
    if (room.host) this.members.delete(room.host.id);
    room.host = null;
  }

  private touch(room: Room): void {
    room.lastActivity = this.now();
  }

  private sendHosted(conn: Conn, room: Room): void {
    const peers: PeerInfo[] = [...room.peers].map(([peerId, p]) => ({ peerId, clientId: p.clientId }));
    conn.send({
      t: 'hosted',
      code: room.code,
      token: room.token,
      expiresAt: room.lastActivity + this.opts.roomIdleTtlMs,
      peers,
    });
  }

  private error(conn: Conn, code: ErrorCode, message: string): void {
    conn.send({ t: 'error', code, message });
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
