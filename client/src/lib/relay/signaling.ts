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
import { randomId } from '../ids';
import type { Signaling, SignalingHandlers } from '../signaling';
import {
  createHostSigner,
  deriveRoomKeys,
  seal,
  unseal,
  verifyHost,
  wireId,
  type HostSigner,
  type RoomKeys,
} from './crypto';
import type { Relay, RelayHandlers } from './relay';

/**
 * Signaling with no server of our own, for static hosting (GitHub Pages, Cloudflare Pages).
 *
 * The sender's page plays the part of PizzaDrop's signaling server, speaking the same {@link ClientMessage} /
 * {@link ServerMessage} protocol to `Host` and `Receiver`, over any number of public relays at once (a PeerJS
 * server and a handful of Nostr relays by default). Every message goes out on every relay that's up, and the first
 * copy to arrive wins, so one relay being slow, down, or dropping connections costs nothing.
 *
 * Messages are sealed with a key derived from the share code (see `crypto.ts`): relays see a room name, never the
 * code, the session descriptions, or anyone's IP address, and can't forge or alter a message. The sender also signs
 * its messages, so someone else with the link can't pose as the sender.
 */

const HOST = 'host';
/** A message is also sent on relays that come up within this long after it was first sent. */
const RESEND_WINDOW_MS = 15_000;
/** Older (or this far in the future, for skewed clocks) is a replay. */
const MAX_AGE_MS = 10 * 60_000;
/** How long a new share waits for PeerJS to confirm that its code is free before showing the link anyway. */
const ANNOUNCE_WAIT_MS = 1_500;
/** A sender that can't reach any relay for this long says so (it keeps trying). */
const HOST_TIMEOUT_MS = 20_000;
const MAX_CODE_ATTEMPTS = 8;
const MAX_BATCH = 16;
const MAX_PEERS = 256;
const SEEN_MAX = 2000;
const ADDRESS_RE = /^[0-9a-f]{16}$/;

interface Envelope {
  v: 1;
  from: string;
  to: string;
  at: number;
  msgs: unknown[];
}

/** What gets sealed: the envelope as JSON, plus the sender's key and signature over exactly that JSON. */
interface Sealed {
  e: string;
  hk?: string;
  sig?: string;
}

export interface RelaySignalingOptions {
  /** Creates the relays to use (called again if the sender has to pick another code). */
  relays(handlers: RelayHandlers): Relay[];
  iceServers: IceServerConfig[];
  publicUrl: string | null;
  codeLength: number;
  /** Tests use fewer PBKDF2 rounds. */
  deriveKeys?(code: string): Promise<RoomKeys>;
}

export class RelaySignaling implements Signaling {
  iceServers: IceServerConfig[];
  iceReady: Promise<void> = Promise.resolve();
  readonly reliable = false;
  publicUrl: string | null;

  private relays: Relay[] = [];
  private keys: Promise<RoomKeys> | null = null;
  /** Our address: `host`, or a random id for a receiver. */
  private self: string | null = null;
  private role: 'host' | 'receiver' | null = null;
  private code: string | null = null;
  private closed = false;
  private open = false;
  private outage = false;
  private failedReported = false;
  /** Reconnect dropped relays straight away when the page comes back to the foreground or the network returns. */
  private readonly kick = () => {
    if (document.visibilityState !== 'hidden') for (const r of this.relays) r.kick();
  };
  private readonly browser = typeof window !== 'undefined' && typeof document !== 'undefined';

  // Outgoing: batched per destination, sealed in order.
  private readonly queue = new Map<string, unknown[]>();
  private flushScheduled = false;
  private sending: Promise<void> = Promise.resolve();
  private recent: Array<{ to: string; wire: string; at: number; sentOn: Set<Relay> }> = [];

  // Incoming: deduplicated, opened in arrival order.
  private readonly seen = new Set<string>();
  private receiving: Promise<void> = Promise.resolve();

  // Sender side: act as the room.
  private hostPending = false;
  private announced = false;
  private codeAttempts = 0;
  private startedAt = 0;
  private hostTimer: ReturnType<typeof setTimeout> | undefined;
  private announceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly token = randomId(16);
  private readonly peers = new Map<string, string>();
  private signer: Promise<HostSigner> | null = null;

