import { defineConfig } from 'vite';
import { versionDefines } from './scripts/build-version.mjs';
import { resolve, dirname, basename } from 'path';
import { readFileSync } from 'fs';

// Library build only: Vite inlines every asset as base64 in lib mode, which
// put the 510 kB aw-dsp WASM into the bundle three times (?url import plus
// both copies of the inline worker). Emit it once as a real file instead and
// resolve it at runtime next to the bundle.
const WASM_PREFIX = '\0wasm-file:';
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
            const name = basename(file);
            this.emitFile({ type: 'asset', fileName: name, source: readFileSync(file) });
            // Non-literal URL argument so Vite's import.meta.url asset plugin
            // leaves it alone. ESM: import.meta.url; IIFE: the <script> src,
            // captured by output.intro while the bundle is evaluated synchronously.
            return `
const base = (typeof globalThis !== 'undefined' && globalThis.__SIGNAVIS_SCRIPT_SRC__) || import.meta.url;
const override = typeof globalThis !== 'undefined' && globalThis.SIGNAVIS_WASM_URL;
export default override || new URL(${JSON.stringify('./' + name)} + '', base).href;
`;
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

export default defineConfig({
  plugins: [wasmAsFile(), dropWbgDefaultUrl()],
  worker: { plugins: () => [dropWbgDefaultUrl()] },
  define: versionDefines(),
    server: {
        // Cargo build dirs churn (and lock .exe files on Windows → EBUSY crash).
        watch: { ignored: ['**/src-tauri/**/target/**', '**/src-tauri/crates/*/pkg/**'] },
    },
    build: {
        lib: {
            entry: resolve(__dirname, 'src/app/BirdNETPlayer.ts'),
            name: 'BirdNETPlayerModule',
            formats: ['es', 'iife'],
            fileName: (format) => {
                if (format === 'es')   return 'birdnet-player.esm.js';
                if (format === 'iife') return 'birdnet-player.iife.js';
                return `birdnet-player.${format}.js`;
            },
            cssFileName: 'birdnet-player',
        },
        outDir: 'dist',
        emptyOutDir: true,
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
                // IIFE has no import.meta.url: remember the <script> src for
                // locating aw_dsp_wasm_bg.wasm (null for ES modules, harmless).
                intro: "if (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) globalThis.__SIGNAVIS_SCRIPT_SRC__ = document.currentScript.src;",
            },
        },
        target: 'es2020',
        minify: true,
        sourcemap: true,
    },
});
