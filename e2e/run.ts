/**
 * End-to-end tests: real browsers, real WebRTC, real signaling server.
 *
 *   npm run build && npm run test:e2e
 *
 * Starts the production server (serving client/dist) on a free port, then
 * drives headless Chromium through every receive path. Set CHROMIUM_PATH to
 * use a specific browser binary; E2E_BIG_MB to change the large-file size.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type JsQR from 'jsqr';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright-core';
import { PNG } from 'pngjs';

// jsqr is CommonJS whose module.exports is the function itself.
const jsQR = createRequire(import.meta.url)('jsqr') as typeof JsQR.default;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'e2e/output');
const FIXTURES = path.join(OUT, 'fixtures');
const BIG_MB = Number(process.env.E2E_BIG_MB ?? 256);

interface Result {
  name: string;
  ok: boolean;
  ms: number;
  err?: unknown;
}

type Sink = 'memory' | 'service-worker' | 'opfs' | 'file-system-access';

/** Test-only globals installed with addInitScript. */
type TestWindow = Window & {
  __channels: RTCDataChannel[];
  showSaveFilePicker: (opts: { suggestedName: string }) => Promise<FileSystemFileHandle>;
};

const results: Result[] = [];
let server: ChildProcess | undefined;
let browser: Browser | undefined;
let base = '';

// ─── Helpers ────────────────────────────────────────────────────────────────

function findChromium(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'];
  return candidates.find((p) => existsSync(p)); // undefined → playwright's own download, if any
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(): Promise<{ proc: ChildProcess; base: string }> {
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, 'server/dist/index.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', HOST_GRACE_SECONDS: '2' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 10_000);
    proc.stdout.on('data', (d: Buffer) => {
      if (String(d).includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.stderr.on('data', (d: Buffer) => process.stderr.write(`[server] ${String(d)}`));
    proc.on('exit', (code) => reject(new Error(`server exited with ${String(code)}`)));
  });
  return { proc, base: `http://127.0.0.1:${port}` };
}

async function fixture(name: string, bytes: number): Promise<string> {
  const p = path.join(FIXTURES, name);
  if (bytes <= 64 * 1024 * 1024) {
    writeFileSync(p, randomBytes(bytes));
    return p;
  }
  // Stream big fixtures to disk instead of allocating them.
  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(p);
    let left = bytes;
    const write = (): void => {
      while (left > 0) {
        const n = Math.min(left, 8 * 1024 * 1024);
        left -= n;
        if (!ws.write(randomBytes(n))) {
          ws.once('drain', write);
          return;
        }
      }
      ws.end(resolve);
    };
    ws.on('error', reject);
    write();
  });
  return p;
}

function sha256File(p: string): string {
  const h = createHash('sha256');
  h.update(readFileSync(p));
  return h.digest('hex');
}

async function newPage(opts: BrowserContextOptions = {}): Promise<Page> {
  const context = await browser!.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, ...opts });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`  [console.error] ${m.text()}`);
  });
  return page;
}

async function host(files: string[]): Promise<{ page: Page; url: string }> {
  const page = await newPage();
  await page.goto(base);
  await page.setInputFiles('[data-testid=file-input]', files);
  await page.waitForSelector('[data-testid=share-url]');
  const url = await page.getAttribute('[data-testid=share-url]', 'href');
  if (!url) throw new Error('no share link');
  return { page, url };
}

