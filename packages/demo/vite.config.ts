import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

const ROOT = import.meta.dirname;
const NM = resolve(ROOT, 'node_modules');

/**
 * Serves proxy/scramjet assets from node_modules and local files.
 */
const serveAssets = (): Plugin => {
  const ASSETS: { path: string; absPath: string }[] = [
    // SW — served from project root
    { path: '/sw.js', absPath: resolve(ROOT, 'sw.js') },
    // SW controller (loaded via importScripts by sw.js)
    {
      path: '/controller.sw.js',
      absPath: resolve(NM, '@mercuryworkshop/scramjet-controller/dist/controller.sw.js'),
    },
    // Main-thread controller (loaded as global script by main.ts)
    {
      path: '/controller/controller.api.js',
      absPath: resolve(NM, '@mercuryworkshop/scramjet-controller/dist/controller.api.js'),
    },
    {
      path: '/controller/controller.inject.js',
      absPath: resolve(NM, '@mercuryworkshop/scramjet-controller/dist/controller.inject.js'),
    },
    // Scramjet engine (loaded as global script by index.html)
    {
      path: '/scramjet/scramjet.js',
      absPath: resolve(NM, '@mercuryworkshop/scramjet/dist/scramjet.js'),
    },
    {
      path: '/scramjet/scramjet.wasm',
      absPath: resolve(NM, '@mercuryworkshop/scramjet/dist/scramjet.wasm'),
    },
  ];

  return {
    name: 'pulsar-demo-assets',

    configureServer(server) {
      for (const asset of ASSETS) {
        server.middlewares.use(asset.path, async (_req, res, next) => {
          try {
            const content = await readFile(asset.absPath);
            const ext = asset.path.split('.').pop();
            const mimes: Record<string, string> = {
              js: 'application/javascript',
              wasm: 'application/wasm',
            };
            res.setHeader('Content-Type', mimes[ext ?? ''] ?? 'application/octet-stream');
            // Cross-origin isolation needed by Scramjet
            res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
            res.end(content);
          } catch {
            next();
          }
        });
      }
    },

    async buildStart() {
      // Only emit assets in production build, not in serve mode
      if (this.meta.watchMode) return;
      for (const asset of ASSETS) {
        this.emitFile({
          type: 'asset',
          fileName: asset.path.replace(/^\//, ''),
          source: await readFile(asset.absPath),
        });
      }
    },
  };
};

export default defineConfig({
  base: '',
  build: {
    target: 'es2025',
  },
  plugins: [serveAssets()],
});