  // Receiver side: the sender's signing key, pinned on first contact.
  private hostKey: string | null = null;
  private impostorReported = false;

  constructor(
    private readonly handlers: SignalingHandlers,
    private readonly opts: RelaySignalingOptions,
  ) {
    this.iceServers = opts.iceServers;
    this.publicUrl = opts.publicUrl;
  }

  get isOpen(): boolean {
    return this.relays.some((r) => r.state === 'ready');
  }

  connect(): void {
    // Which relays to connect as depends on whether we host or join: that comes with the first send().
    if (this.browser) {
      window.addEventListener('online', this.kick);
      document.addEventListener('visibilitychange', this.kick);
    }
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
        if (!this.self) this.startHosting(msg.resume ? normalizeCode(msg.resume.code) : null);
        else this.maybeAnnounce();
        return true;
      case 'join':
        this.role = 'receiver';
        if (!this.self) {
          this.self = randomId(8);
          this.code = normalizeCode(msg.code);
          this.startRelays();
        }
        this.enqueue(HOST, {
          t: 'join',
          code: this.code,
          clientId: msg.clientId,
          ...(msg.attempt ? { attempt: msg.attempt } : {}),
        });
        return true;
      case 'signal':
        if (this.role === 'host') {
          if (!msg.to || !this.peers.has(msg.to)) return false;
          this.enqueue(msg.to, { t: 'signal', data: msg.data });
        } else {
          this.enqueue(HOST, { t: 'signal', data: msg.data });
        }
        return true;
      case 'close':
        for (const peer of this.peers.keys()) this.enqueue(peer, { t: 'host-left' });
        this.peers.clear();
        return true;
      case 'leave':
        if (this.role === 'receiver') this.enqueue(HOST, { t: 'leave' });
        return true;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.browser) {
      window.removeEventListener('online', this.kick);
      document.removeEventListener('visibilitychange', this.kick);
    }
    clearTimeout(this.hostTimer);
    clearTimeout(this.announceTimer);
    // Let the last messages (host-left, leave) go out before the sockets close.
    this.flush();
    const relays = this.relays;
    let done = false;
    const shut = () => {
      if (done) return;
      done = true;
      for (const r of relays) r.close();
    };
    void this.sending.then(shut, shut);
    setTimeout(shut, 1000);
  }

  // ─── Relays ───────────────────────────────────────────────────────────────

  private startHosting(code: string | null): void {
    this.self = HOST;
    this.signer = createHostSigner();
    this.signer.catch((err: unknown) => this.fatal(err instanceof Error ? err.message : String(err)));
    this.code = code ?? generateCode(cryptoRandomInt, this.opts.codeLength);
    this.startRelays();
    clearTimeout(this.hostTimer);
    this.hostTimer = setTimeout(() => {
      if (!this.announced) {
        this.handlers.onMessage({
          t: 'error',
          code: 'server-error',
          message: 'Couldn’t reach any of the signaling relays. Check your connection; still trying…',
        });
      }
    }, HOST_TIMEOUT_MS);
  }

  private startRelays(): void {
    const derive = this.opts.deriveKeys ?? deriveRoomKeys;
    const keys = derive(this.code!);
    this.keys = keys;
    keys.catch((err: unknown) => this.fatal(err instanceof Error ? err.message : String(err)));
    const handlers: RelayHandlers = {
      onData: (wire) => this.receive(wire),
      onState: () => this.onRelayState(),
      onAddressTaken: () => this.onAddressTaken(),
    };
    this.relays = this.opts.relays(handlers);
    this.startedAt = Date.now();
    const room = keys.then((k) => k.room);
    for (const r of this.relays) r.start(this.self!, room);
    if (this.role === 'host') {
      clearTimeout(this.announceTimer);
      this.announceTimer = setTimeout(() => this.maybeAnnounce(), ANNOUNCE_WAIT_MS);
    }
    if (this.relays.length === 0) this.fatal('No signaling relays are configured.');
  }

  private onRelayState(): void {
    if (this.closed) return;
    if (this.isOpen) {
      this.resendRecent();
      if (!this.open) {
        this.open = true;
        // Back after every relay was down: let Host / Receiver re-drive (re-announce, re-join if needed).
        if (this.outage) this.handlers.onReady(this.hello());
      }
      this.maybeAnnounce();
      return;
    }
    if (this.open) {
      this.open = false;
      this.outage = true;
      this.handlers.onDisconnect?.(true);
    }
    if (this.relays.length > 0 && this.relays.every((r) => r.state === 'failed')) {
      this.fatal('None of the signaling relays would accept the connection.');
    }
  }

  /** PeerJS says our code is taken: before the link is shown, pick another code. */
  private onAddressTaken(): void {
    if (this.role !== 'host' || this.announced) return;
    if (++this.codeAttempts >= MAX_CODE_ATTEMPTS) {
      this.fatal('Could not register a share code with the signaling server.');
      return;
    }
    for (const r of this.relays) r.close();
    this.code = generateCode(cryptoRandomInt, this.opts.codeLength);
    this.startRelays();
  }

  private maybeAnnounce(): void {
    if (this.role !== 'host' || !this.hostPending || !this.isOpen || this.closed) return;
    if (!this.announced) {
      // PeerJS is the one relay that can tell us a code is already in use: give it a moment to answer.
      const peerjs = this.relays.find((r) => r.name === 'peerjs');
      const settled = !peerjs || peerjs.state === 'ready' || peerjs.state === 'failed';
      if (!settled && Date.now() - this.startedAt < ANNOUNCE_WAIT_MS) return;
    }
    this.announced = true;
    this.hostPending = false;
    clearTimeout(this.hostTimer);
    this.handlers.onMessage({
      t: 'hosted',
      code: this.code!,
      token: this.token,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      peers: [...this.peers].map(([peerId, clientId]) => ({ peerId, clientId })),
    });
  }

  private fatal(message: string): void {
    if (this.failedReported || this.closed) return;
    this.failedReported = true;
    this.handlers.onMessage({ t: 'error', code: 'server-error', message });
  }

  // ─── Sending ──────────────────────────────────────────────────────────────

  /**
   * Queue `msg` for `to`. Everything queued in the same task goes out as one sealed envelope: fewer relay
   * messages (some relays rate-limit), and no timer involved, so a sender in a background tab answers at once.
   */
  private enqueue(to: string, msg: unknown): void {
    let q = this.queue.get(to);
    if (!q) this.queue.set(to, (q = []));
    q.push(msg);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    this.flushScheduled = false;
    const keys = this.keys;
    if (!keys || this.queue.size === 0) return;
    const batches = [...this.queue];
    this.queue.clear();
    for (const [to, msgs] of batches) {
      for (let i = 0; i < msgs.length; i += MAX_BATCH) {
        const envelope: Envelope = { v: 1, from: this.self!, to, at: Date.now(), msgs: msgs.slice(i, i + MAX_BATCH) };
        const sealed = this.sealEnvelope(keys, this.signer, JSON.stringify(envelope));
        this.sending = this.sending
          .then(async () => this.deliver(to, await sealed))
          .catch((err: unknown) => console.warn('[signaling] could not send', err));
      }
    }
  }

  private async sealEnvelope(keys: Promise<RoomKeys>, signer: Promise<HostSigner> | null, e: string): Promise<string> {
    const outer: Sealed = { e };
    if (signer) {
      const s = await signer;
      outer.hk = s.publicKey;
      outer.sig = await s.sign(e);
    }
    return seal(await keys, JSON.stringify(outer));
  }

  private deliver(to: string, wire: string): void {
    const now = Date.now();
    this.recent = this.recent.filter((r) => now - r.at < RESEND_WINDOW_MS);
    const record = { to, wire, at: now, sentOn: new Set<Relay>() };
    this.recent.push(record);
    for (const r of this.relays) if (r.state === 'ready' && r.send(to, wire)) record.sentOn.add(r);
  }

  /** Relays that just came up also get the recent messages the others already carried. */
  private resendRecent(): void {
    const now = Date.now();
    this.recent = this.recent.filter((r) => now - r.at < RESEND_WINDOW_MS);
    for (const record of this.recent) {
      for (const r of this.relays) {
        if (r.state === 'ready' && !record.sentOn.has(r) && r.send(record.to, record.wire)) record.sentOn.add(r);
      }
    }
  }

  // ─── Receiving ────────────────────────────────────────────────────────────

  private receive(wire: string): void {
    const keys = this.keys;
    if (!keys || this.closed || typeof wire !== 'string' || wire.length > 256 * 1024) return;
    const id = wireId(wire);
    if (this.seen.has(id)) return;
    this.seen.add(id);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value!);
    this.receiving = this.receiving
      .then(async () => {
        const text = await unseal(await keys, wire);
        if (text === null || this.closed || this.keys !== keys) return;
        const outer = parseSealed(text);
        const env = outer && parseEnvelope(outer.e);
        if (!outer || !env || env.to !== this.self || env.from === this.self) return;
        if (Math.abs(Date.now() - env.at) > MAX_AGE_MS) return;
        if (this.role === 'host') {
          for (const m of env.msgs) this.fromReceiver(env.from, m);
        } else if (env.from === HOST && (await this.fromTheSender(outer))) {
          for (const m of env.msgs) this.fromHost(m);
        }
      })
      .catch((err: unknown) => console.warn('[signaling] could not handle a message', err));
  }

  private fromReceiver(from: string, raw: unknown): void {
    if (!ADDRESS_RE.test(from)) return;
    const msg = parseClientMessage(JSON.stringify(raw));
    if (!msg) return;
    switch (msg.t) {
      case 'join':
        if (normalizeCode(msg.code) !== this.code) return;
        this.peers.delete(from); // re-insert: the map is kept in order of last contact
        this.peers.set(from, msg.clientId);
        if (this.peers.size > MAX_PEERS) this.peers.delete(this.peers.keys().next().value!);
        this.enqueue(from, { t: 'joined', peerId: from });
        this.handlers.onMessage({
          t: 'peer-joined',
          peerId: from,
          clientId: msg.clientId,
          ...(msg.attempt ? { attempt: msg.attempt } : {}),
        });
        return;
      case 'signal':
        if (this.peers.has(from)) this.handlers.onMessage({ t: 'signal', from, data: msg.data });
        return;
      case 'leave':
        if (this.peers.delete(from)) this.handlers.onMessage({ t: 'peer-left', peerId: from });
        return;
      default:
        return;
    }
  }

  /**
   * True if the sender signed this, with the key we heard from first. A second, different key answering for the
   * same code means someone else with the link is posing as the sender: stop, rather than risk taking files from it.
   */
  private async fromTheSender(outer: Sealed): Promise<boolean> {
    if (!outer.hk || !outer.sig || !(await verifyHost(outer.hk, outer.e, outer.sig))) return false;
    this.hostKey ??= outer.hk;
    if (outer.hk === this.hostKey) return true;
    if (!this.impostorReported) {
      this.impostorReported = true;
      this.handlers.onMessage({
        t: 'error',
        code: 'server-error',
        message:
          'Two different senders answered this link, so someone else who has it may be posing as the sender. Nothing was downloaded. Ask the sender for a new link.',
      });
    }
    return false;
  }

  private fromHost(raw: unknown): void {
    const msg = parseServerMessage(JSON.stringify(raw));
    if (!msg) return;
    if (msg.t === 'signal' || msg.t === 'joined' || msg.t === 'host-left' || msg.t === 'error') {
      this.handlers.onMessage(msg);
    }
  }

  private hello(): Extract<ServerMessage, { t: 'hello' }> {
    return { t: 'hello', version: PROTOCOL_VERSION, iceServers: this.iceServers, publicUrl: this.publicUrl };
  }
}

function parseSealed(text: string): Sealed | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Partial<Sealed>;
  if (typeof o.e !== 'string') return null;
  if ((o.hk !== undefined && typeof o.hk !== 'string') || (o.sig !== undefined && typeof o.sig !== 'string'))
    return null;
  return o as Sealed;
}

function parseEnvelope(text: string): Envelope | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const e = v as Partial<Envelope>;
  return e.v === 1 &&
    typeof e.from === 'string' &&
    e.from.length <= 64 &&
    typeof e.to === 'string' &&
    typeof e.at === 'number' &&
    Array.isArray(e.msgs) &&
    e.msgs.length <= MAX_BATCH
    ? (e as Envelope)
    : null;
}
