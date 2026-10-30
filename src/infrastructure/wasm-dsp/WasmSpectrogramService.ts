// ═══════════════════════════════════════════════════════════════════════
// WasmSpectrogramService.ts — main-thread facade for the WASM pipeline
//
//   const svc = await WasmSpectrogramService.create();
//   const { meta } = await svc.open(file, params, (f) => …progress…);
//   const values = await svc.tile(level, f0, f1);   // Float32Array
//
// Spawns 1 coordinator + N compute workers wired via MessageChannels.
// Results are cached in OPFS keyed by file identity + DSP params.
// ═══════════════════════════════════════════════════════════════════════

import WorkerCtor from './wasm-spectrogram.worker.ts?worker&inline';
import wasmUrl from './pkg/aw_dsp_wasm_bg.wasm?url';
import { initWasmMain } from './wasmMain.ts';

/** Mirrors aw_dsp::v2::StftParams. `sampleRate` comes from the file; band
 *  `fMax` 0 → Nyquist and PCEN `smoothing` (per frame) → time constant are
 *  resolved in the worker once the sample rate is known. */
export interface StftParamsV2 {
    winLen: number;
    hop: number;
    nFft: number;
    window: { kind: 'hann' | 'hamming' | 'blackman' | 'blackmanHarris' } | { kind: 'kaiser'; beta: number };
    scale: { kind: 'linear' } | { kind: 'mel' | 'log'; bands: number; fMin: number; fMax: number };
    pcen: { gain: number; bias: number; power: number; eps: number; timeConstant?: number; smoothing?: number } | null;
    reassign: boolean;
    /** Cell values (aw_dsp::v2::Output); absent → 'db'. */
    output?: V2Output;
}

export type V2Output = 'db' | 'magnitude' | 'phase';

export interface PyramidStats {
    min: number; max: number; p2: number; p98: number;
    /** Robust noise floor and near-peak level. */
    median: number; p999: number;
    /** Per-band noise floor (median per row, low → high). */
    bandFloor: number[];
}

export interface PyramidMeta {
    version: number;
    params: StftParamsV2 & { sampleRate: number };
    nSamples: number;
    bins: number;
    /** `stats` per level: max-pooled levels need their own contrast range. */
    levels: { factor: number; nFrames: number; stats: PyramidStats }[];
    /** Same as levels[0].stats. */
    stats: PyramidStats;
}

let modulePromise: Promise<WebAssembly.Module> | null = null;

function compileModule(): Promise<WebAssembly.Module> {
    modulePromise ??= WebAssembly.compileStreaming(fetch(wasmUrl))
        .catch(async () => WebAssembly.compile(await (await fetch(wasmUrl)).arrayBuffer()));
    return modulePromise;
}

/** Initialises the main-thread instance (wasmMain) without starting workers. */
export async function loadWasmMain(): Promise<void> {
    initWasmMain(await compileModule());
}

export class WasmSpectrogramService {
    private coord: Worker;
    private computes: Worker[];
    private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    private nextId = 0;
    private onProgress: ((fraction: number, elapsedMs: number) => void) | null = null;
    /** Diagnostics: cumulative coordinator time per stage (ms). */
    onTiming: ((timing: Record<string, number>) => void) | null = null;

    /**
     * WAV input (non-WAV files are passed in as a decoded-PCM WAV `source`). Results are cached in OPFS when available; without OPFS the
     * pyramid is kept in worker memory (`persistent: false`, no cache).
     */
    static isSupported(): boolean {
        return typeof WebAssembly !== 'undefined' && typeof Worker !== 'undefined';
    }

    static async create(
        nWorkers = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)),
        { shareModule = true }: { shareModule?: boolean } = {},
    ) {
        if (!shareModule) {
            // Diagnostics: every worker compiles its own copy from bytes.
            const bytes = await (await fetch(wasmUrl)).arrayBuffer();
            return new WasmSpectrogramService(bytes, nWorkers);
        }
        const module = await compileModule();
        initWasmMain(module);
        return new WasmSpectrogramService(module, nWorkers);
    }

    private constructor(module: WebAssembly.Module | ArrayBuffer, nWorkers: number) {
        this.coord = new WorkerCtor();
        this.computes = [];
        const ports: MessagePort[] = [];
        for (let i = 0; i < nWorkers; i++) {
            const w = new WorkerCtor();
            const ch = new MessageChannel();
            w.postMessage({ type: 'init', role: 'compute', module, port: ch.port1 }, [ch.port1]);
            ports.push(ch.port2);
            this.computes.push(w);
        }
        this.coord.postMessage({ type: 'init', role: 'coord', module, ports }, ports);
        this.coord.onmessage = (e) => this.handle(e.data);
        this.coord.onerror = (e) => this.failAll(new Error(e.message || 'spectrogram worker failed'));
    }

    get workerCount() { return this.computes.length; }

    private handle(msg: any) {
        if (msg.type === 'progress') {
            this.onProgress?.(msg.fraction, msg.elapsedMs);
            this.onTiming?.(msg.timing);
            return;
        }
        const p = this.pending.get(msg.requestId);
        if (!p) return;
        this.pending.delete(msg.requestId);
        if (msg.type === 'error') p.reject(new Error(msg.message));
        else p.resolve(msg);
    }

    private failAll(err: Error) {
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
    }

    private request<T>(msg: any): Promise<T> {
        const requestId = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(requestId, { resolve, reject });
            this.coord.postMessage({ ...msg, requestId });
        });
    }

    /** `source` (a WAV blob) is what gets read; `file` only identifies the cache entry. */
    async open(file: File, params: StftParamsV2, onProgress?: (fraction: number, elapsedMs: number) => void,
               source: Blob = file) {
        this.onProgress = onProgress ?? null;
        const key = await storeKey(file, params, source === file ? '' : `pcm:${source.size}`);
        const r = await this.request<{ meta: PyramidMeta; fromCache: boolean; persistent: boolean }>(
            { type: 'open', file: source, params, key });
        this.onProgress = null;
        return { meta: r.meta, fromCache: r.fromCache, persistent: r.persistent, key };
    }

    /**
     * Whole spectrogram of in-memory samples with the v2 engine, computed in
     * parallel blocks (no pyramid, no cache). Row-major [frame][bin].
     */
    async compute(samples: Float32Array, sampleRate: number, params: StftParamsV2) {
        const copy = samples.slice();
        const requestId = this.nextId++;
        return new Promise<{ data: Float32Array; nFrames: number; bins: number; hop: number; winLen: number; bandFloor: Float32Array }>((resolve, reject) => {
            this.pending.set(requestId, { resolve, reject });
            this.coord.postMessage({ type: 'compute', requestId, samples: copy, sampleRate, params }, [copy.buffer]);
        });
    }

    /** Frames [f0, f1) of `level`, row-major [frame][bin]. */
    async tile(level: number, f0: number, f1: number): Promise<Float32Array> {
        const r = await this.request<{ data: Float32Array }>({ type: 'tile', level, f0, f1 });
        return r.data;
    }

    cancel() { this.coord.postMessage({ type: 'cancel' }); }

    dispose() {
        this.failAll(new Error('disposed'));
        this.coord.terminate();
        for (const w of this.computes) w.terminate();
    }
}

async function storeKey(file: File, params: StftParamsV2, variant = ''): Promise<string> {
    const id = `${file.name}|${file.size}|${file.lastModified}|${JSON.stringify(params)}|${variant}|v2`;
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
    return Array.from(new Uint8Array(hash).slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}
