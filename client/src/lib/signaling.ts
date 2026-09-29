import {
  isIceServer,
  parseServerMessage,
  SIGNAL_PATH,
  type ClientMessage,
  type IceServerConfig,
  type ServerMessage,
} from '@pizzadrop/shared';
import { PeerJsSignaling } from './peerjs';

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
  /** Canonical origin for share links, if the deployment sets one. */
  publicUrl: string | null;
  readonly isOpen: boolean;
  connect(): void;
  send(msg: ClientMessage): boolean;
  /** Close for good (no reconnect). */
  close(): void;
}

const env = import.meta.env;

/** The transport this build was configured with (see `client/.env.static` and README → Static hosting). */
export function createSignaling(handlers: SignalingHandlers): Signaling {
  if (env.VITE_SIGNALING === 'peerjs') {
    return new PeerJsSignaling(handlers, {
      url: env.VITE_PEERJS_URL || 'wss://0.peerjs.com/peerjs',
      key: env.VITE_PEERJS_KEY || 'peerjs',
      iceServers: iceServersFromEnv(),
      publicUrl: publicUrlFromEnv(),
      codeLength: env.VITE_CODE_LENGTH === '5' ? 5 : 6,
    });
  }
  return new SignalingClient(handlers, env.VITE_SIGNAL_URL || signalingUrl());
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

function publicUrlFromEnv(): string | null {
  const v = env.VITE_PUBLIC_URL?.trim().replace(/\/+$/, '');
  return v && /^https?:\/\/[^/]+$/.test(v) ? v : null;
}

export function signalingUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${SIGNAL_PATH}`;
}

/**
 * WebSocket to the PizzaDrop signaling server (`server/`) with automatic
 * reconnect (exponential backoff, capped at 10 s).
 */
export class SignalingClient implements Signaling {
  private ws: WebSocket | null = null;
  private closed = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  iceServers: IceServerConfig[] = [];
  publicUrl: string | null = null;

  constructor(
    private readonly handlers: SignalingHandlers,
    private readonly url: string = signalingUrl(),
  ) {}

  connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onmessage = (ev) => {
      const msg = parseServerMessage(ev.data);
      if (!msg) return;
      if (msg.t === 'hello') {
        this.attempt = 0;
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
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
