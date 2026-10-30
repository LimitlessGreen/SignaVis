// ═══════════════════════════════════════════════════════════════════════
// wasm-spectrogram.worker.ts — WASM spectrogram for long recordings
//
// One script, two roles (set by the first 'init' message):
//   compute — band energies for independent blocks (runs N×, parallel)
//   coord   — reads the WAV File in slices, fans blocks out to compute
//             workers via MessagePorts, finalizes PCEN in order, writes the
//             multi-level pyramid to OPFS and serves tile reads.
//
// No SharedArrayBuffer needed → works on plain static hosting.
// Store format is identical to the native Tauri store (aw-dsp/pyramid.rs).
// ═══════════════════════════════════════════════════════════════════════

import {
    initSync, WasmEngine, WasmPyramidBuilder, decodeF16, wavInfo, wavChannel0,
} from './pkg/aw_dsp_wasm.js';

// OPFS sync access handles are worker-only and missing from the DOM lib.
interface FileSystemSyncAccessHandle {
    read(buf: Uint8Array, opts?: { at: number }): number;
    write(buf: Uint8Array, opts?: { at: number }): number;
    truncate(size: number): void;
    flush(): void;
    close(): void;
}
declare global {
    interface FileSystemFileHandle { createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle> }
}

const STORE_ROOT = 'aw-spectrograms';
const FORMAT_VERSION = 2;

