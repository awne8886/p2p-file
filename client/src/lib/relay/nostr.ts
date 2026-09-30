import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { toHex } from './crypto';
import type { NostrEvent, Sign } from './nostrSign';
import { SocketRelay, type Relay, type RelayHandlers, type RelayState } from './relay';

/**
 * Public Nostr relays as a signaling relay: independent of PeerJS, on port 443, and plentiful.
 *
 * Messages are ephemeral events (kinds 20000–29999 are forwarded to subscribers and never stored). Each party
 * subscribes to events tagged with its own inbox, `x = sha256(room/address)`, so relays route by a tag that says
 * nothing about the code or who is talking. Every event goes to all connected relays; the first copy wins.
 */

/** An ephemeral kind. */
export const NOSTR_KIND = 25_050;

export const DEFAULT_NOSTR_RELAYS = [
  'wss://nos.lol',
  'wss://relay.snort.social',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.mostro.network',
  'wss://relay.damus.io',
];

const SEEN_MAX = 1000;

export function inboxTag(room: string, address: string): string {
  return toHex(sha256(utf8ToBytes(`${room}/${address}`))).slice(0, 32);
}

/** Several Nostr relays that act as one: ready while any of them is. */
export class NostrRelays implements Relay {
  readonly name = 'nostr';
  private readonly sockets: NostrSocket[];
  private sign: Sign | null = null;
  private readonly seen = new Set<string>();

  constructor(
    private readonly handlers: RelayHandlers,
    urls: readonly string[],
  ) {
    const inner: RelayHandlers = {
      onData: () => undefined,
      onState: () => this.handlers.onState(),
    };
    this.sockets = urls.map((url) => new NostrSocket(url, inner, (ev) => this.onEvent(ev)));
    // Signing needs secp256k1, which only this path uses: load it while the sockets connect.
    import('./nostrSign').then(
      ({ createSigner }) => {
        this.sign = createSigner();
        this.handlers.onState();
      },
      (err: unknown) => console.warn('[signaling] nostr: could not load the signer', err),
    );
  }

  get state(): RelayState {
    const states = this.sockets.map((s) => s.state);
    if (states.includes('ready')) return this.sign ? 'ready' : 'connecting';
    if (states.length === 0 || states.every((s) => s === 'failed')) return 'failed';
    if (states.includes('connecting')) return 'connecting';
    return states.includes('down') ? 'down' : 'idle';
  }

  start(self: string, room: Promise<string>): void {
    for (const s of this.sockets) s.start(self, room);
  }

  send(to: string, wire: string): boolean {
    const room = this.sockets[0]?.roomName;
    if (!this.sign || !room) return false;
    const ev = this.sign(NOSTR_KIND, [['x', inboxTag(room, to)]], wire);
    let sent = false;
    for (const s of this.sockets) sent = s.publish(ev) || sent;
    return sent;
  }

  kick(): void {
    for (const s of this.sockets) s.kick();
  }

  close(): void {
    for (const s of this.sockets) s.close();
  }

  private onEvent(ev: { id: string; content: string }): void {
    if (this.seen.has(ev.id)) return;
    this.seen.add(ev.id);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value!);
    this.handlers.onData(ev.content);
  }
}

class NostrSocket extends SocketRelay {
  private readonly subId = `pd${Math.random().toString(36).slice(2, 10)}`;
  private inbox: string | null = null;
  private subscribed = false;

  constructor(
    private readonly relayUrl: string,
    handlers: RelayHandlers,
    private readonly onEvent: (ev: { id: string; content: string }) => void,
  ) {
    super(`nostr ${relayUrl}`, handlers);
  }

  get roomName(): string | null {
    return this.room;
  }

  send(): boolean {
    return false; // NostrRelays signs once and calls publish()
  }

  publish(ev: NostrEvent): boolean {
    const ws = this.ws;
    if (this.state !== 'ready' || ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(['EVENT', ev]));
    return true;
  }

  protected url(): string {
    return this.relayUrl;
  }

  protected onOpen(): void {
    this.markReady();
    this.subscribe();
  }

  protected onRoom(): void {
    this.subscribe();
  }

  protected override onDropped(): void {
    this.subscribed = false;
  }

  protected onText(data: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!Array.isArray(msg)) return;
    switch (msg[0]) {
      case 'EVENT': {
        const ev = msg[2] as Partial<NostrEvent> | undefined;
        if (
          msg[1] === this.subId &&
          ev?.kind === NOSTR_KIND &&
          typeof ev.id === 'string' &&
          typeof ev.content === 'string' &&
          Array.isArray(ev.tags) &&
          ev.tags.some((t) => Array.isArray(t) && t[0] === 'x' && t[1] === this.inbox)
        ) {
          this.onEvent({ id: ev.id, content: ev.content });
        }
        return;
      }
      case 'CLOSED':
        // The relay refused our subscription (it wants payment, authentication, other kinds…).
        if (msg[1] === this.subId) this.fail(`refused the subscription (${String(msg[2])})`);
        return;
      case 'OK':
        if (msg[2] === false) console.debug(`[signaling] ${this.name} rejected an event: ${String(msg[3])}`);
        return;
      default:
        return; // EOSE, NOTICE, AUTH
    }
  }

  private subscribe(): void {
    const ws = this.ws;
    if (this.subscribed || !this.room || !this.self || this.state !== 'ready' || ws?.readyState !== WebSocket.OPEN) {
      return;
    }
    this.inbox = inboxTag(this.room, this.self);
    this.subscribed = true;
    const filter = { kinds: [NOSTR_KIND], '#x': [this.inbox], since: Math.floor(Date.now() / 1000) - 60 };
    ws.send(JSON.stringify(['REQ', this.subId, filter]));
  }
}
