import {
  parseServerMessage,
  SIGNAL_PATH,
  type ClientMessage,
  type IceServerConfig,
  type ServerMessage,
} from '@pizzadrop/shared';

export interface SignalingHandlers {
  /** Socket (re)opened and the server said hello. */
  onReady(hello: Extract<ServerMessage, { t: 'hello' }>): void;
  onMessage(msg: ServerMessage): void;
  /** Socket closed; `retrying` tells whether a reconnect is scheduled. */
  onDisconnect?(retrying: boolean): void;
}

export function signalingUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${SIGNAL_PATH}`;
}

/**
 * WebSocket to the signaling server with automatic reconnect (exponential
 * backoff, capped at 10 s). Only signaling goes through here — once peers are
 * connected, file bytes flow directly between browsers.
 */
export class SignalingClient {
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

  /** Close for good (no reconnect). */
  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
