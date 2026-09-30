import type { ServerMessage } from '@pizzadrop/shared';
import { describe, expect, it } from 'vitest';
import type { SignalingHandlers } from '../signaling';
import { deriveRoomKeys, seal, unseal, wireId } from './crypto';
import type { Relay, RelayHandlers, RelayState } from './relay';
import { RelaySignaling } from './signaling';

/**
 * In-memory relays: every FakeRelay on the same Bus with the same name reaches the others. Like a Nostr relay,
 * several parties may listen on one address.
 */
class Bus {
  readonly boxes = new Map<string, Set<FakeRelay>>();
  delivered = 0;

  box(key: string): Set<FakeRelay> {
    let b = this.boxes.get(key);
    if (!b) this.boxes.set(key, (b = new Set()));
    return b;
  }
}

class FakeRelay implements Relay {
  state: RelayState = 'idle';
  self: string | null = null;
  room: string | null = null;
  sent: Array<{ to: string; wire: string }> = [];
  /** Accept sends but lose them (a relay that drops what it's given). */
  blackhole = false;

  constructor(
    readonly name: string,
    private readonly bus: Bus,
    private readonly handlers: RelayHandlers,
    private readonly startReady = true,
  ) {}

  start(self: string, room: Promise<string>): void {
    this.self = self;
    void room.then((r) => {
      this.room = r;
      this.bus.box(`${this.name}/${r}/${self}`).add(this);
      if (this.startReady) this.setState('ready');
      else this.setState('connecting');
    });
  }

  send(to: string, wire: string): boolean {
    if (this.state !== 'ready') return false;
    this.sent.push({ to, wire });
    if (this.blackhole) return true;
    for (const target of this.bus.box(`${this.name}/${this.room}/${to}`)) {
      setTimeout(() => {
        if (target.state === 'ready') {
          this.bus.delivered++;
          target.handlers.onData(wire);
        }
      }, 1);
    }
    return true;
  }

  setState(state: RelayState): void {
    this.state = state;
    this.handlers.onState();
  }

  takeAddress(): void {
    this.handlers.onAddressTaken?.();
  }

  /** Hand `wire` to this relay's owner as if it had arrived. */
  inject(wire: string): void {
    this.handlers.onData(wire);
  }

  kick(): void {}

  close(): void {
    this.state = 'idle';
    for (const b of this.bus.boxes.values()) b.delete(this);
  }
}

type Hello = Parameters<SignalingHandlers['onReady']>[0];

function party(bus: Bus, relayNames: Array<string | [string, boolean]> = ['a']) {
  const messages: ServerMessage[] = [];
  const relays: FakeRelay[] = [];
  const disconnects: boolean[] = [];
  let readies = 0;
  const handlers: SignalingHandlers = {
    onReady: (_h: Hello) => void readies++,
    onMessage: (m) => messages.push(m),
    onDisconnect: (retrying) => disconnects.push(retrying),
  };
  const signaling = new RelaySignaling(handlers, {
    relays: (h) => {
      const made = relayNames.map((n) =>
        Array.isArray(n) ? new FakeRelay(n[0], bus, h, n[1]) : new FakeRelay(n, bus, h),
      );
      relays.push(...made);
      return made;
    },
    iceServers: [],
    publicUrl: null,
    codeLength: 6,
    deriveKeys: (code) => deriveRoomKeys(code, 1000),
  });
  signaling.connect();
  return { signaling, messages, relays, disconnects, readies: () => readies };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await tick(5);
  }
}

async function hostAndJoin(bus: Bus, hostRelays?: Array<string | [string, boolean]>, rxRelays = hostRelays) {
  const host = party(bus, hostRelays);
  host.signaling.send({ t: 'host' });
  await until(() => host.messages.some((m) => m.t === 'hosted'));
  const hosted = host.messages.find((m) => m.t === 'hosted') as Extract<ServerMessage, { t: 'hosted' }>;
  const rx = party(bus, rxRelays);
  rx.signaling.send({ t: 'join', code: hosted.code.toUpperCase(), clientId: 'client-1', attempt: 'a1' });
  await until(() => host.messages.some((m) => m.t === 'peer-joined'));
  return { host, rx, code: hosted.code };
}

