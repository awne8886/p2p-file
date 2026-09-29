import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const SIGNAL_TARGET = process.env.SIGNAL_TARGET ?? 'http://localhost:8080';

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
  plugins: [react(), devServiceWorkerScope()],
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
