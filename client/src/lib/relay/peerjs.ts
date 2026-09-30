import { randomId } from '../ids';
import { SocketRelay, type RelayHandlers } from './relay';

/**
 * A PeerJS server (by default the free public one at 0.peerjs.com) used as a relay.
 *
 * A PeerJS server does one thing: it forwards small JSON messages between WebSockets registered under ids. The
 * sender registers as `pizzadrop-<room>` (see `crypto.ts`), so the server can tell whether that name is taken but
 * never learns the code; receivers register under random ids. No PeerJS library is shipped: this speaks the
 * server's small protocol directly.
 */

const ID_PREFIX = 'pizzadrop-';
/** The official client's interval; the server drops sockets that stay silent for its `alive_timeout`. */
const HEARTBEAT_MS = 5_000;
/** Marks our messages; version 3 carries sealed envelopes. */
const TAG = 3;

export interface PeerJsOptions {
  /** WebSocket endpoint, e.g. `wss://0.peerjs.com/peerjs`. */
  url: string;
  key: string;
}

interface Wire {
  type?: unknown;
  src?: unknown;
  payload?: { pizzadrop?: unknown; d?: unknown };
}

export class PeerJsRelay extends SocketRelay {
  private readonly token = randomId(16);
  /** The server has registered our id under our token at least once. */
  private claimed = false;
  private heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(
    handlers: RelayHandlers,
    private readonly opts: PeerJsOptions,
  ) {
    super('peerjs', handlers);
  }

  send(to: string, wire: string): boolean {
    const ws = this.ws;
    if (this.state !== 'ready' || !this.room || ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ type: 'OFFER', dst: this.idOf(to), payload: { pizzadrop: TAG, d: wire } }));
    return true;
  }

  protected url(): string | null {
    const id = this.self && this.idOf(this.self);
    if (!id) return null;
    const url = new URL(this.opts.url);
    url.searchParams.set('key', this.opts.key);
    url.searchParams.set('id', id);
    url.searchParams.set('token', this.token);
    url.searchParams.set('version', '1.5.5');
    return url.toString();
  }

  protected onRoom(): void {
    // The sender's id is derived from the room, so it connects only now; receivers already have.
    this.open();
  }

  protected onOpen(): void {
    // Reclaiming an id we already hold (same token) is accepted without a fresh OPEN message.
    if (this.claimed) this.registered();
  }

  protected override onDropped(): void {
    clearInterval(this.heartbeat);
  }

  protected onText(data: string): void {
    let wire: Wire;
    try {
      wire = JSON.parse(data) as Wire;
    } catch {
      return;
    }
    switch (wire.type) {
      case 'OPEN':
        this.claimed = true;
        this.registered();
        return;
      case 'ID-TAKEN':
        // Before our first registration the sender picks another code (which closes this relay); after it, some
        // other page took our id while we were disconnected.
        if (!this.claimed) this.handlers.onAddressTaken?.();
        this.fail('our id is taken');
        return;
      case 'ERROR':
        // E.g. the server is at its connection limit: try again later.
        this.reconnect();
        return;
      case 'OFFER':
      case 'ANSWER':
      case 'CANDIDATE': {
        const p = wire.payload;
        if (p?.pizzadrop === TAG && typeof p.d === 'string') this.handlers.onData(p.d);
        return;
      }
      default:
        // EXPIRE / LEAVE (a message couldn't be delivered) are ignored: other relays may still reach them.
        return;
    }
  }

  private registered(): void {
    const ws = this.ws;
    if (!ws) return;
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'HEARTBEAT' }));
    }, HEARTBEAT_MS);
    this.markReady();
  }

  private idOf(address: string): string | null {
    if (address !== 'host') return `${ID_PREFIX}r-${address}`;
    return this.room ? ID_PREFIX + this.room : null;
  }
}
