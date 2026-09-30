/**
 * A relay carries small sealed messages (see `crypto.ts`) between the sender and receivers of one share. It is
 * deliberately dumb and unreliable: it may be slow, drop messages, or be down entirely. `RelaySignaling` runs
 * several at once and uses whichever gets a message through first.
 *
 * Addresses are `host` for the sender and a random id for each receiver.
 */

/**
 * `ready`: messages can be sent. `down`: disconnected, a reconnect is scheduled. `failed`: given up on for this
 * page (it refused us, or keeps dropping the connection as soon as it's used).
 */
export type RelayState = 'idle' | 'connecting' | 'ready' | 'down' | 'failed';

export interface RelayHandlers {
  /** A sealed message addressed to us arrived. */
  onData(wire: string): void;
  /** Some relay's state changed. */
  onState(): void;
  /** Our address belongs to someone else (PeerJS only, before our first registration). */
  onAddressTaken?(): void;
}

export interface Relay {
  /** For logs, and so `RelaySignaling` can tell PeerJS apart. */
  readonly name: string;
  readonly state: RelayState;
  /** Connect as `self`. `room` resolves once the share's keys are derived, which runs meanwhile. */
  start(self: string, room: Promise<string>): void;
  /** Best effort: true if the message was handed to the socket. */
  send(to: string, wire: string): boolean;
  /** Reconnect now instead of waiting out the backoff (the page became visible, or the network came back). */
  kick(): void;
  close(): void;
}

/** A connection that stayed up this long was healthy: backoff and flap counts start over. */
const STABLE_MS = 15_000;
/** Dropped this many times in a row soon after connecting: the relay is refusing us, so stop hammering it. */
const MAX_FLAPS = 4;
const MAX_BACKOFF_MS = 15_000;

/** One WebSocket with reconnect-on-drop, exponential backoff and flap detection. */
export abstract class SocketRelay implements Relay {
  state: RelayState = 'idle';
  protected ws: WebSocket | null = null;
  protected self: string | null = null;
  protected room: string | null = null;
  protected closed = false;
  private attempt = 0;
  private flaps = 0;
  private readyAt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly name: string,
    protected readonly handlers: RelayHandlers,
  ) {}

  start(self: string, room: Promise<string>): void {
    this.self = self;
    room.then(
      (r) => {
        if (this.closed) return;
        this.room = r;
        this.onRoom();
      },
      () => undefined,
    );
    this.open();
  }

  abstract send(to: string, wire: string): boolean;

  kick(): void {
    if (this.closed || this.state !== 'down') return;
    clearTimeout(this.retryTimer);
    this.attempt = 0;
    this.open();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    this.onDropped();
    ws?.close();
  }

  /** The URL to connect to, or null if it isn't known yet. */
  protected abstract url(): string | null;
  /** The socket opened. */
  protected abstract onOpen(): void;
  /** The room name became known. */
  protected abstract onRoom(): void;
  protected abstract onText(data: string): void;
  /** The socket is gone (dropped or closed): stop anything tied to it. */
  protected onDropped(): void {}

  protected open(): void {
    if (this.closed || this.ws || this.state === 'failed') return;
    const url = this.url();
    if (!url) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.fail(`can't open ${url}: ${String(err)}`);
      return;
    }
    this.ws = ws;
    this.readyAt = 0;
    this.setState('connecting');
    ws.onopen = () => {
      if (this.ws === ws) this.onOpen();
    };
    ws.onmessage = (ev) => {
      if (this.ws === ws && typeof ev.data === 'string') this.onText(ev.data);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.dropped();
    };
  }

  protected markReady(): void {
    if (this.state === 'ready') return;
    this.readyAt = Date.now();
    this.setState('ready');
  }

  /** Give up on this relay for the rest of the page's life. */
  protected fail(reason: string): void {
    if (this.closed || this.state === 'failed') return;
    console.warn(`[signaling] ${this.name}: ${reason}; not using it`);
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    this.onDropped();
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    this.setState('failed');
  }

  /** Close the current socket and reconnect after the usual backoff. */
  protected reconnect(): void {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    ws.onclose = null;
    ws.close();
    this.dropped();
  }

  protected setState(state: RelayState): void {
    if (this.state === state) return;
    this.state = state;
    this.handlers.onState();
  }

  private dropped(): void {
    this.onDropped();
    if (this.closed || this.state === 'failed') return;
    if (this.readyAt) {
      const lived = Date.now() - this.readyAt;
      if (lived >= STABLE_MS) {
        this.attempt = 0;
        this.flaps = 0;
      } else if (++this.flaps >= MAX_FLAPS) {
        this.fail('keeps dropping the connection');
        return;
      }
    }
    this.readyAt = 0;
    this.setState('down');
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempt++) * (0.75 + Math.random() * 0.5);
    this.retryTimer = setTimeout(() => this.open(), delay);
  }
}
