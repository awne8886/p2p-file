/**
 * Where received bytes go. Every sink is a WritableStream<Uint8Array>, tried
 * in this order:
 *
 *  1. File System Access (`showSaveFilePicker`) — Chromium desktop. Bytes are
 *     written straight into the file the user picked.
 *  2. Service-worker stream — Firefox, Chromium on Android. A synthetic
 *     download URL is served by our service worker from a stream fed by the
 *     page, so the browser's own download manager writes it to disk.
 *  3. Origin Private File System — WebKit (Safari, all iOS browsers). Bytes are
 *     written to OPFS from a worker, then handed to the download manager.
 *  4. In-memory Blob — last resort; the UI warns above {@link BLOB_WARN_BYTES}.
 */
import { BLOB_WARN_BYTES } from './constants';
import { Notifier } from './flow';
import { randomId } from './ids';
import { OPFS_DIR, type OpfsCommand, type OpfsRequest, type OpfsResponse } from './opfsProtocol';
import { SW_DOWNLOAD_PREFIX, type SwPortMessage, type SwRegisterMessage } from './swProtocol';

export type SinkKind = 'file-system-access' | 'service-worker' | 'opfs' | 'memory';

export interface Sink {
  kind: SinkKind;
  writable: WritableStream<Uint8Array>;
}

export const SINK_LABELS: Record<SinkKind, string> = {
  'file-system-access': 'streaming to disk',
  'service-worker': 'streaming to your downloads',
  opfs: 'streaming to disk',
  memory: 'buffering in memory',
};

/** The user dismissed the save dialog. Not an error — just don't start. */
export class SaveCancelledError extends Error {
  constructor() {
    super('save cancelled');
    this.name = 'SaveCancelledError';
  }
}

/** Only the in-memory fallback is left and the download is large; ask the user first. */
export class NeedsMemoryConfirmationError extends Error {
  constructor(readonly size: number) {
    super('large in-memory download needs confirmation');
    this.name = 'NeedsMemoryConfirmationError';
  }
}