describe('sealed envelopes', () => {
  it('round-trip, and anything else is rejected', async () => {
    const k = await deriveRoomKeys('x7k4qm', 1000);
    const other = await deriveRoomKeys('x7k4qn', 1000);
    expect(k.room).toMatch(/^[0-9a-f]{32}$/);
    expect(other.room).not.toBe(k.room);
    const wire = await seal(k, 'hello');
    expect(await unseal(k, wire)).toBe('hello');
    expect(await unseal(other, wire)).toBeNull();
    const flipped = wire.slice(0, 20) + (wire[20] === 'A' ? 'B' : 'A') + wire.slice(21);
    expect(await unseal(k, flipped)).toBeNull();
    expect(await unseal(k, 'not base64!')).toBeNull();
    expect(wireId(await seal(k, 'hello'))).not.toBe(wireId(wire)); // random IV per message
  });
});

describe('RelaySignaling', () => {
  it('introduces a receiver to the sender and relays signals both ways', async () => {
    const bus = new Bus();
    const { host, rx } = await hostAndJoin(bus);
    const joined = host.messages.find((m) => m.t === 'peer-joined') as Extract<ServerMessage, { t: 'peer-joined' }>;
    expect(joined.clientId).toBe('client-1');
    expect(joined.attempt).toBe('a1');
    expect(joined.peerId).toMatch(/^[0-9a-f]{16}$/);
    await until(() => rx.messages.some((m) => m.t === 'joined'));

    const candidate = {
      candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
      usernameFragment: null,
    };
    host.signaling.send({
      t: 'signal',
      to: joined.peerId,
      data: { kind: 'description', description: { type: 'offer', sdp: 'v=0' }, conn: 'c1' },
    });
    host.signaling.send({ t: 'signal', to: joined.peerId, data: { kind: 'candidate', candidate, conn: 'c1' } });
    await until(() => rx.messages.filter((m) => m.t === 'signal').length === 2);
    expect(rx.messages.filter((m) => m.t === 'signal').map((m) => (m as { data: { kind: string } }).data.kind)).toEqual(
      ['description', 'candidate'],
    );

    rx.signaling.send({
      t: 'signal',
      data: { kind: 'description', description: { type: 'answer', sdp: 'v=0' }, conn: 'c1' },
    });
    await until(() => host.messages.some((m) => m.t === 'signal'));
    const answer = host.messages.find((m) => m.t === 'signal') as Extract<ServerMessage, { t: 'signal' }>;
    expect(answer.from).toBe(joined.peerId);
    expect(answer.data.kind).toBe('description');
  });

  it('batches what is sent in one go into a single relay message', async () => {
    const bus = new Bus();
    const { host } = await hostAndJoin(bus);
    const peerId = (host.messages.find((m) => m.t === 'peer-joined') as { peerId: string }).peerId;
    const before = host.relays[0]!.sent.length;
    for (let i = 0; i < 5; i++) {
      host.signaling.send({ t: 'signal', to: peerId, data: { kind: 'candidate', candidate: null, conn: 'c' } });
    }
    await tick();
    expect(host.relays[0]!.sent.length - before).toBe(1);
  });

  it('gets through while one relay loses everything, and delivers each message once', async () => {
    const bus = new Bus();
    const host = party(bus, ['lossy', 'good']);
    host.signaling.send({ t: 'host' });
    await until(() => host.messages.some((m) => m.t === 'hosted'));
    host.relays[0]!.blackhole = true;
    const code = (host.messages.find((m) => m.t === 'hosted') as { code: string }).code;
    const rx = party(bus, ['lossy', 'good']);
    rx.signaling.send({ t: 'join', code, clientId: 'c', attempt: 'x' });
    await until(() => rx.messages.some((m) => m.t === 'joined'));
    expect(host.messages.filter((m) => m.t === 'peer-joined')).toHaveLength(1);

    // Both relays carrying the same message: handled once.
    host.relays[0]!.blackhole = false;
    rx.signaling.send({ t: 'leave' });
    await until(() => host.messages.some((m) => m.t === 'peer-left'));
    await tick(30);
    expect(host.messages.filter((m) => m.t === 'peer-left')).toHaveLength(1);
  });

  it('sends recent messages on a relay that comes up late', async () => {
    const bus = new Bus();
    const host = party(bus, ['slow']);
    host.signaling.send({ t: 'host' });
    await until(() => host.messages.some((m) => m.t === 'hosted'));
    const code = (host.messages.find((m) => m.t === 'hosted') as { code: string }).code;
    const rx = party(bus, [['slow', false]]); // connecting, not ready
    rx.signaling.send({ t: 'join', code, clientId: 'c', attempt: 'x' });
    await tick(30);
    expect(host.messages.some((m) => m.t === 'peer-joined')).toBe(false);
    rx.relays[0]!.setState('ready');
    await until(() => host.messages.some((m) => m.t === 'peer-joined'));
  });

  it('ignores messages meant for another receiver, and ones that were tampered with', async () => {
    const bus = new Bus();
    const { host, rx } = await hostAndJoin(bus);
    const peerId = (host.messages.find((m) => m.t === 'peer-joined') as { peerId: string }).peerId;
    await until(() => rx.messages.some((m) => m.t === 'joined'));
    const count = rx.messages.length;
    const relay = host.relays[0]!;
    // Replay the host's last message to the receiver with a flipped byte, and send one to someone else.
    host.signaling.send({ t: 'signal', to: peerId, data: { kind: 'candidate', candidate: null } });
    await until(() => rx.messages.length === count + 1);
    const last = relay.sent.at(-1)!;
    const target = rx.relays[0]!;
    const flipped = last.wire.slice(0, 30) + (last.wire[30] === 'A' ? 'B' : 'A') + last.wire.slice(31);
    target.inject(flipped);
    target.inject(last.wire); // exact replay
    await tick(30);
    expect(rx.messages.length).toBe(count + 1);
  });

  it('only accepts messages the sender signed', async () => {
    const bus = new Bus();
    const { rx, code } = await hostAndJoin(bus);
    await until(() => rx.messages.some((m) => m.t === 'joined'));
    const count = rx.messages.length;
    // Someone with the link (so the key) writes as the sender, without the sender's signing key.
    const keys = await deriveRoomKeys(code, 1000);
    const e = JSON.stringify({
      v: 1,
      from: 'host',
      to: rx.relays[0]!.self,
      at: Date.now(),
      msgs: [{ t: 'host-left' }],
    });
    rx.relays[0]!.inject(await seal(keys, JSON.stringify({ e })));
    rx.relays[0]!.inject(await seal(keys, JSON.stringify({ e, hk: 'AAAA', sig: 'AAAA' })));
    await tick(30);
    expect(rx.messages.length).toBe(count);
  });

  it('refuses to go on when a second, different sender answers for the same code', async () => {
    const bus = new Bus();
    const real = party(bus);
    real.signaling.send({ t: 'host' });
    await until(() => real.messages.some((m) => m.t === 'hosted'));
    const code = (real.messages.find((m) => m.t === 'hosted') as { code: string }).code;
    // Someone else who has the link, answering as the sender (possible on public relays).
    const impostor = party(bus);
    impostor.signaling.send({ t: 'host', resume: { code, token: 'x' } });
    await until(() => impostor.messages.some((m) => m.t === 'hosted'));
    const rx = party(bus);
    rx.signaling.send({ t: 'join', code, clientId: 'c', attempt: 'x' });
    await until(() => rx.messages.some((m) => m.t === 'error'));
    const err = rx.messages.find((m) => m.t === 'error') as { message: string };
    expect(err.message).toMatch(/two different senders/i);
  });

  it('picks another code when PeerJS says the first one is taken', async () => {
    const bus = new Bus();
    const host = party(bus, [['peerjs', false]]);
    host.signaling.send({ t: 'host' });
    await until(() => host.relays.length === 1 && host.relays[0]!.room !== null);
    const firstRoom = host.relays[0]!.room;
    host.relays[0]!.takeAddress();
    await until(() => host.relays.length === 2 && host.relays[1]!.room !== null);
    expect(host.relays[1]!.room).not.toBe(firstRoom);
    host.relays[1]!.setState('ready');
    await until(() => host.messages.some((m) => m.t === 'hosted'));
  });

  it('reports an error when every relay has given up', async () => {
    const bus = new Bus();
    const rx = party(bus, ['a', 'b']);
    rx.signaling.send({ t: 'join', code: 'x7k4qm', clientId: 'c' });
    await until(() => rx.relays.every((r) => r.room !== null));
    rx.relays[0]!.setState('failed');
    expect(rx.messages.some((m) => m.t === 'error')).toBe(false);
    rx.relays[1]!.setState('failed');
    expect(rx.messages.find((m) => m.t === 'error')).toMatchObject({ code: 'server-error' });
  });

  it('says so when all relays drop, and re-drives when one is back', async () => {
    const bus = new Bus();
    const host = party(bus, ['a']);
    host.signaling.send({ t: 'host' });
    await until(() => host.messages.some((m) => m.t === 'hosted'));
    const readies = host.readies();
    host.relays[0]!.setState('down');
    expect(host.disconnects).toEqual([true]);
    host.relays[0]!.setState('ready');
    expect(host.readies()).toBe(readies + 1);
  });
});
