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
    initSync, WasmEngine, WasmPyramidBuilder, WasmStft, WasmPyramidBuilderV2,
    decodeF16, wavInfo, wavChannel0,
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
const FORMAT_VERSION = 2;     // aw_dsp::pyramid::FORMAT_VERSION (v1 engine)
const FORMAT_VERSION_V2 = 3;  // aw_dsp::pyramid::FORMAT_VERSION_V2

/** v2 params (aw_dsp::v2::StftParams) are recognised by `winLen`. */
const isV2 = (p: any) => p && typeof p.winLen === 'number';

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
    let engine: WasmEngine | WasmStft | null = null;
    let engineKey = '';
    port.onmessage = (e: MessageEvent) => {
        const { id, paramsJson, samples } = e.data;
        const v2 = e.data.v2 === true;
        if (paramsJson !== engineKey) {
            engine?.free();
            engine = v2 ? new WasmStft(paramsJson) : new WasmEngine(paramsJson);
            engineKey = paramsJson;
        }
        const data = v2
            ? (engine as WasmStft).blockValues(samples as Float32Array, e.data.first, e.data.f0, e.data.n, e.data.total)
            : (engine as WasmEngine).blockValues(samples as Float32Array, e.data.warmup, e.data.nFrames);
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
    /** `args` is engine-specific (see startCompute). */
    const computeBlock = (paramsJson: string, samples: Float32Array, args: Record<string, unknown>) =>
        new Promise<Float32Array>((resolve) => {
            const id = nextId++;
            pending.set(id, resolve);
            ports[rr++ % ports.length].postMessage({ id, paramsJson, samples, ...args }, [samples.buffer]);
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
            } else if (msg.type === 'compute') {
                const r = computeAll(msg.samples as Float32Array, msg.sampleRate, msg.params);
                const done = await r;
                ctx.postMessage({ type: 'computed', requestId: msg.requestId, ...done }, [done.data.buffer]);
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

    async function tryOpenCached(key: string, version: number): Promise<Store | null> {
        if (!opfsAvailable()) return null;
        try {
            const dir = await storeDir(key, false);
            const meta = JSON.parse(await (await (await dir.getFileHandle('meta.json')).getFile()).text());
            if (meta.version !== version) return null;
            return { key, meta, bins: meta.bins, handles: await openHandles(dir, meta.levels.length, false) };
        } catch {
            return null;
        }
    }

    async function open(file: File, params: any, key: string, blockFrames: number) {
        const v2 = isV2(params);
        const cached = await tryOpenCached(key, v2 ? FORMAT_VERSION_V2 : FORMAT_VERSION);
        if (cached) { store = cached; return { meta: cached.meta, fromCache: true, persistent: true }; }

        const wav: WavMeta = JSON.parse(wavInfo(new Uint8Array(await file.slice(0, 1 << 16).arrayBuffer())));
        const p = v2 ? v2ForSampleRate(params, wav.sampleRate) : { ...params, sampleRate: wav.sampleRate };
        const paramsJson = JSON.stringify(p);
        const engine = v2 ? new WasmStft(paramsJson) : new WasmEngine(paramsJson);
        const builder = v2 ? new WasmPyramidBuilderV2(paramsJson, wav.nSamples) : new WasmPyramidBuilder(paramsJson, wav.nSamples);
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

        // Samples [s0, s0 + ns), clamped to the file.
        const readSamples = async (s0: number, ns: number) => {
            const a = Math.max(0, Math.min(s0, wav.nSamples));
            const b = Math.max(a, Math.min(s0 + ns, wav.nSamples));
            const start = wav.dataOffset + a * blockAlign;
            const bytes = new Uint8Array(await file.slice(start, start + (b - a) * blockAlign).arrayBuffer());
            return wavChannel0(bytes, wav.channels, wav.bitsPerSample, wav.float);
        };
        // Reads the samples for output frames [f0, f0 + n) and hands them to a
        // compute worker; wrapped so awaiting the read does not await the result.
        const startBlock = async (f0: number, n: number): Promise<{ result: Promise<Float32Array> }> => {
            if (v2) {
                const stft = engine as WasmStft;
                const [lo, hi] = stft.blockFrameRange(f0, n, total);
                const [start, len] = stft.sampleRange(lo, hi - lo);
                const first = Math.max(0, start);
                const samples = await readSamples(first, start + len - first);
                return { result: computeBlock(paramsJson, samples, { v2: true, first, f0, n, total }) };
            }
            const v1 = engine as WasmEngine;
            const w = Math.min(v1.pcenWarmup(), f0);
            const samples = await readSamples((f0 - w) * p.hopSize, v1.samplesForFrames(w + n));
            return { result: computeBlock(paramsJson, samples, { warmup: w, nFrames: n }) };
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
                    tm = performance.now();
                    inFlight.push((await startBlock(nextF0, n)).result);
                    timing.read += performance.now() - tm;
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

    /** Whole in-memory signal with the v2 engine, blocks spread over all
     *  compute workers (no pyramid, no cache). */
    async function computeAll(samples: Float32Array, sampleRate: number, params: any) {
        const p = v2ForSampleRate(params, sampleRate);
        const paramsJson = JSON.stringify(p);
        const stft = new WasmStft(paramsJson);
        try {
            const bins = stft.outBins();
            const total = stft.nFrames(samples.length);
            const data = new Float32Array(total * bins);
            const per = Math.max(256, Math.ceil(total / (ports.length * 2)));
            const jobs: Promise<void>[] = [];
            for (let f0 = 0; f0 < total; f0 += per) {
                const n = Math.min(per, total - f0);
                const [lo, hi] = stft.blockFrameRange(f0, n, total);
                const [start, len] = stft.sampleRange(lo, hi - lo);
                const first = Math.max(0, start);
                const slice = samples.slice(first, Math.max(first, Math.min(samples.length, start + len)));
                jobs.push(computeBlock(paramsJson, slice, { v2: true, first, f0, n, total })
                    .then((d) => data.set(d, f0 * bins)));
            }
            await Promise.all(jobs);
            return { data, nFrames: total, bins, hop: p.hop as number, winLen: p.winLen as number };
        } finally {
            stft.free();
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

/** Fills sample-rate dependent fields of v2 params (band f_max 0 → Nyquist,
 *  PCEN given as per-frame smoothing → time constant). */
function v2ForSampleRate(params: any, sampleRate: number) {
    const p = { ...params, sampleRate };
    if (p.scale?.kind !== 'linear' && !(p.scale.fMax > 0)) p.scale = { ...p.scale, fMax: sampleRate / 2 };
    if (p.pcen && p.pcen.smoothing > 0 && !(p.pcen.timeConstant > 0)) {
        // One-pole smoother with coefficient s has time constant ≈ hop / (sr · s).
        const { smoothing, ...rest } = p.pcen;
        p.pcen = { ...rest, timeConstant: p.hop / (sampleRate * smoothing) };
    }
    return p;
}