interface SaveFilePickerOptions {
  suggestedName?: string;
}
type ShowSaveFilePicker = (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;

function getShowSaveFilePicker(): ShowSaveFilePicker | null {
  const fn = (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker;
  return typeof fn === 'function' ? fn.bind(window) : null;
}

/** Safari and every iOS browser. Their service-worker downloads can't be relied on. */
export function isWebKit(): boolean {
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const desktopSafari = /^((?!chrome|chromium|android|crios|fxios|edg).)*safari/i.test(ua);
  return iOS || desktopSafari;
}

const inTopFrame = () => {
  try {
    return window.self === window.top;
  } catch {
    return false;
  }
};

const ALL_SINKS: SinkKind[] = ['file-system-access', 'service-worker', 'opfs', 'memory'];

/** `?sink=memory` (etc.) forces one strategy — handy for testing each fallback. */
function forcedSink(): SinkKind | null {
  const v = new URLSearchParams(location.search).get('sink');
  return ALL_SINKS.find((k) => k === v) ?? null;
}

/** The sinks this browser can plausibly use, best first. */
export function sinkLadder(): SinkKind[] {
  const forced = forcedSink();
  if (forced) return forced === 'memory' ? ['memory'] : [forced, 'memory'];
  const ladder: SinkKind[] = [];
  if (window.isSecureContext && inTopFrame() && getShowSaveFilePicker()) ladder.push('file-system-access');
  if (window.isSecureContext && 'serviceWorker' in navigator && !isWebKit()) ladder.push('service-worker');
  if (
    window.isSecureContext &&
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof Worker !== 'undefined'
  ) {
    ladder.push('opfs');
  }
  ladder.push('memory');
  return ladder;
}

/** Will this download (probably) end up in memory? Lets the UI warn before the click. */
export function willBufferInMemory(): boolean {
  return sinkLadder()[0] === 'memory';
}

/**
 * Open the best available sink for a download of `size` bytes. Must be called
 * from a click handler (the save picker needs a user gesture).
 */
export async function openSink(
  name: string,
  size: number | null,
  mime: string,
  opts: { allowLargeMemory?: boolean; skip?: SinkKind[] } = {},
): Promise<Sink> {
  const ladder = sinkLadder().filter((k) => !opts.skip?.includes(k));
  let lastError: unknown = null;
  for (const kind of ladder) {
    try {
      switch (kind) {
        case 'file-system-access':
          return await openFileSystemAccessSink(name);
        case 'service-worker':
          return await openServiceWorkerSink(name, size, mime);
        case 'opfs':
          return await openOpfsSink(name, mime);
        case 'memory':
          if (size !== null && size > BLOB_WARN_BYTES && !opts.allowLargeMemory) {
            throw new NeedsMemoryConfirmationError(size);
          }
          return openMemorySink(name, mime);
      }
    } catch (err) {
      if (err instanceof SaveCancelledError || err instanceof NeedsMemoryConfirmationError) throw err;
      console.warn(`[sink] ${kind} unavailable, trying the next option`, err);
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('no way to save the file');
}

// ─── 1. File System Access ─────────────────────────────────────────────────

async function openFileSystemAccessSink(name: string): Promise<Sink> {
  const pick = getShowSaveFilePicker();
  if (!pick) throw new Error('showSaveFilePicker unavailable');
  let handle: FileSystemFileHandle;
  try {
    handle = await pick({ suggestedName: name });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw new SaveCancelledError();
    throw err;
  }
  // Writes go to a swap file and are only committed on close(); abort() discards them.
  const writable = await handle.createWritable();
  return { kind: 'file-system-access', writable: writable as unknown as WritableStream<Uint8Array> };
}

// ─── 2. Service worker stream ──────────────────────────────────────────────

const SW_URL = import.meta.env.DEV ? '/src/sw/sw.ts' : '/sw.js';
/** Bytes the page may post ahead of what the browser's download has consumed. */
const SW_WINDOW = 4 * 1024 * 1024;

let swRegistration: Promise<ServiceWorkerRegistration> | null = null;

/** Register the download service worker early so it's active by the time someone clicks Download. */
export function warmUpServiceWorker(): void {
  if (!sinkLadder().includes('service-worker')) return;
  ensureServiceWorker().catch((err: unknown) => console.warn('[sink] service worker registration failed', err));
}

function ensureServiceWorker(): Promise<ServiceWorkerRegistration> {
  // Vite serves the dev worker as an ES module; the production build is a classic script.
  swRegistration ??= navigator.serviceWorker
    .register(SW_URL, { scope: '/', type: import.meta.env.DEV ? 'module' : 'classic' })
    .then(() => navigator.serviceWorker.ready);
  return swRegistration;
}

async function openServiceWorkerSink(name: string, size: number | null, mime: string): Promise<Sink> {
  const reg = await withTimeout(ensureServiceWorker(), 4000, 'service worker did not activate');
  const worker = reg.active;
  if (!worker) throw new Error('no active service worker');

  const id = randomId();
  const channel = new MessageChannel();
  const port = channel.port1;
  const changed = new Notifier();
  let acked = 0;
  let sent = 0;
  let failure: Error | null = null;
  let resolveRegistered!: () => void;
  let resolveStarted!: () => void;
  const registered = new Promise<void>((r) => (resolveRegistered = r));
  const started = new Promise<void>((r) => (resolveStarted = r));

  port.onmessage = (ev: MessageEvent<SwPortMessage>) => {
    const msg = ev.data;
    if (msg.type === 'registered') resolveRegistered();
    else if (msg.type === 'started') resolveStarted();
    else if (msg.type === 'ack') acked = Math.max(acked, msg.bytes);
    else failure = new Error('The download was cancelled in the browser.');
    changed.notify();
  };

  const register: SwRegisterMessage = { type: 'register', id, name, size, mime };
  worker.postMessage(register, [channel.port2]);
  await withTimeout(registered, 3000, 'service worker did not answer');

  const iframe = document.createElement('iframe');
  iframe.hidden = true;
  iframe.title = 'download';
  iframe.src = `${SW_DOWNLOAD_PREFIX}${id}/${encodeURIComponent(name)}`;
  document.body.appendChild(iframe);

  try {
    await withTimeout(started, 6000, 'service worker did not intercept the download');
  } catch (err) {
    iframe.remove();
    port.close();
    throw err;
  }

  // Firefox stops idle service workers after ~30 s; any event resets that clock.
  const keepAlive = setInterval(() => worker.postMessage({ type: 'ping' }), 10_000);
  const cleanup = () => {
    clearInterval(keepAlive);
    // The iframe is left in place: removing it can cancel the download in some browsers.
  };

  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      while (!failure && sent - acked >= SW_WINDOW) await changed.wait(1000);
      if (failure) throw failure;
      port.postMessage({ type: 'chunk', chunk });
      sent += chunk.byteLength;
    },
    close() {
      port.postMessage({ type: 'end' });
      cleanup();
    },
    abort(reason: unknown) {
      port.postMessage({ type: 'abort', reason: String(reason) });
      cleanup();
    },
  });
  return { kind: 'service-worker', writable };
}

// ─── 3. Origin Private File System ─────────────────────────────────────────

async function openOpfsSink(name: string, mime: string): Promise<Sink> {
  const worker = new Worker(new URL('../workers/opfs.worker.ts', import.meta.url), { type: 'module', name: 'opfs' });
  const pending = new Map<number, { resolve(): void; reject(e: Error): void }>();
  let nextId = 1;
  worker.onmessage = (ev: MessageEvent<OpfsResponse>) => {
    const p = pending.get(ev.data.id);
    if (!p) return;
    pending.delete(ev.data.id);
    if (ev.data.type === 'ok') p.resolve();
    else p.reject(new Error(ev.data.message));
  };
  worker.onerror = (ev) => {
    for (const p of pending.values()) p.reject(new Error(ev.message || 'OPFS worker crashed'));
    pending.clear();
  };
  const call = (msg: OpfsCommand): Promise<void> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...msg, id } as OpfsRequest);
    });

  const stagedName = `${Date.now()}-${randomId()}`;
  try {
    await withTimeout(call({ type: 'open', dir: OPFS_DIR, name: stagedName }), 5000, 'OPFS did not open');
  } catch (err) {
    worker.terminate();
    throw err;
  }

  const writable = new WritableStream<Uint8Array>({
    write: (chunk) => call({ type: 'write', chunk }),
    async close() {
      await call({ type: 'close' });
      worker.terminate();
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(OPFS_DIR);
      const file = await (await dir.getFileHandle(stagedName)).getFile();
      // The File is disk-backed, so this doesn't pull it into memory.
      triggerDownload(mime ? new File([file], name, { type: mime }) : file, name);
    },
    async abort() {
      await call({ type: 'abort' }).catch(() => undefined);
      worker.terminate();
    },
  });
  return { kind: 'opfs', writable };
}

/** Remove staged OPFS downloads left over from earlier visits. */
export async function cleanUpStagedDownloads(maxAgeMs = 60 * 60 * 1000): Promise<void> {
  if (typeof navigator.storage?.getDirectory !== 'function') return;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(OPFS_DIR);
    const iterable = dir as unknown as AsyncIterable<[string, FileSystemHandle]>;
    for await (const [entryName] of iterable) {
      const created = Number(entryName.split('-')[0]);
      if (Number.isFinite(created) && Date.now() - created > maxAgeMs) {
        await dir.removeEntry(entryName).catch(() => undefined);
      }
    }
  } catch {
    // No staging directory yet, or OPFS unavailable (e.g. private browsing).
  }
}

// ─── 4. In-memory Blob ─────────────────────────────────────────────────────

function openMemorySink(name: string, mime: string): Sink {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      parts.push(chunk as Uint8Array<ArrayBuffer>);
    },
    close() {
      triggerDownload(new Blob(parts, { type: mime || 'application/octet-stream' }), name);
      parts.length = 0;
    },
    abort() {
      parts.length = 0;
    },
  });
  return { kind: 'memory', writable };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

export function triggerDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the download manager plenty of time to start reading before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
