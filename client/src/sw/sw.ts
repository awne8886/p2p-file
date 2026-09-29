/// <reference lib="webworker" />
/**
 * PizzaDrop download service worker (StreamSaver-style).
 *
 * It does exactly one thing: when the page asks, it serves a synthetic
 * download URL whose response body is a ReadableStream fed from the page
 * over a MessagePort. This gives Firefox and Chromium-without-File-System-
 * Access a true streaming download (bytes go to disk as they arrive), with
 * back-pressure all the way from the browser's download manager to the
 * WebRTC sender.
 *
 * Every other request passes through untouched.
 */
import type { PagePortMessage, SwPortMessage, SwRegisterMessage } from '../lib/swProtocol';

const sw = self as unknown as ServiceWorkerGlobalScope;

/**
 * Download URLs live under the worker's scope, which is wherever the app is
 * served from (`/`, or e.g. `/p2p-file/` on GitHub Pages).
 * Keep the path in sync with SW_DOWNLOAD_PATH in lib/swProtocol.ts.
 */
const PREFIX = new URL('__pizzadrop/dl/', sw.registration.scope).pathname;
const HIGH_WATER_MARK = 1024 * 1024;
const REGISTRATION_TTL_MS = 60_000;

interface Pending {
  port: MessagePort;
  name: string;
  size: number | null;
  mime: string;
}

const pending = new Map<string, Pending>();

sw.addEventListener('install', () => {
  void sw.skipWaiting();
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(sw.clients.claim());
});

sw.addEventListener('message', (event) => {
  const data = event.data as SwRegisterMessage | { type: 'ping' } | undefined;
  if (data?.type === 'register') {
    const port = event.ports[0];
    if (!port) return;
    pending.set(data.id, { port, name: data.name, size: data.size, mime: data.mime });
    setTimeout(() => pending.delete(data.id), REGISTRATION_TTL_MS);
    post(port, { type: 'registered' });
  }
  // 'ping' needs no handling: receiving the event keeps the worker alive
  // (Firefox stops idle service workers after ~30 s).
});

sw.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== sw.location.origin || !url.pathname.startsWith(PREFIX)) return;
  const id = url.pathname.slice(PREFIX.length).split('/')[0] ?? '';
  const entry = pending.get(id);
  if (!entry) {
    event.respondWith(new Response('This download link has expired.', { status: 404 }));
    return;
  }
  pending.delete(id);
  event.respondWith(streamingResponse(entry));
});

function post(port: MessagePort, msg: SwPortMessage): void {
  port.postMessage(msg);
}

function streamingResponse({ port, name, size, mime }: Pending): Response {
  let enqueued = 0;
  let finished = false;
  let wake: (() => void) | null = null;

  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        port.onmessage = (ev: MessageEvent<PagePortMessage>) => {
          const msg = ev.data;
          if (finished) return;
          if (msg.type === 'chunk') {
            controller.enqueue(msg.chunk);
            enqueued += msg.chunk.byteLength;
          } else if (msg.type === 'end') {
            finished = true;
            controller.close();
            port.close();
          } else {
            finished = true;
            controller.error(new Error(msg.reason));
            port.close();
          }
          wake?.();
          wake = null;
        };
        post(port, { type: 'started' });
      },
      pull(controller) {
        // Tell the page how much the browser has actually taken off our queue.
        const queued = HIGH_WATER_MARK - (controller.desiredSize ?? 0);
        post(port, { type: 'ack', bytes: enqueued - Math.max(0, queued) });
        if (finished) return;
        return new Promise<void>((resolve) => {
          wake = resolve;
        });
      },
      cancel() {
        finished = true;
        post(port, { type: 'cancel' });
        port.close();
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: HIGH_WATER_MARK }),
  );

  const headers = new Headers({
    'Content-Type': mime || 'application/octet-stream',
    'Content-Disposition': contentDisposition(name),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
    'Cache-Control': 'no-store',
  });
  if (size !== null) headers.set('Content-Length', String(size));
  return new Response(body, { headers });
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
