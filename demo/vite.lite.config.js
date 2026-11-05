/**
 * Vite config for the SignaVis Lite desktop app (src-tauri-lite).
 *
 * Usage:  npx vite build --config demo/vite.lite.config.js
 *
 * Builds only the labeling app (plus the Phase-0 webview probe) into
 * _site-lite/, with the taxonomy, models, species images and the libraries
 * the web app takes from CDNs (vendor/, see runtime.ts vendorUrl) bundled,
 * so the app works offline and under a strict CSP.
 */
import { defineConfig } from 'vite';
import { versionDefines, getBuildVersion } from '../scripts/build-version.mjs';
import { resolve } from 'path';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, '_site-lite');

// Taxonomy + species images are generated (npm run taxonomy:build), not in git.
// A shipped Lite needs them; the webview probe workflow does not.
const DATA_OPTIONAL = process.env.SIGNAVIS_LITE_DATA_OPTIONAL === '1';

function copyStatic(pairs) {
  return {
    name: 'copy-static',
    closeBundle() {
      for (const [src, dest, optional] of pairs) {
        if (!existsSync(src)) {
          if (optional && DATA_OPTIONAL) { console.warn(`[copy-static] skipping missing ${src}`); continue; }
          throw new Error(`[copy-static] missing: ${src} (generated data: run \`npm run taxonomy:build\`)`);
        }
        mkdirSync(resolve(dest, '..'), { recursive: true });
        cpSync(src, dest, { recursive: true });
      }
    },
  };
}

/** Same footer info the Pages workflow writes to _site/version.json. */
function versionJson() {
  return {
    name: 'version-json',
    closeBundle() {
      const git = (cmd) => { try { return execSync(`git ${cmd}`, { cwd: root }).toString().trim(); } catch { return ''; } };
      const info = {
        version: getBuildVersion().label,
        commit: git('rev-parse --short HEAD'),
        commitFull: git('rev-parse HEAD'),
        commitDate: git('show -s --format=%cI HEAD'),
        builtAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      };
      // The footer probes ./version.json relative to the page first.
      for (const dir of [out, resolve(out, 'demo')]) writeFileSync(resolve(dir, 'version.json'), `${JSON.stringify(info)}\n`);
    },
  };
}

const nm = (p) => resolve(root, 'node_modules', p);

/** vendor/<name>/… is served from these package folders (dev) and copied from them (build). */
const VENDOR = {
  wavesurfer: { dir: nm('wavesurfer.js/dist'), files: ['wavesurfer.esm.js'] },
  leaflet:    { dir: nm('leaflet/dist'), files: ['leaflet.js', 'leaflet.css', 'images'] },
  tfjs:       { dir: nm('@tensorflow/tfjs/dist'), files: ['tf.min.js'] },
};

/** Dev server (`tauri dev` of Lite): answer /vendor/<name>/<file> from node_modules. */
function serveVendor() {
  return {
    name: 'serve-vendor',
    configureServer(server) {
      server.middlewares.use('/favicon.ico', (req, res) => {
        res.setHeader('Content-Type', 'image/x-icon');
        res.end(readFileSync(resolve(root, 'src-tauri-lite', 'icons', 'icon.ico')));
      });
      server.middlewares.use('/vendor', (req, res, next) => {
        const [, name, ...rest] = decodeURIComponent((req.url || '').split('?')[0]).split('/');
        const entry = VENDOR[name];
        const file = entry && resolve(entry.dir, ...rest);
        if (!file || !file.startsWith(entry.dir) || !existsSync(file)) return next();
        const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/javascript';
        res.setHeader('Content-Type', type);
        res.end(readFileSync(file));
      });
    },
  };
}

const vendorCopies = Object.entries(VENDOR).flatMap(([name, { dir, files }]) =>
  files.map((f) => [resolve(dir, f), resolve(out, 'vendor', name, f)]));

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
    serveVendor(),
    versionJson(),
    copyStatic([
      ...vendorCopies,
      [resolve(root, 'src-tauri-lite', 'icons', 'icon.ico'), resolve(out, 'favicon.ico')],
      [resolve(root, 'models'), resolve(out, 'models')],
      [resolve(root, 'demo', 'data', 'birdnet-taxonomy.v2.4.json'), resolve(out, 'demo', 'data', 'birdnet-taxonomy.v2.4.json'), true],
      [resolve(root, 'demo', 'data', 'species_images'), resolve(out, 'demo', 'data', 'species_images'), true],
    ]),
  ],
  // Dev: same watch exclusions as vite.config.js (cargo target dirs lock files on Windows).
  server: {
    port: 5173,
    strictPort: true,
    watch: { ignored: ['**/src-tauri*/**/target/**', '**/src-tauri/crates/*/pkg/**', '**/_site*/**'] },
  },
  publicDir: false,
});
