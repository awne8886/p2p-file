/**
 * `npm run dev`: builds the shared package once, then runs — with prefixed,
 * coloured output — the shared package in watch mode, the signaling server
 * (tsx watch, port 8080) and the Vite dev server (port 5173, which proxies
 * /ws to the signaling server). Open http://localhost:5173.
 *
 * Extra arguments go to Vite, e.g. `npm run dev -- --host` to test from a
 * phone on the same network.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const build = spawnSync(npx, ['tsc', '-p', 'shared/tsconfig.json'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

const tasks: Array<{ name: string; color: number; args: string[]; env?: Record<string, string> }> = [
  { name: 'shared', color: 35, args: ['tsc', '-p', 'shared/tsconfig.json', '--watch', '--preserveWatchOutput'] },
  {
    name: 'server',
    color: 36,
    args: ['tsx', 'watch', '--clear-screen=false', 'server/src/index.ts'],
    env: { STATIC_DIR: '' },
  },
  {
    name: 'client',
    color: 33,
    args: ['vite', '--config', 'client/vite.config.ts', 'client', ...process.argv.slice(2)],
  },
];

const children: ChildProcess[] = tasks.map(({ name, color, args, env }) => {
  const child = spawn(npx, args, {
    env: { ...process.env, FORCE_COLOR: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = `\x1b[${color}m${name.padEnd(6)}\x1b[0m │ `;
  const pipe = (stream: NodeJS.ReadableStream, out: NodeJS.WriteStream) => {
    let buf = '';
    stream.on('data', (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout!, process.stdout);
  pipe(child.stderr!, process.stderr);
  child.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`${prefix}exited with ${String(code)}`);
      shutdown(code ?? 1);
    }
  });
  return child;
});

let shuttingDown = false;
function shutdown(code = 0): void {
  shuttingDown = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
