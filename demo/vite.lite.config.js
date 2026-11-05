/**
 * Vite config for the SignaVis Lite desktop app (src-tauri-lite).
 *
 * Usage:  npx vite build --config demo/vite.lite.config.js
 *
 * Builds only the labeling app (plus the Phase-0 webview probe) into
 * _site-lite/, with the taxonomy, models and species images bundled so
 * the app works offline.
 */
import { defineConfig } from 'vite';
import { versionDefines } from '../scripts/build-version.mjs';
import { resolve } from 'path';
import { cpSync, existsSync } from 'fs';

const root = resolve(__dirname, '..');
const out = resolve(root, '_site-lite');

function copyStatic(pairs) {
  return {
    name: 'copy-static',
    closeBundle() {
      for (const [src, dest] of pairs) {
        if (existsSync(src)) cpSync(src, dest, { recursive: true });
        else console.warn(`[copy-static] Source not found, skipping: ${src}`);
      }
    },
  };
}

export default defineConfig({
  define: versionDefines(),
  root,
  base: './',
  build: {
    outDir: out,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        labeling: resolve(root, 'demo', 'labeling-app.html'),
        probe:    resolve(root, 'demo', 'lite-probe.html'),
      },
    },
  },
  plugins: [
    copyStatic([
      [resolve(root, 'models'), resolve(out, 'models')],
      [resolve(root, 'demo', 'data', 'birdnet-taxonomy.v2.4.json'), resolve(out, 'demo', 'data', 'birdnet-taxonomy.v2.4.json')],
      [resolve(root, 'demo', 'data', 'species_images'), resolve(out, 'demo', 'data', 'species_images')],
    ]),
  ],
  publicDir: false,
});
