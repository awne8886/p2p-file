import {
  cryptoRandomInt,
  generateCode,
  normalizeCode,
  parseClientMessage,
  parseServerMessage,
  PROTOCOL_VERSION,
  type ClientMessage,
  type IceServerConfig,
  type ServerMessage,
} from '@pizzadrop/shared';
import { randomId } from './ids';
import type { Signaling, SignalingHandlers } from './signaling';

/**
 * Signaling through a PeerJS server (by default the free public one at
 * 0.peerjs.com), for deployments with no backend of their own, such as GitHub
 * Pages or Cloudflare Pages.
 *
 * A PeerJS server does one thing: it relays small JSON messages between
 * WebSockets registered under ids. This class uses that relay to play the
 * part of the PizzaDrop signaling server, speaking the same
 * {@link ClientMessage} / {@link ServerMessage} protocol to `Host` and
 * `Receiver`:
 *
 * - the sender registers as `pizzadrop-<code>`, choosing a fresh code if that
 *   id is taken;
 * - a receiver registers under a random id and sends `join` to the code's id;
 * - the sender's side keeps the list of receivers and hands out `peer-joined`,
 *   `signal` and `peer-left`, as the server would;
 * - a message to an id nobody holds comes back as `EXPIRE` after ~5 s, which
 *   is how a receiver learns that a code doesn't exist (or no longer does).
 *
 * The PeerJS server sees what our own server would (SDP, ICE candidates, the
 * code), never file names or contents. Unlike our server it can't rate-limit
 * joins, so codes are 6 characters here by default.
 */

const ID_PREFIX = 'pizzadrop-';
/** Official client default; the server drops sockets that stay silent for its `alive_timeout` (60 s). */
const HEARTBEAT_MS = 5_000;
const MAX_PEERS = 32;
const MAX_OUTBOX = 256;
/** How many fresh codes to try if the one we drew is taken. */
const MAX_CODE_ATTEMPTS = 8;

export interface PeerJsOptions {
  /** WebSocket endpoint, e.g. `wss://0.peerjs.com/peerjs`. */
  url: string;
  key: string;
  iceServers: IceServerConfig[];
  publicUrl: string | null;
  codeLength: number;
}

/** PeerJS wire message. `src` is filled in by the server, so it can be trusted. */
interface Wire {
  type: string;
  src?: string;
  dst?: string;
  payload?: unknown;
}

/** Marks relay payloads as ours; anything else arriving on our id is ignored. */
interface Envelope {
  pizzadrop: number;
  msg: unknown;
}

export class PeerJsSignaling implements Signaling {
  iceServers: IceServerConfig[];
  publicUrl: string | null;

  private ws: WebSocket | null = null;
  private registered = false;
  private everRegistered = false;
  private closed = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private readonly token = randomId(16);
  private id: string | null = null;
  private role: 'host' | 'receiver' | null = null;
  /** Messages to relay once the socket is registered: [destination id, message]. */
  private outbox: Array<[string, unknown]> = [];

  // Sender side
  private code: string | null = null;
  private codeAttempts = 0;
  private hostPending = false;
  private readonly peers = new Map<string, string>();

  // Receiver side
  private hostId: string | null = null;

  constructor(
    private readonly handlers: SignalingHandlers,
    private readonly opts: PeerJsOptions,
  ) {
    this.iceServers = opts.iceServers;
    this.publicUrl = opts.publicUrl;
  }

  get isOpen(): boolean {
    return this.registered;
  }

  connect(): void {
    // Nothing to open yet: the id to register under depends on whether we
    // host (the code's id) or join (a random id). That comes with the first send().
    queueMicrotask(() => {
      if (!this.closed) this.handlers.onReady(this.hello());
    });
  }

