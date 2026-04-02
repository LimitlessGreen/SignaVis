/**
 * Vite config for building the demo / storybook site (GitHub Pages).
 *
 * Usage:  npx vite build --config demo/vite.demo.config.js
 *
 * Produces a self-contained _site/ folder with both demo pages,
 * all JS/CSS bundled and the sample audio files copied over.
 */
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: resolve(__dirname, '..'),   // project root so ../src/ imports resolve
  base: './',                       // relative asset paths for any hosting prefix
  build: {
    outDir: '_site',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        storybook: resolve(__dirname, '..', 'demo', 'storybook.html'),
        index:     resolve(__dirname, '..', 'demo', 'index.html'),
        labeling:  resolve(__dirname, '..', 'demo', 'labeling-app.html'),
      },
    },
  },
  // Copy sample audio files into the output
  publicDir: false,
});