/** Open the link, click Download, wait for Done. Returns the saved file path (or null for FS Access). */
async function receive(
  url: string,
  sink: Sink,
  { page, beforeDone }: { page?: Page; beforeDone?: (page: Page) => Promise<void> } = {},
): Promise<{ page: Page; file: string | null; suggested: string | null }> {
  page ??= await newPage();
  await page.goto(`${url}?sink=${sink}`);
  await page.waitForSelector('[data-testid=download]', { timeout: 30_000 });
  const download = sink === 'file-system-access' ? null : page.waitForEvent('download', { timeout: 120_000 });
  await page.click('[data-testid=download]');
  if (beforeDone) await beforeDone(page);
  await page.waitForSelector('[data-testid=receive-done]', { timeout: 300_000 });
  const dl = download ? await download : null;
  return { page, file: dl ? await dl.path() : null, suggested: dl?.suggestedFilename() ?? null };
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`✓ ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - t0, err });
    console.log(`✗ ${name}\n    ${err instanceof Error ? err.stack : String(err)}`);
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(FIXTURES, { recursive: true });
  if (!existsSync(path.join(ROOT, 'server/dist/index.js')) || !existsSync(path.join(ROOT, 'client/dist/index.html'))) {
    throw new Error('Build first: npm run build');
  }
  ({ proc: server, base } = await startServer());
  browser = await chromium.launch({ executablePath: findChromium() });
  console.log(`server ${base} · chromium ${browser.version()}`);

  const small = await fixture('small.bin', 3 * 1024 * 1024 + 17);
  const smallHash = sha256File(small);

  await test('short link, QR code decodes to the plain https/http URL, ≤ 15 stars', async () => {
    const { page, url } = await host([small]);
    assert(/^http:\/\/127\.0\.0\.1:\d+\/[23456789a-hjkmnp-z]{5}$/.test(url), `unexpected link ${url}`);
    const png = PNG.sync.read(await page.locator('svg.qr').screenshot());
    const qr = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    assert(qr?.data === url, `QR decoded to ${qr?.data}, expected ${url}`);
    const stars = Number(await page.getAttribute('[data-testid=ascii-bg]', 'data-stars'));
    assert(stars >= 1 && stars <= 15, `star count ${stars}`);
    await page.screenshot({ path: path.join(OUT, 'sender.png') });
    await page.context().close();
  });

  for (const sink of ['memory', 'service-worker', 'opfs'] as const) {
    await test(`single file via ${sink} sink, SHA-256 verified`, async () => {
      const { page: sender, url } = await host([small]);
      const { page, file, suggested } = await receive(url, sink);
      assert(suggested === 'small.bin', `download name ${suggested}`);
      assert(file && sha256File(file) === smallHash, 'downloaded bytes differ from the original');
      await sender.waitForSelector('[data-testid=receiver-row][data-status=done]');
      if (sink === 'service-worker') await page.screenshot({ path: path.join(OUT, 'receiver-done.png') });
      await page.context().close();
      await sender.context().close();
    });
  }

  await test('single file via File System Access (showSaveFilePicker) sink', async () => {
    const { page: sender, url } = await host([small]);
    const page = await newPage();
    // Headless Chromium can't show a picker; hand back an OPFS file handle instead.
    await page.addInitScript(() => {
      (window as unknown as TestWindow).showSaveFilePicker = async ({ suggestedName }) => {
        const root = await navigator.storage.getDirectory();
        return root.getFileHandle(`fsa-${suggestedName}`, { create: true });
      };
    });
    await receive(url, 'file-system-access', { page });
    const hex = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const file = await (await root.getFileHandle('fsa-small.bin')).getFile();
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    });
    assert(hex === smallHash, 'file written via File System Access differs');
    await page.context().close();
    await sender.context().close();
  });

  await test('multiple files are zipped on the fly (duplicate names, empty file)', async () => {
    const dir = path.join(FIXTURES, 'multi');
    mkdirSync(path.join(dir, 'x'), { recursive: true });
    const a = path.join(dir, 'a.txt');
    const b = path.join(dir, 'x', 'a.txt');
    const empty = path.join(dir, 'empty.dat');
    writeFileSync(a, 'hello from a\n');
    writeFileSync(b, randomBytes(700_000));
    writeFileSync(empty, '');
    const { page: sender, url } = await host([a, b, empty, small]);
    const { page, file, suggested } = await receive(url, 'service-worker');
    assert(file && /^pizzadrop-[a-z0-9]{5}\.zip$/.test(suggested ?? ''), `zip name ${suggested}`);
    const listing = execFileSync('python3', [
      '-c',
      `import zipfile,hashlib,sys,json
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
print(json.dumps({i.filename: hashlib.sha256(z.read(i)).hexdigest() for i in z.infolist()}))`,
      file,
    ]).toString();
    const entries = JSON.parse(listing) as Record<string, string>;
    const expected = {
      'a.txt': sha256File(a),
      'a (1).txt': sha256File(b),
      'empty.dat': sha256File(empty),
      'small.bin': smallHash,
    };
    assert(JSON.stringify(entries) === JSON.stringify(expected), `zip entries ${listing}`);
    await page.context().close();
    await sender.context().close();
  });

  await test('two receivers download at the same time', async () => {
    const { page: sender, url } = await host([small]);
    const [r1, r2] = await Promise.all([receive(url, 'service-worker'), receive(url, 'memory')]);
    assert(
      r1.file && r2.file && sha256File(r1.file) === smallHash && sha256File(r2.file) === smallHash,
      'a receiver got bad bytes',
    );
    await sender.waitForFunction(
      () => document.querySelectorAll('[data-testid=receiver-row][data-status=done]').length === 2,
    );
    await r1.page.context().close();
    await r2.page.context().close();
    await sender.context().close();
  });

  const big = await fixture('big.bin', BIG_MB * 1024 * 1024);
  const bigHash = sha256File(big);

  await test(`${BIG_MB} MB file survives a dropped connection mid-transfer and resumes`, async () => {
    const { page: sender, url } = await host([big]);
    const page = await newPage();
    await page.addInitScript(() => {
      const w = window as unknown as TestWindow;
      const Original = window.RTCPeerConnection;
      w.__channels = [];
      window.RTCPeerConnection = class extends Original {
        constructor(config?: RTCConfiguration) {
          super(config);
          this.addEventListener('datachannel', (e) => w.__channels.push(e.channel));
        }
      };
    });
    let sawReconnect = false;
    const t0 = Date.now();
    const { file } = await receive(url, 'service-worker', {
      page,
      beforeDone: async (p) => {
        await p.waitForFunction(
          () => Number(document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow') ?? 0) >= 20,
          undefined,
          { timeout: 120_000, polling: 20 },
        );
        await p.evaluate(() => (window as unknown as TestWindow).__channels.at(-1)?.close());
        await p.waitForSelector('[data-testid=receive-card][data-status=reconnecting]', { timeout: 10_000 });
        sawReconnect = true;
      },
    });
    const secs = (Date.now() - t0) / 1000;
    console.log(`    ${BIG_MB} MB in ${secs.toFixed(1)} s (${(BIG_MB / secs).toFixed(1)} MB/s incl. reconnect)`);
    assert(sawReconnect, 'never showed the reconnecting state');
    assert(file && sha256File(file) === bigHash, 'resumed download differs from the original');
    await page.context().close();
    await sender.context().close();
  });

  await test('unknown / expired links say so', async () => {
    const page = await newPage();
    await page.goto(`${base}/zzzzz`);
    await page.waitForSelector('[data-testid=receive-error][data-kind=not-found]', { timeout: 15_000 });
    await page.context().close();
  });

  await test('sender tab: beforeunload guard, and closing it releases the code', async () => {
    const { page: sender, url } = await host([small]);
    await sender.click('.card__title'); // Chrome only shows beforeunload after a user gesture
    let prompted = false;
    sender.on('dialog', async (d) => {
      if (d.type() === 'beforeunload') prompted = true;
      await d.accept();
    });
    await sender.close({ runBeforeUnload: true });
    for (let i = 0; i < 50 && !prompted; i++) await new Promise((r) => setTimeout(r, 100));
    assert(prompted, 'no beforeunload prompt while hosting');
    await new Promise((r) => setTimeout(r, 500));
    const page = await newPage();
    await page.goto(url);
    await page.waitForSelector('[data-testid=receive-error][data-kind=not-found]', { timeout: 15_000 });
    await page.context().close();
  });

  await test('prefers-reduced-motion renders a static slice', async () => {
    const page = await newPage({ reducedMotion: 'reduce' });
    await page.goto(base);
    await page.waitForTimeout(500);
    const a = await page.locator('[data-testid=ascii-bg]').screenshot();
    await page.waitForTimeout(700);
    const b = await page.locator('[data-testid=ascii-bg]').screenshot();
    assert(a.equals(b), 'the background changed between frames with reduced motion on');
    const moving = await newPage();
    await moving.goto(base);
    await moving.waitForTimeout(500);
    const c = await moving.locator('[data-testid=ascii-bg]').screenshot();
    await moving.waitForTimeout(700);
    const d = await moving.locator('[data-testid=ascii-bg]').screenshot();
    assert(!c.equals(d), 'the background should animate by default');
    await page.context().close();
    await moving.context().close();
  });

  await test('mobile layout renders (390×844 @3x)', async () => {
    const page = await newPage({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    await page.goto(base);
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, 'mobile-home.png') });
    await page.setInputFiles('[data-testid=file-input]', [small]);
    await page.waitForSelector('[data-testid=share-url]');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'mobile-hosting.png'), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 0, `horizontal overflow of ${overflow}px`);
    await page.context().close();
  });
}

main()
  .catch((err: unknown) => {
    console.error(err);
    results.push({ name: 'setup', ok: false, ms: 0, err });
  })
  .finally(async () => {
    await browser?.close().catch(() => undefined);
    server?.kill();
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots in e2e/output/.`);
    rmSync(FIXTURES, { recursive: true, force: true });
    process.exit(failed.length ? 1 : 0);
  });
