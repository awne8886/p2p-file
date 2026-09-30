import {
  isIceServer,
  parseServerMessage,
  SIGNAL_PATH,
  type ClientMessage,
  type IceServerConfig,
  type ServerMessage,
} from '@pizzadrop/shared';
import { DEFAULT_NOSTR_RELAYS, NostrRelays } from './relay/nostr';
import { PeerJsRelay } from './relay/peerjs';
import type { Relay, RelayHandlers } from './relay/relay';
import { RelaySignaling } from './relay/signaling';

export interface SignalingHandlers {
  /** Connected (or reconnected) and ready for `host` / `join`. */
  onReady(hello: Extract<ServerMessage, { t: 'hello' }>): void;
  onMessage(msg: ServerMessage): void;
  /** Connection lost; `retrying` tells whether a reconnect is scheduled. */
  onDisconnect?(retrying: boolean): void;
}

/**
 * How the sender and receivers find each other. Only signaling goes through
 * here — once peers are connected, file bytes flow directly between browsers.
 */
export interface Signaling {
  iceServers: IceServerConfig[];
  /** Settles once `iceServers` is final (TURN credentials may be fetched at startup). Never rejects. */
  readonly iceReady: Promise<void>;
  /** Canonical origin for share links, if the deployment sets one. */
  publicUrl: string | null;
  readonly isOpen: boolean;
  /** Messages sent while open arrive (our own server). Public relays can lose them, so callers repeat. */
  readonly reliable: boolean;
  connect(): void;
  send(msg: ClientMessage): boolean;
  /** Close for good (no reconnect). */
  close(): void;
}

const env = import.meta.env;

/** The transport this build was configured with (see `client/.env.static` and README → Static hosting). */
export function createSignaling(handlers: SignalingHandlers): Signaling {
  if (env.VITE_SIGNALING === 'relays' || env.VITE_SIGNALING === 'peerjs') {
    const signaling = new RelaySignaling(handlers, {
      relays: relaysFromEnv,
      iceServers: iceServersFromEnv(),
      publicUrl: publicUrlFromEnv(),
      codeLength: env.VITE_CODE_LENGTH === '5' ? 5 : 6,
    });
    const url = env.VITE_ICE_SERVERS_URL?.trim();
    if (url) {
      signaling.iceReady = fetchIceServers(url).then((extra) => {
        signaling.iceServers = [...signaling.iceServers, ...extra];
      });
    }
    return signaling;
  }
  return new SignalingClient(handlers, env.VITE_SIGNAL_URL || signalingUrl());
}

/** A PeerJS server and a handful of Nostr relays, all at once (see `relay/signaling.ts`). */
function relaysFromEnv(handlers: RelayHandlers): Relay[] {
  const relays: Relay[] = [];
  const peerjs = setting(env.VITE_PEERJS_URL, 'wss://0.peerjs.com/peerjs');
  if (peerjs) relays.push(new PeerJsRelay(handlers, { url: peerjs, key: env.VITE_PEERJS_KEY || 'peerjs' }));
  const nostr = setting(env.VITE_NOSTR_RELAYS, DEFAULT_NOSTR_RELAYS.join(','));
  const urls = nostr?.split(/[\s,]+/).filter((u) => /^wss?:\/\//.test(u)) ?? [];
  if (urls.length > 0) relays.push(new NostrRelays(handlers, urls));
  return relays;
}

/** Unset or empty: `fallback`. `none` (or `off`): disabled. */
function setting(raw: string | undefined, fallback: string): string | null {
  const v = raw?.trim();
  if (!v) return fallback;
  return /^(none|off)$/i.test(v) ? null : v;
}

const DEFAULT_ICE_SERVERS: IceServerConfig[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
];

function iceServersFromEnv(): IceServerConfig[] {
  if (!env.VITE_ICE_SERVERS) return DEFAULT_ICE_SERVERS;
  try {
    const parsed: unknown = JSON.parse(env.VITE_ICE_SERVERS);
    if (Array.isArray(parsed) && parsed.every(isIceServer)) return parsed;
  } catch {
    // fall through
  }
  console.error('[signaling] VITE_ICE_SERVERS is not a JSON array of RTCIceServer objects; using STUN defaults');
  return DEFAULT_ICE_SERVERS;
}

/**
 * Extra ICE servers (typically TURN with short-lived credentials) from a URL that returns a JSON array of
 * RTCIceServer objects, or `{ "iceServers": [...] }`: e.g. Metered's `/api/v1/turn/credentials?apiKey=…`.
 * Gives up after a few seconds: direct connections don't need it.
 */
export async function fetchIceServers(url: string, timeoutMs = 4000): Promise<IceServerConfig[]> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: unknown = await res.json();
    const list: unknown = Array.isArray(body) ? body : (body as { iceServers?: unknown } | null)?.iceServers;
    if (Array.isArray(list) && list.every(isIceServer)) return list;
    throw new Error('not a list of RTCIceServer objects');
  } catch (err) {
    console.warn('[signaling] could not load ICE servers from VITE_ICE_SERVERS_URL; direct connections only', err);
    return [];
  }
}

function publicUrlFromEnv(): string | null {
  const v = env.VITE_PUBLIC_URL?.trim().replace(/\/+$/, '');
  return v && /^https?:\/\/[^/]+$/.test(v) ? v : null;
}

export function signalingUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${SIGNAL_PATH}`;
}

/** A connection that stayed up this long was healthy: the backoff starts over. */
const STABLE_MS = 15_000;

/**
 * WebSocket to the PizzaDrop signaling server (`server/`) with automatic
 * reconnect (exponential backoff, capped at 10 s).
 */
export class SignalingClient implements Signaling {
  private ws: WebSocket | null = null;
  private closed = false;
  private attempt = 0;
  private openedAt = 0;
  private listening = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  iceServers: IceServerConfig[] = [];
  readonly iceReady = Promise.resolve();
  readonly reliable = true;
  publicUrl: string | null = null;
  /** Reconnect straight away when the page comes back to the foreground or the network returns. */
  private readonly kick = () => {
    if (this.closed || this.ws || document.visibilityState === 'hidden') return;
    clearTimeout(this.retryTimer);
    this.attempt = 0;
    this.connect();
  };

  constructor(
    private readonly handlers: SignalingHandlers,
    private readonly url: string = signalingUrl(),
  ) {}

  connect(): void {
    if (this.closed || this.ws) return;
    if (!this.listening) {
      this.listening = true;
      window.addEventListener('online', this.kick);
      document.addEventListener('visibilitychange', this.kick);
    }
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.openedAt = 0;

    ws.onmessage = (ev) => {
      const msg = parseServerMessage(ev.data);
      if (!msg) return;
      if (msg.t === 'hello') {
        this.openedAt = Date.now();
        this.iceServers = msg.iceServers;
        this.publicUrl = msg.publicUrl;
        this.handlers.onReady(msg);
        return;
      }
      this.handlers.onMessage(msg);
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      // Only a connection that lasted resets the backoff: one dropped right after `hello` doesn't.
      if (this.openedAt && Date.now() - this.openedAt >= STABLE_MS) this.attempt = 0;
      const retrying = !this.closed;
      this.handlers.onDisconnect?.(retrying);
      if (retrying) {
        const delay = Math.min(10_000, 500 * 2 ** this.attempt++) * (0.75 + Math.random() * 0.5);
        this.retryTimer = setTimeout(() => this.connect(), delay);
      }
    };
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    window.removeEventListener('online', this.kick);
    document.removeEventListener('visibilitychange', this.kick);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
