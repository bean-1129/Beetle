import { defineConfig, type Plugin, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';

// Clean routes in dev. In production the server maps these paths to the html files itself.
const PAGES: Record<string, string> = {
  '/director': '/director.html',
  '/play': '/play.html',
  '/controller': '/controller.html',
};

function cleanRoutes(): Plugin {
  return {
    name: 'beetle-clean-routes',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url ?? '';
        const q = url.indexOf('?');
        const path = q >= 0 ? url.slice(0, q) : url;
        const target = PAGES[path];
        if (target) req.url = target + (q >= 0 ? url.slice(q) : '');
        next();
      });
    },
  };
}

export default defineConfig({
  base: '/',
  // apps/web resolves its own vite copy; the react plugin is typed against the root copy, so cast once.
  plugins: [react() as unknown as PluginOption, cleanRoutes()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: 'http://127.0.0.1:7700', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:7700', ws: true, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: {
        index: 'index.html',
        director: 'director.html',
        play: 'play.html',
        controller: 'controller.html',
      },
      output: {
        manualChunks(id) {
          // keep Babylon's lazily imported shader modules as their own small chunks
          if (id.includes('node_modules/@babylonjs/') && !id.includes('/Shaders/') && !id.includes('/ShadersWGSL/')) return 'babylon';
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) return 'react';
          if (id.includes('node_modules/zod')) return 'zod';
          if (id.includes('node_modules/qrcode')) return 'qrcode';
          return undefined;
        },
      },
    },
  },
});
