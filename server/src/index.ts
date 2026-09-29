import { existsSync } from 'node:fs';
import http from 'node:http';
import { SIGNAL_PATH } from '@pizzadrop/shared';
import { loadConfig } from './config.js';
import { createSignaling } from './signaling.js';
import { createStaticHandler, SECURITY_HEADERS } from './static.js';

const config = loadConfig();
const signaling = createSignaling(config);

const staticRoot = config.staticDir && existsSync(config.staticDir) ? config.staticDir : null;
const serveStatic = staticRoot ? createStaticHandler(staticRoot) : null;

const server = http.createServer((req, res) => {
  const pathname = (req.url ?? '/').split('?')[0];

  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    res.end(JSON.stringify({ ok: true, rooms: signaling.rooms.roomCount, receivers: signaling.rooms.peerCount }));
    return;
  }

  if (serveStatic) {
    serveStatic(req, res).catch((err: unknown) => {
      console.error('[http] static error', err);
      if (!res.headersSent) res.writeHead(500, SECURITY_HEADERS);
      res.end();
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
  res.end('PizzaDrop signaling server. Build the client (npm run build) to serve the app from here.');
});

server.on('upgrade', (req, socket, head) => {
  const pathname = (req.url ?? '/').split('?')[0];
  if (pathname !== SIGNAL_PATH) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  signaling.handleUpgrade(req, socket, head);
});

server.listen(config.port, config.host, () => {
  const turn = config.turnUrls.length > 0 ? `TURN: ${config.turnUrls.join(', ')}` : 'TURN: none (STUN only)';
  console.log(`[pizzadrop] listening on http://${config.host}:${config.port}  (ws ${SIGNAL_PATH})`);
  console.log(`[pizzadrop] static: ${staticRoot ?? 'disabled'} · ${turn} · code length ${config.codeLength}`);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[pizzadrop] ${signal} received, shutting down`);
  await signaling.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
