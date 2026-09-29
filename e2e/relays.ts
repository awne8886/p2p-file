/**
 * Local stand-ins for the public relays the static build signals through, each with a switch to break it the way
 * real ones break.
 */
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

type Filter = { kinds?: number[] } & Record<string, unknown>;
interface NostrEvent {
  id: string;
  kind: number;
  tags: string[][];
}

function matches(ev: NostrEvent, filters: Filter[]): boolean {
  return filters.some((f) => {
    if (f.kinds && !f.kinds.includes(ev.kind)) return false;
    for (const [key, want] of Object.entries(f)) {
      if (!key.startsWith('#') || !Array.isArray(want)) continue;
      const name = key.slice(1);
      if (!ev.tags.some((t) => t[0] === name && want.includes(t[1]))) return false;
    }
    return true;
  });
}

/**
 * A minimal Nostr relay (NIP-01): subscriptions filtered by `kinds` and `#<tag>`, events forwarded to every
 * matching subscription and never stored. `setDown(true)` drops every connection and refuses new ones.
 */
export async function startNostrRelay(): Promise<{
  url: string;
  events(): number;
  setDown(down: boolean): void;
  close(): void;
}> {
  const subs = new Map<WebSocket, Map<string, Filter[]>>();
  let events = 0;
  let down = false;
  const srv = http.createServer();
  const wss = new WebSocketServer({ server: srv });
  wss.on('connection', (ws) => {
    if (down) return ws.terminate();
    subs.set(ws, new Map());
    ws.on('close', () => subs.delete(ws));
    ws.on('message', (data) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!Array.isArray(msg)) return;
      if (msg[0] === 'REQ' && typeof msg[1] === 'string') {
        subs.get(ws)?.set(msg[1], msg.slice(2) as Filter[]);
        ws.send(JSON.stringify(['EOSE', msg[1]]));
      } else if (msg[0] === 'CLOSE' && typeof msg[1] === 'string') {
        subs.get(ws)?.delete(msg[1]);
      } else if (msg[0] === 'EVENT' && typeof msg[1] === 'object' && msg[1] !== null) {
        const ev = msg[1] as NostrEvent;
        events++;
        ws.send(JSON.stringify(['OK', ev.id, true, '']));
        for (const [client, clientSubs] of subs) {
          for (const [subId, filters] of clientSubs) {
            if (matches(ev, filters)) client.send(JSON.stringify(['EVENT', subId, ev]));
          }
        }
      }
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address() as { port: number };
  return {
    url: `ws://127.0.0.1:${port}`,
    events: () => events,
    setDown: (d) => {
      down = d;
      if (d) for (const c of wss.clients) c.terminate();
    },
    close: () => {
      for (const c of wss.clients) c.terminate();
      wss.close();
      srv.close();
    },
  };
}

/**
 * A pass-through in front of a PeerJS server. `setHostile(true)` makes it behave like the public 0.peerjs.com did
 * towards some clients: it registers them, then closes the socket the moment they relay a message.
 */
export async function startPeerJsProxy(targetPort: number): Promise<{
  port: number;
  registrations(): number;
  setHostile(hostile: boolean): void;
  close(): void;
}> {
  let hostile = false;
  let registrations = 0;
  const srv = http.createServer();
  const wss = new WebSocketServer({ server: srv });
  wss.on('connection', (client, req) => {
    registrations++;
    const upstream = new WebSocket(`ws://127.0.0.1:${targetPort}${req.url ?? '/'}`);
    const pending: string[] = [];
    upstream.on('open', () => pending.splice(0).forEach((m) => upstream.send(m)));
    upstream.on('message', (d) => client.readyState === WebSocket.OPEN && client.send(String(d)));
    upstream.on('close', () => client.close());
    upstream.on('error', () => client.close());
    client.on('message', (d) => {
      const text = String(d);
      if (hostile && !text.includes('"HEARTBEAT"')) {
        client.close(1000);
        return;
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
      else pending.push(text);
    });
    client.on('close', () => upstream.close());
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return {
    port: (srv.address() as { port: number }).port,
    registrations: () => registrations,
    setHostile: (h) => void (hostile = h),
    close: () => {
      for (const c of wss.clients) c.terminate();
      wss.close();
      srv.close();
    },
  };
}
