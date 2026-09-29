import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const SIGNAL_TARGET = process.env.SIGNAL_TARGET ?? 'http://localhost:8080';

/**
 * Path the app is served under: `/` normally, `/<repo>/` for a GitHub Pages
 * project site. Share links, the service worker and every asset URL follow it.
 */
function basePath(): string {
  const raw = process.env.BASE_PATH?.trim();
  if (!raw) return '/';
  return `/${raw.replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');
}

/**
 * The same Content-Security-Policy the Node server sends as a header, as a
 * <meta> tag so static hosts (GitHub Pages, Cloudflare Pages) get it too.
 * `frame-ancestors` only works as a header, so it isn't repeated here.
 */
const CSP = [
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
].join('; ');

const cspMeta = (): Plugin => ({
  name: 'pizzadrop:csp-meta',
  apply: 'build',
  transformIndexHtml: () => [
    { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' },
  ],
});

/** In dev the service worker is served from /src/sw/; let it control the whole origin (prod serves /sw.js). */
const devServiceWorkerScope = (): Plugin => ({
  name: 'pizzadrop:dev-sw-scope',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url?.startsWith('/src/sw/sw.ts')) res.setHeader('Service-Worker-Allowed', '/');
      next();
    });
  },
});

export default defineConfig({
  base: basePath(),
  plugins: [react(), devServiceWorkerScope(), cspMeta()],
  resolve: {
    alias: {
      '@pizzadrop/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: SIGNAL_TARGET, ws: true },
      '/healthz': { target: SIGNAL_TARGET },
    },
  },
  worker: {
    format: 'es',
  },
  build: {
    outDir: process.env.OUT_DIR || 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        // Built to a fixed, unhashed /sw.js so its scope covers the whole origin.
        sw: fileURLToPath(new URL('./src/sw/sw.ts', import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