type Ctx = { postMessage(msg: any, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null };
const ctx = self as unknown as Ctx;

ctx.onmessage = (e: MessageEvent) => {
    const msg = e.data;
    if (msg.type !== 'init') return;
    initSync({ module: msg.module as WebAssembly.Module | ArrayBuffer });
    if (msg.role === 'compute') startCompute(msg.port as MessagePort);
    else startCoordinator(msg.ports as MessagePort[]);
};

// ── compute role ─────────────────────────────────────────────────────

function startCompute(port: MessagePort) {
    let engine: WasmEngine | null = null;
    let engineKey = '';
    port.onmessage = (e: MessageEvent) => {
        const { id, paramsJson, samples, warmup, nFrames } = e.data;
        if (paramsJson !== engineKey) {
            engine?.free();
            engine = new WasmEngine(paramsJson);
            engineKey = paramsJson;
        }
        const data = engine!.blockValues(samples as Float32Array, warmup, nFrames);
        port.postMessage({ id, data }, [data.buffer]);
    };
}

// ── coordinator role ─────────────────────────────────────────────────

interface WavMeta { sampleRate: number; channels: number; bitsPerSample: number; float: boolean; dataOffset: number; nSamples: number }

/** Subset of FileSystemSyncAccessHandle used for level files. */
type LevelFile = Pick<FileSystemSyncAccessHandle, 'read' | 'write' | 'flush' | 'close'>;

/** In-memory level file for browsers without OPFS sync handles (no caching). */
class MemLevelFile implements LevelFile {
    private buf = new Uint8Array(1 << 20);
    private size = 0;
    write(bytes: Uint8Array, opts?: { at: number }) {
        const at = opts?.at ?? this.size;
        if (at + bytes.length > this.buf.length) {
            const grown = new Uint8Array(Math.max(at + bytes.length, this.buf.length * 2));
            grown.set(this.buf.subarray(0, this.size));
            this.buf = grown;
        }
        this.buf.set(bytes, at);
        this.size = Math.max(this.size, at + bytes.length);
        return bytes.length;
    }
    read(out: Uint8Array, opts?: { at: number }) {
        const at = opts?.at ?? 0;
        const n = Math.max(0, Math.min(out.length, this.size - at));
        out.set(this.buf.subarray(at, at + n));
        return n;
    }
    flush() { /* nothing to persist */ }
    close() { this.buf = new Uint8Array(0); this.size = 0; }
}

const opfsAvailable = () =>
    typeof navigator.storage?.getDirectory === 'function'
    && typeof (globalThis as any).FileSystemFileHandle?.prototype?.createSyncAccessHandle === 'function';

interface Store {
    key: string;
    meta: any;
    bins: number;
    handles: LevelFile[];
}

function startCoordinator(ports: MessagePort[]) {
    const pending = new Map<number, (data: Float32Array) => void>();
    let nextId = 0;
    let rr = 0;
    for (const p of ports) {
        p.onmessage = (e: MessageEvent) => {
            const cb = pending.get(e.data.id);
            pending.delete(e.data.id);
            cb?.(e.data.data);
        };
    }
    const computeBlock = (paramsJson: string, samples: Float32Array, warmup: number, nFrames: number) =>
        new Promise<Float32Array>((resolve) => {
            const id = nextId++;
            pending.set(id, resolve);
            ports[rr++ % ports.length].postMessage({ id, paramsJson, samples, warmup, nFrames }, [samples.buffer]);
        });

    let store: Store | null = null;
    let cancelled = false;

    const closeStore = () => {
        if (!store) return;
        for (const h of store.handles) { try { h.close(); } catch { /* already closed */ } }
        store = null;
    };

    ctx.onmessage = async (e: MessageEvent) => {
        const msg = e.data;
        try {
            if (msg.type === 'open') {
                cancelled = false;
                closeStore();
                const r = await open(msg.file, msg.params, msg.key, msg.blockFrames ?? 6000);
                ctx.postMessage({ type: 'opened', requestId: msg.requestId, meta: r.meta, fromCache: r.fromCache, persistent: r.persistent });
            } else if (msg.type === 'tile') {
                const data = readTile(msg.level, msg.f0, msg.f1);
                ctx.postMessage({ type: 'tile', requestId: msg.requestId, data }, [data.buffer]);
            } else if (msg.type === 'cancel') {
                cancelled = true;
            } else if (msg.type === 'close') {
                closeStore();
            }
        } catch (err: any) {
            ctx.postMessage({ type: 'error', requestId: msg.requestId, message: err?.message || String(err) });
        }
    };

    async function storeDir(key: string, create: boolean) {
        const root = await navigator.storage.getDirectory();
        const base = await root.getDirectoryHandle(STORE_ROOT, { create: true });
        return base.getDirectoryHandle(key, { create });
    }

    async function openHandles(dir: FileSystemDirectoryHandle, n: number, create: boolean) {
        const handles: FileSystemSyncAccessHandle[] = [];
        for (let k = 0; k < n; k++) {
            const fh = await dir.getFileHandle(`L${k}.f16`, { create });
            handles.push(await fh.createSyncAccessHandle());
        }
        return handles;
    }

    async function tryOpenCached(key: string): Promise<Store | null> {
        if (!opfsAvailable()) return null;
        try {
            const dir = await storeDir(key, false);
            const meta = JSON.parse(await (await (await dir.getFileHandle('meta.json')).getFile()).text());
            if (meta.version !== FORMAT_VERSION) return null;
            return { key, meta, bins: meta.bins, handles: await openHandles(dir, meta.levels.length, false) };
        } catch {
            return null;
        }
    }

    async function open(file: File, params: any, key: string, blockFrames: number) {
        const cached = await tryOpenCached(key);
        if (cached) { store = cached; return { meta: cached.meta, fromCache: true, persistent: true }; }

        const wav: WavMeta = JSON.parse(wavInfo(new Uint8Array(await file.slice(0, 1 << 16).arrayBuffer())));
        const p = { ...params, sampleRate: wav.sampleRate };
        const paramsJson = JSON.stringify(p);
        const engine = new WasmEngine(paramsJson);
        const builder = new WasmPyramidBuilder(paramsJson, wav.nSamples);
        const nLevels = builder.nLevels();
        const bins = engine.outBins();
        const total = engine.nFrames(wav.nSamples);
        const blockAlign = wav.channels * wav.bitsPerSample / 8;

        const persistent = opfsAvailable();
        let base: FileSystemDirectoryHandle | null = null;
        let dir: FileSystemDirectoryHandle | null = null;
        let handles: LevelFile[];
        if (persistent) {
            base = await (await navigator.storage.getDirectory()).getDirectoryHandle(STORE_ROOT, { create: true });
            try { await base.removeEntry(key, { recursive: true }); } catch { /* not present */ }
            dir = await base.getDirectoryHandle(key, { create: true });
            handles = await openHandles(dir, nLevels, true);
        } else {
            handles = Array.from({ length: nLevels }, () => new MemLevelFile());
        }
        const offsets = new Array(nLevels).fill(0);

        const warmupFrames = engine.pcenWarmup();
        // Samples for frames [f0, f0 + n); the caller includes warm-up in f0/n.
        const readBlock = async (f0: number, n: number) => {
            const s0 = f0 * p.hopSize;
            const ns = Math.min(engine.samplesForFrames(n), Math.max(0, wav.nSamples - s0));
            const start = wav.dataOffset + s0 * blockAlign;
            const bytes = new Uint8Array(await file.slice(start, start + ns * blockAlign).arrayBuffer());
            return wavChannel0(bytes, wav.channels, wav.bitsPerSample, wav.float);
        };
        const drain = () => {
            for (let k = 0; k < nLevels; k++) {
                const bytes = builder.takeLevel(k);
                if (bytes.length) offsets[k] += handles[k].write(bytes, { at: offsets[k] });
            }
        };

        try {
            // Keep 2 blocks in flight per compute worker; finalize strictly in order.
            const inFlight: Promise<Float32Array>[] = [];
            const maxInFlight = ports.length * 2;
            let nextF0 = 0;
            let done = 0;
            const t0 = performance.now();
            const timing = { read: 0, wait: 0, store: 0 };
            let tm = 0;
            while (done < total) {
                while (nextF0 < total && inFlight.length < maxInFlight) {
                    const n = Math.min(blockFrames, total - nextF0);
                    const w = Math.min(warmupFrames, nextF0);
                    tm = performance.now();
                    const samples = await readBlock(nextF0 - w, w + n);
                    timing.read += performance.now() - tm;
                    inFlight.push(computeBlock(paramsJson, samples, w, n));
                    nextF0 += n;
                }
                tm = performance.now();
                const data = await inFlight.shift()!;
                timing.wait += performance.now() - tm;
                if (cancelled) throw new Error('cancelled');
                tm = performance.now();
                builder.pushBlock(data);
                drain();
                timing.store += performance.now() - tm;
                done += data.length / bins;
                ctx.postMessage({ type: 'progress', fraction: done / total, elapsedMs: performance.now() - t0, timing });
            }
            const meta = JSON.parse(builder.finish());
            drain();
            for (const h of handles) h.flush();

            store = { key, meta, bins, handles };
            if (!dir) return { meta, fromCache: false, persistent: false };

            // meta.json last: its presence marks a complete store.
            const mh = await (await dir.getFileHandle('meta.json', { create: true })).createSyncAccessHandle();
            const json = new TextEncoder().encode(JSON.stringify(meta));
            mh.truncate(0);
            mh.write(json, { at: 0 });
            mh.flush();
            mh.close();

            return { meta, fromCache: false, persistent: true };
        } catch (err) {
            for (const h of handles) { try { h.close(); } catch { /* ignore */ } }
            try { await base?.removeEntry(key, { recursive: true }); } catch { /* ignore */ }
            throw err;
        } finally {
            engine.free();
            builder.free();
        }
    }

    function readTile(level: number, f0: number, f1: number): Float32Array {
        if (!store) throw new Error('no spectrogram open');
        const lm = store.meta.levels[level];
        if (!lm) throw new Error(`no level ${level}`);
        const a = Math.max(0, Math.min(f0, lm.nFrames));
        const b = Math.max(a, Math.min(f1, lm.nFrames));
        const bytes = new Uint8Array((b - a) * store.bins * 2);
        store.handles[level].read(bytes, { at: a * store.bins * 2 });
        return decodeF16(bytes);
    }
}
