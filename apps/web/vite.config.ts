import { defineConfig, type Plugin, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { studio2dRuntimePlugin } from './src/studio2d/build/runtime-plugin.mjs';

// Clean routes in dev. In production the server maps these paths to studio2d.html itself.
const PAGES: Record<string, string> = {
  '/': '/studio2d.html',
  '/2d': '/studio2d.html',
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
  plugins: [react() as unknown as PluginOption, cleanRoutes(), studio2dRuntimePlugin() as unknown as PluginOption],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: 'http://127.0.0.1:7700', changeOrigin: false },
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
        studio2d: 'studio2d.html',
      },
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) return 'react';
          return undefined;
        },
      },
    },
  },
});
