import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { isValidCode } from '@pizzadrop/shared';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Security headers for every response. The CSP allows only same-origin
 * scripts/workers and same-origin WebSockets; `no-referrer` keeps share codes
 * out of Referer headers sent to third parties.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self' ws: wss:",
    "worker-src 'self' blob:",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

/**
 * Serves the built client. Unknown paths that look like app routes (`/`,
 * `/<code>`) get `index.html`; hashed assets are cached forever; everything
 * else (including the service worker) is revalidated on every load.
 */
export function createStaticHandler(root: string) {
  const rootResolved = path.resolve(root);

  return async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', ...SECURITY_HEADERS }).end();
      return;
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      res.writeHead(400, SECURITY_HEADERS).end('Bad request');
      return;
    }

    const filePath = path.resolve(rootResolved, `.${path.posix.normalize(pathname)}`);
    if (filePath !== rootResolved && !filePath.startsWith(rootResolved + path.sep)) {
      res.writeHead(403, SECURITY_HEADERS).end('Forbidden');
      return;
    }

    const file = await statFile(filePath);
    if (file) {
      const isHashedAsset = pathname.startsWith('/assets/');
      return send(req, res, filePath, file.size, isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache', {
        ...(pathname === '/sw.js' ? { 'Service-Worker-Allowed': '/' } : {}),
      });
    }

    const segment = pathname.slice(1);
    if (pathname === '/' || (!segment.includes('/') && isValidCode(segment))) {
      const index = path.join(rootResolved, 'index.html');
      const indexStat = await statFile(index);
      if (indexStat) return send(req, res, index, indexStat.size, 'no-cache');
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS }).end('Not found');
  };
}

async function statFile(p: string): Promise<{ size: number } | null> {
  try {
    const s = await stat(p);
    return s.isFile() ? { size: s.size } : null;
  } catch {
    return null;
  }
}

function send(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  size: number,
  cacheControl: string,
  extra: Record<string, string> = {},
): void {
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': String(size),
    'Cache-Control': cacheControl,
    ...SECURITY_HEADERS,
    ...extra,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}
