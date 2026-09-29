import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { PROTOCOL_VERSION, parseClientMessage, type ServerMessage } from '@pizzadrop/shared';
import type { Config } from './config.js';
import { buildIceServers } from './ice.js';
import { RateLimiter } from './rateLimit.js';
import { RoomManager, type Conn } from './rooms.js';

const HEARTBEAT_MS = 30_000;
const SWEEP_MS = 5_000;
const MAX_MESSAGE_BYTES = 64 * 1024;

interface LiveSocket extends WebSocket {
  isAlive?: boolean;
}

export interface Signaling {
  rooms: RoomManager;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): Promise<void>;
}

export function createSignaling(config: Config): Signaling {
  const rooms = new RoomManager({
    codeLength: config.codeLength,
    roomIdleTtlMs: config.roomIdleTtlMs,
    hostGraceMs: config.hostGraceMs,
    maxPeersPerRoom: config.maxPeersPerRoom,
  });

  // Joins are limited per IP so share codes can't be enumerated by brute force.
  const joinLimiter = new RateLimiter(20, 20 / 60);
  const hostLimiter = new RateLimiter(30, 30 / 600);
  // Per-connection message budget (ICE trickle is bursty, so allow a generous burst).
  const messageLimiter = new RateLimiter(400, 100);

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });

  wss.on('connection', (ws: LiveSocket, req: IncomingMessage) => {
    const ip = clientIp(req, config.trustProxy);
    const conn: Conn = {
      id: randomUUID(),
      send(msg: ServerMessage) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
    };

    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    conn.send({
      t: 'hello',
      version: PROTOCOL_VERSION,
      iceServers: buildIceServers(config),
      publicUrl: config.publicUrl,
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return conn.send({ t: 'error', code: 'bad-request', message: 'Binary frames are not accepted.' });
      if (!messageLimiter.take(conn.id)) {
        conn.send({ t: 'error', code: 'rate-limited', message: 'Slow down.' });
        return;
      }
      const msg = parseClientMessage(data.toString());
      if (!msg) return conn.send({ t: 'error', code: 'bad-request', message: 'Malformed message.' });
      if (msg.t === 'join' && !joinLimiter.take(ip)) {
        return conn.send({
          t: 'error',
          code: 'rate-limited',
          message: 'Too many attempts. Wait a minute and try again.',
        });
      }
      if (msg.t === 'host' && !msg.resume && !hostLimiter.take(ip)) {
        return conn.send({ t: 'error', code: 'rate-limited', message: 'Too many new links. Wait a few minutes.' });
      }
      try {
        rooms.handle(conn, msg);
      } catch (err) {
        console.error('[signaling] handler error', err);
        conn.send({ t: 'error', code: 'server-error', message: 'Something went wrong.' });
      }
    });

    ws.on('close', () => rooms.disconnect(conn));
    ws.on('error', () => ws.terminate());
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients as Set<LiveSocket>) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
    joinLimiter.prune();
    hostLimiter.prune();
    messageLimiter.prune();
  }, HEARTBEAT_MS);

  const sweeper = setInterval(() => rooms.sweep(), SWEEP_MS);
  heartbeat.unref();
  sweeper.unref();

  return {
    rooms,
    handleUpgrade(req, socket, head) {
      if (config.allowedOrigins.length > 0) {
        const origin = req.headers.origin ?? '';
        if (!config.allowedOrigins.includes(origin)) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    },
    close() {
      clearInterval(heartbeat);
      clearInterval(sweeper);
      for (const client of wss.clients) client.close(1001, 'server shutting down');
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}
