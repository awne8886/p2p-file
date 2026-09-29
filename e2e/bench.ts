/**
 * Throughput benchmark: one sender, one receiver, one big file, no faults.
 *
 *   npm run build && npm run bench -- [MB=512] [sink=service-worker]
 *
 * Reports wall-clock throughput, peak browser memory, and the CPU time all
 * browser processes spent per GB moved (Linux only), which is the better yardstick on a shared or
 * CPU-starved machine: WebRTC's own SCTP/DTLS stack is often the ceiling there,
 * so less CPU per byte shows up as speed on real hardware and battery on phones.
 * STATIC_DIR serves a different client build, e.g. to compare two versions;
 * BENCH_STATIC_ART=1 turns the background animation off (reduced motion).
 */
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MB = Number(process.argv[2] ?? 512);
const SINK = process.argv[3] ?? 'service-worker';
const file = path.join(ROOT, 'e2e/output/bench.bin');
mkdirSync(path.dirname(file), { recursive: true });

/** Every running Chromium process's /proc directory. */
function chromeProcs(): string[] {
  return readdirSync('/proc')
    .filter((d) => /^\d+$/.test(d))
    .filter((pid) => {
      try {
        return /chrom/i.test(readFileSync(`/proc/${pid}/comm`, 'utf8'));
      } catch {
        return false; // exited
      }
    })
    .map((pid) => `/proc/${pid}`);
}

/** CPU seconds used so far by every running Chromium process. */
function chromeCpuSeconds(): number {
  let ticks = 0;
  for (const dir of chromeProcs()) {
    try {
      const stat = readFileSync(`${dir}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      ticks += Number(fields[11]) + Number(fields[12]); // utime + stime
    } catch {
      // exited
    }
  }
  return ticks / 100;
}

/** Resident memory of every Chromium process, summed (shared pages are counted once per process), in MB. */
function chromeRssMB(): number {
  let kb = 0;
  for (const dir of chromeProcs()) {
    try {
      kb += Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`${dir}/status`, 'utf8'))?.[1] ?? 0);
    } catch {
      // exited
    }
  }
  return kb / 1024;
}

const port = await new Promise<number>((r) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = (s.address() as net.AddressInfo).port;
    s.close(() => r(p));
  });
});
await new Promise<void>((resolve, reject) => {
  const ws = createWriteStream(file);
  let left = MB;
  const w = () => {
    while (left > 0) {
      left--;
      if (!ws.write(randomBytes(1024 * 1024))) return void ws.once('drain', w);
    }
    ws.end(resolve);
  };
  ws.on('error', reject);
  w();
});
const proc = spawn(process.execPath, [path.join(ROOT, 'server/dist/index.js')], {
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise<void>((r) => proc.stdout!.on('data', (d: Buffer) => String(d).includes('listening') && r()));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
console.log(
  `chromium ${browser.version()} · ${MB} MB · sink ${SINK}${process.env.BENCH_STATIC_ART ? ' · static art' : ''}`,
);
const base = `http://127.0.0.1:${port}`;
const contextOptions = process.env.BENCH_STATIC_ART ? { reducedMotion: 'reduce' as const } : {};
const s = await (await browser.newContext(contextOptions)).newPage();
await s.goto(base);
await s.setInputFiles('[data-testid=file-input]', [file]);
await s.waitForSelector('[data-testid=share-url]');
const url = await s.getAttribute('[data-testid=share-url]', 'href');
const r = await (await browser.newContext({ ...contextOptions, acceptDownloads: true })).newPage();
await r.goto(`${url}?sink=${SINK}`);
await r.waitForSelector('[data-testid=download]');
const cpu0 = chromeCpuSeconds();
const rss: number[] = [chromeRssMB()];
const sampler = setInterval(() => rss.push(chromeRssMB()), 1000);
const t0 = Date.now();
await r.click('[data-testid=download]');
// The in-memory sink asks before buffering more than 500 MB.
const confirm = r.getByRole('button', { name: 'download anyway' });
if (SINK === 'memory' && MB > 476) await confirm.click();
await r.waitForSelector('[data-testid=receive-done]', { timeout: 600_000 });
const dt = (Date.now() - t0) / 1000;
const cpu = chromeCpuSeconds() - cpu0;
clearInterval(sampler);
console.log(
  `${MB} MB via ${SINK}: ${dt.toFixed(1)} s = ${(MB / dt).toFixed(1)} MB/s · ` +
    `browser CPU ${cpu.toFixed(1)} s (${((cpu / MB) * 1024).toFixed(1)} CPU-s per GB) · ` +
    `browser memory ${Math.round(rss[0]!)} MB at the start, ${Math.round(Math.max(...rss))} MB peak`,
);
await browser.close();
proc.kill();
