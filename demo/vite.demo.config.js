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
import { cpSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { createHash } from 'crypto';

/** Rollup plugin that copies static asset directories into the build output. */
function copyStaticPlugin(pairs) {
  return {
    name: 'copy-static',
    closeBundle() {
      for (const { src, dest } of pairs) {
        cpSync(src, dest, { recursive: true });
      }
    },
  };
}

/**
 * Vite plugin: content-hash the BirdNET taxonomy JSON for long-term caching.
 * - In build: rewrites fetch URLs in HTML, copies hashed file to output.
 * - In dev: no-op (original filename works via dev server).
 */
function taxonomyHashPlugin() {
  const ORIGINAL = 'birdnet-taxonomy.v2.4.json';
  const taxonomySrc = resolve(__dirname, 'data', ORIGINAL);
  let isBuild = false;
  let hashedName = '';

  return {
    name: 'taxonomy-hash',
    configResolved(config) {
      isBuild = config.command === 'build';
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (!isBuild || !existsSync(taxonomySrc)) return html;
        if (!hashedName) {
          const content = readFileSync(taxonomySrc);
          const hash = createHash('md5').update(content).digest('hex').slice(0, 8);
          hashedName = ORIGINAL.replace('.json', `.${hash}.json`);
        }
        return html.replaceAll(ORIGINAL, hashedName);
      },
    },
    closeBundle() {
      if (!hashedName || !existsSync(taxonomySrc)) return;
      const outDir = resolve(__dirname, '..', '_site', 'demo', 'data');
      mkdirSync(outDir, { recursive: true });
      cpSync(taxonomySrc, resolve(outDir, hashedName));
    },
  };
}

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
        desktop:   resolve(__dirname, '..', 'demo', 'desktop-app.html'),
      },
    },
  },
  plugins: [
    taxonomyHashPlugin(),
    copyStaticPlugin([
      {
        src:  resolve(__dirname, '..', 'models'),
        dest: resolve(__dirname, '..', '_site', 'models'),
      },
    ]),
  ],
  // Copy sample audio files into the output
  publicDir: false,
});
