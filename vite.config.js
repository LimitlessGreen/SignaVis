import { defineConfig } from 'vite';
import { versionDefines } from './scripts/build-version.mjs';
import { resolve, dirname } from 'path';
import { readFileSync } from 'fs';
import { PACKAGE_ENTRIES } from './scripts/package-entries.mjs';

// Library build only: Vite inlines every asset as base64 in lib mode, which
// put the 510 kB aw-dsp WASM into the bundle three times (?url import plus
// both copies of the inline worker). Emit it once as a real file instead and
// resolve it at runtime next to the bundle.
const WASM_PREFIX = '\0wasm-file:';
const WASM_FILE = 'aw_dsp_wasm_bg.wasm';
const WASM_URL_PLACEHOLDER = '__SIGNAVIS_WASM_URL_PLACEHOLDER__';
const IIFE_INTRO = "var __signavisScriptSrc = typeof document !== 'undefined' && document.currentScript && document.currentScript.src || '';";
function wasmAsFile() {
    return {
        name: 'signavis:wasm-as-file',
        enforce: 'pre',
        apply: 'build',
        resolveId(id, importer) {
            if (id.endsWith('.wasm?url') && importer) {
                return WASM_PREFIX + resolve(dirname(importer), id.slice(0, -4));
            }
        },
        load(id) {
            if (!id.startsWith(WASM_PREFIX)) return;
            const file = id.slice(WASM_PREFIX.length);
            this.emitFile({ type: 'asset', fileName: WASM_FILE, source: readFileSync(file) });
            // Placeholder, filled per output format in renderChunk (the asset
            // plugin would otherwise inline a literal new URL(…) again).
            return `
const override = typeof globalThis !== 'undefined' && globalThis.SIGNAVIS_WASM_URL;
export default override || ${WASM_URL_PLACEHOLDER};
`;
        },
        renderChunk(code, _chunk, outputOptions) {
            if (outputOptions.format === 'es' && code.includes(IIFE_INTRO)) {
                code = code.replace(IIFE_INTRO, ''); // output.intro is shared by both formats
                if (!code.includes(WASM_URL_PLACEHOLDER)) return { code, map: null };
            }
            if (!code.includes(WASM_URL_PLACEHOLDER)) return null;
            // ESM: a literal new URL('./x.wasm', import.meta.url), so bundlers
            // of consuming apps (Vite, webpack 5, Rollup) detect and copy it.
            // IIFE: no import.meta — resolve against the <script> src that
            // output.intro captured into a variable local to this bundle.
            const url = outputOptions.format === 'es'
                ? `new URL('./${WASM_FILE}', import.meta.url).href`
                : `new URL('./${WASM_FILE}', __signavisScriptSrc || globalThis.location.href).href`;
            return { code: code.split(WASM_URL_PLACEHOLDER).join(url), map: null };
        },
    };
}

// The workers receive the compiled module via postMessage and never use the
// wasm-bindgen default loader; drop its URL so the WASM isn't inlined there.
function dropWbgDefaultUrl() {
    return {
        name: 'signavis:drop-wbg-default-url',
        apply: 'build',
        transform(code, id) {
            if (!id.includes('aw_dsp_wasm.js')) return;
            return {
                code: code.replace(
                    "new URL('aw_dsp_wasm_bg.wasm', import.meta.url)",
                    "(() => { throw new Error('aw-dsp: pass the compiled module to initSync'); })()",
                ),
                map: null,
            };
        },
    };
}

// Two passes (npm run build): ESM with one file per package entry and shared
// chunks, so hosts that import 'signavis/core' get only the core; then the IIFE
// (a single script, so a single entry) from the full index.
const ESM_ENTRIES = Object.fromEntries(
    Object.entries(PACKAGE_ENTRIES).map(([name, e]) => [name, resolve(__dirname, e.src)]),
);

export default defineConfig(({ mode }) => {
  const IIFE = mode === 'iife';
  return {
  plugins: [wasmAsFile(), dropWbgDefaultUrl()],
  worker: { plugins: () => [dropWbgDefaultUrl()] },
  define: versionDefines(),
    server: {
        // Cargo build dirs churn (and lock .exe files on Windows → EBUSY crash).
        watch: { ignored: ['**/src-tauri/**/target/**', '**/src-tauri/crates/*/pkg/**'] },
    },
    build: {
        lib: {
            entry: IIFE ? resolve(__dirname, 'src/index.ts') : ESM_ENTRIES,
            name: 'BirdNETPlayerModule',
            formats: IIFE ? ['iife'] : ['es'],
            fileName: (format, entryName) => {
                if (format === 'iife') return 'birdnet-player.iife.js';
                return `${entryName}.esm.js`;
            },
            cssFileName: 'birdnet-player',
        },
        outDir: 'dist',
        emptyOutDir: !IIFE,
        rollupOptions: {
            // WaveSurfer is loaded at runtime (CDN / global / option),
            // NOT bundled — mark as external if it ever shows up as import
            external: ['wavesurfer.js'],
            output: {
                globals: {
                    'wavesurfer.js': 'WaveSurfer',
                },
                // Ensure IIFE wraps exports on the right global
                exports: 'named',
                // The chunk shared by both ESM entries holds the player: name it so
                // (rolldown would call it after the core entry, next to tauri's core-*.js).
                chunkFileNames: (chunk) => (chunk.moduleIds.some((id) => id.includes('/src/app/BirdNETPlayer.ts'))
                    ? 'signavis-player-[hash].js' : '[name]-[hash].js'),
                // IIFE has no import.meta.url: remember this bundle's <script>
                // src (local to the bundle) for locating aw_dsp_wasm_bg.wasm.
                intro: (chunk) => (chunk.isEntry ? IIFE_INTRO : ''),
            },
        },
        target: 'es2020',
        minify: true,
        sourcemap: true,
    },
};
});