  send(msg: ClientMessage): boolean {
    if (this.closed) return false;
    switch (msg.t) {
      case 'host':
        this.role = 'host';
        this.hostPending = true;
        if (this.registered) this.announceHosted();
        else if (!this.ws) {
          if (msg.resume) this.code = normalizeCode(msg.resume.code);
          this.open();
        }
        return true;
      case 'join':
        this.role = 'receiver';
        this.hostId = ID_PREFIX + normalizeCode(msg.code);
        this.relay(this.hostId, { t: 'join', code: normalizeCode(msg.code), clientId: msg.clientId });
        return true;
      case 'signal':
        if (this.role === 'host') {
          if (!msg.to || !this.peers.has(msg.to)) return false;
          this.relay(msg.to, { t: 'signal', data: msg.data });
        } else if (this.hostId) {
          this.relay(this.hostId, { t: 'signal', data: msg.data });
        }
        return true;
      case 'close':
        for (const peer of this.peers.keys()) this.relay(peer, { t: 'host-left' });
        this.peers.clear();
        return true;
      case 'leave':
        if (this.hostId) this.relay(this.hostId, { t: 'leave' });
        return true;
    }
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.heartbeat);
    const ws = this.ws;
    this.ws = null;
    this.registered = false;
    // Queued sends (host-left, leave) go out before the close handshake.
    ws?.close();
  }

  // ─── Socket ───────────────────────────────────────────────────────────────

  private open(): void {
    if (this.closed || this.ws) return;
    if (!this.id) {
      if (this.role === 'host') {
        this.code ??= generateCode(cryptoRandomInt, this.opts.codeLength);
        this.id = ID_PREFIX + this.code;
      } else {
        this.id = `${ID_PREFIX}r-${randomId(12)}`;
      }
    }
    const url = new URL(this.opts.url);
    url.searchParams.set('key', this.opts.key);
    url.searchParams.set('id', this.id);
    url.searchParams.set('token', this.token);
    url.searchParams.set('version', '1.5.4');
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onmessage = (ev) => {
      if (this.ws !== ws || typeof ev.data !== 'string') return;
      let wire: Wire;
      try {
        wire = JSON.parse(ev.data) as Wire;
      } catch {
        return;
      }
      if (wire && typeof wire.type === 'string') this.onWire(ws, wire);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.registered = false;
      clearInterval(this.heartbeat);
      if (this.closed) return;
      this.handlers.onDisconnect?.(true);
      const delay = Math.min(10_000, 500 * 2 ** this.attempt++) * (0.75 + Math.random() * 0.5);
      this.retryTimer = setTimeout(() => this.open(), delay);
    };
  }

  private onWire(ws: WebSocket, wire: Wire): void {
    switch (wire.type) {
      case 'OPEN':
        return this.onRegistered(ws);
      case 'ID-TAKEN':
        return this.onIdTaken(ws);
      case 'ERROR':
        return this.onServerError(ws, wire);
      case 'EXPIRE':
      case 'LEAVE':
        // Our message couldn't be delivered to `src`, or `src` vanished.
        if (wire.src) this.onUnreachable(wire.src);
        return;
      case 'OFFER':
      case 'ANSWER':
      case 'CANDIDATE': {
        const env = wire.payload as Envelope | undefined;
        if (!wire.src || !env || env.pizzadrop !== 1) return;
        if (this.role === 'host') this.onFromReceiver(wire.src, env.msg);
        else if (wire.src === this.hostId) this.onFromHost(env.msg);
        return;
      }
      default:
        return;
    }
  }

  private onRegistered(ws: WebSocket): void {
    const reconnect = this.everRegistered;
    this.registered = true;
    this.everRegistered = true;
    this.attempt = 0;
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'HEARTBEAT' }));
    }, HEARTBEAT_MS);
    const outbox = this.outbox;
    this.outbox = [];
    for (const [dst, msg] of outbox) this.relay(dst, msg);
    if (this.role === 'host' && this.hostPending) this.announceHosted();
    // After a dropped socket, let Host / Receiver re-drive (re-host with resume, re-join if needed).
    if (reconnect) this.handlers.onReady(this.hello());
  }

  private onIdTaken(ws: WebSocket): void {
    ws.onclose = null;
    ws.close();
    this.ws = null;
    if (this.role === 'host' && !this.everRegistered && ++this.codeAttempts < MAX_CODE_ATTEMPTS) {
      // Someone else holds this code: draw another.
      this.code = generateCode(cryptoRandomInt, this.opts.codeLength);
      this.id = ID_PREFIX + this.code;
      this.open();
      return;
    }
    if (this.role === 'host' && this.everRegistered) {
      // Our code went to someone else while we were disconnected.
      this.closed = true;
      this.handlers.onMessage({ t: 'expired' });
      return;
    }
    this.fatal('Could not register with the signaling server.');
  }

  private onServerError(ws: WebSocket, wire: Wire): void {
    const detail = (wire.payload as { msg?: unknown } | undefined)?.msg;
    if (this.everRegistered) return; // transient; the socket will close and reconnect
    ws.onclose = null;
    ws.close();
    this.ws = null;
    this.fatal(`The signaling server refused the connection${typeof detail === 'string' ? `: ${detail}` : '.'}`);
  }

  private fatal(message: string): void {
    this.closed = true;
    this.handlers.onMessage({ t: 'error', code: 'server-error', message });
  }

  private hello(): Extract<ServerMessage, { t: 'hello' }> {
    return { t: 'hello', version: PROTOCOL_VERSION, iceServers: this.iceServers, publicUrl: this.publicUrl };
  }

  private announceHosted(): void {
    this.hostPending = false;
    this.handlers.onMessage({
      t: 'hosted',
      code: this.code!,
      token: this.token,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      peers: [...this.peers].map(([peerId, clientId]) => ({ peerId, clientId })),
    });
  }

  /** Send one of our messages to `dst` through the relay, queueing it until the socket is registered. */
  private relay(dst: string, msg: unknown): void {
    if (!this.registered || this.ws?.readyState !== WebSocket.OPEN) {
      if (this.outbox.length < MAX_OUTBOX) this.outbox.push([dst, msg]);
      if (!this.ws && this.role) this.open();
      return;
    }
    const envelope: Envelope = { pizzadrop: 1, msg };
    this.ws.send(JSON.stringify({ type: 'OFFER', dst, payload: envelope }));
  }

  // ─── Sender side: act as the room ─────────────────────────────────────────

  private onFromReceiver(src: string, raw: unknown): void {
    const msg = parseClientMessage(JSON.stringify(raw));
    if (!msg) return;
    switch (msg.t) {
      case 'join':
        if (normalizeCode(msg.code) !== this.code) return;
        if (!this.peers.has(src) && this.peers.size >= MAX_PEERS) {
          this.relay(src, { t: 'error', code: 'room-full', message: 'Too many people are downloading right now.' });
          return;
        }
        this.peers.set(src, msg.clientId);
        this.handlers.onMessage({ t: 'peer-joined', peerId: src, clientId: msg.clientId });
        return;
      case 'signal':
        if (this.peers.has(src)) this.handlers.onMessage({ t: 'signal', from: src, data: msg.data });
        return;
      case 'leave':
        this.onUnreachable(src);
        return;
      default:
        return;
    }
  }

  // ─── Receiver side ────────────────────────────────────────────────────────

  private onFromHost(raw: unknown): void {
    const msg = parseServerMessage(JSON.stringify(raw));
    if (!msg) return;
    if (msg.t === 'signal') this.handlers.onMessage({ t: 'signal', data: msg.data });
    else if (msg.t === 'host-left' || msg.t === 'error') this.handlers.onMessage(msg);
  }

  private onUnreachable(src: string): void {
    if (this.role === 'host') {
      if (this.peers.delete(src)) this.handlers.onMessage({ t: 'peer-left', peerId: src });
    } else if (src === this.hostId) {
      this.handlers.onMessage({ t: 'error', code: 'not-found', message: 'This link has expired or never existed.' });
    }
  }
}
