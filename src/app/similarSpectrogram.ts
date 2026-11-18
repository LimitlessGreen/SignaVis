// app/similarSpectrogram.ts — band spectrogram of a whole recording for "find similar calls"
//
// Same STFT as the benchmark (scripts/similar/similar-benchmark.py): window ≈ 16 ms
// (512 at 32 kHz), no zero padding, hop = window / 4, dB; each row's median over the
// recording is subtracted (the band floor), like snap. Only rows inside [loHz, hiHz]
// are kept; frames are computed in blocks so a long recording never needs the full matrix.

import { wasmMain } from '../infrastructure/wasm-dsp/wasmMain.ts';
import { channelData } from '../shared/utils.ts';
import { bandSpectrogramOf, type BandOptions } from './similarBand.ts';
import type { CallPatch } from '../domain/similar/cluster.ts';
import { createSearch, type CallTemplate, type BandSpectrogram, type Box, type FindOptions, type SearchState, type SimilarHit } from '../domain/similar/ncc.ts';

const WINDOW_SECONDS = 0.016;
export type { BandOptions } from './similarBand.ts';

/** Spectrogram rows covering loHz..hiHz of the whole recording, or null before aw-dsp is ready / when cancelled. */
export async function bandSpectrogram(audio: AudioBuffer, loHz: number, hiHz: number, opts: BandOptions = {}): Promise<BandSpectrogram | null> {
    const wasm = wasmMain();
    if (!wasm) return null;
    const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => channelData(audio, c));
    return bandSpectrogramOf(wasm, channels, audio.length, audio.sampleRate, loHz, hiHz, opts);
}

// ── Search session off the main thread ────────────────────────────
// find() once, then decide() per accepted / rejected hit for new ranks. The worker keeps the
// spectrogram; where workers are unavailable (Node tests) everything runs in place.

let _ctor: any;
async function workerCtor() {
    if (_ctor !== undefined) return _ctor;
    try { _ctor = (await import('../infrastructure/similar.worker.ts?worker&inline')).default; } catch { _ctor = null; }
    return _ctor;
}

export class SimilarSession {
    private worker: Worker | null = null;
    private local: SearchState | null = null;
    private seq = 0;
    private disposed = false;
    private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

    private call(msg: any, transfer: Transferable[] = []): Promise<any> {
        const id = ++this.seq;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.worker!.postMessage({ ...msg, id }, transfer);
        });
    }

    /** Hits for `exemplar`, best first. `spec` is consumed. */
    async find(spec: BandSpectrogram, exemplar: Box | { template: CallTemplate }, opts: FindOptions = {}): Promise<SimilarHit[]> {
        const Ctor = await workerCtor();
        if (this.disposed) throw new Error('search closed');   // closed while the worker module loaded
        if (!Ctor) { this.local = createSearch(spec, exemplar, opts); return this.local.hits; }
        this.start(Ctor);
        return (await this.call({ type: 'find', spec, exemplar, opts }, [spec.values.buffer])).hits;
    }

    /**
     * Hits for `exemplar` in loHz..hiHz of `audio`; the spectrogram is computed in the worker too,
     * so a long recording does not stall the page. null: aw-dsp not ready or recording too short.
     */
    async findInAudio(audio: AudioBuffer, loHz: number, hiHz: number, exemplar: Box | { template: CallTemplate },
        opts: FindOptions = {}): Promise<SimilarHit[] | null> {
        const Ctor = await workerCtor();
        let module: WebAssembly.Module | null = null;
        if (Ctor) {
            try { module = await (await import('../infrastructure/wasm-dsp/WasmSpectrogramService.ts')).compileWasmModule(); } catch { module = null; }
        }
        if (this.disposed) throw new Error('search closed');
        if (!Ctor || !module) {
            const spec = await bandSpectrogram(audio, loHz, hiHz, { yieldEvery: () => new Promise((r) => setTimeout(r, 0)), cancelled: () => this.disposed });
            if (!spec || this.disposed) return null;
            this.local = createSearch(spec, exemplar, opts);
            return this.local.hits;
        }
        this.start(Ctor);
        // Channels are copied (structured clone): the AudioBuffer keeps its own
        const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => channelData(audio, c));
        const r = await this.call({ type: 'findAudio', module, channels, length: audio.length, sampleRate: audio.sampleRate, loHz, hiHz, exemplar, opts });
        return r.hits ?? null;
    }

    private start(Ctor: any) {
        this.worker = new Ctor();
        this.worker!.onmessage = (e: MessageEvent) => {
            const p = this.pending.get(e.data.id);
            if (!p) return;
            this.pending.delete(e.data.id);
            if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data);
        };
        this.worker!.onerror = (e: ErrorEvent) => {
            for (const p of this.pending.values()) p.reject(new Error(e.message || 'similar worker failed'));
            this.pending.clear();
        };
    }

    /** Record a decision on hit i (`moved`: box centre corrected by dt s / df Hz); ranks of all hits (decided ones −Infinity). */
    async decide(i: number, accepted: boolean, moved?: { dt: number; df: number }): Promise<Float64Array> {
        if (this.local) return this.local.reranker.decide(i, accepted, moved);
        if (!this.worker) throw new Error('no search');
        return (await this.call({ type: 'decide', i, accepted, moved })).ranks;
    }

    dispose() {
        this.disposed = true;
        this.worker?.terminate();
        this.worker = null;
        this.local = null;
        for (const p of this.pending.values()) p.reject(new Error('search closed'));
        this.pending.clear();
    }
}

// ── Call patches for the overview (domain/similar/cluster.ts) ─────
// Same STFT as above, computed around each box only: ±0.5 s for the floor (row median of
// that window), then the box's band (±1 bin) and duration (±2 frames).

const FLOOR_PAD_S = 0.5;

/** One patch per box (null where the box is empty or outside the recording); null before aw-dsp is ready. */
export async function callPatches(audio: AudioBuffer, boxes: Box[], opts: BandOptions = {}): Promise<(CallPatch | null)[] | null> {
    const wasm = wasmMain();
    if (!wasm) return null;
    const sr = audio.sampleRate;
    const winLen = 2 ** Math.round(Math.log2(sr * WINDOW_SECONDS));
    const hop = winLen / 4;
    const params = { winLen, hop, nFft: winLen, window: { kind: 'hann' }, scale: { kind: 'linear' },
        pcen: null, reassign: false, output: 'db', sampleRate: sr };
    const stft = new wasm.WasmStft(JSON.stringify(params));
    const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => channelData(audio, c));
    try {
        const total = stft.nFrames(audio.length), bins = stft.outBins(), freqs = stft.binFrequencies();
        const df = freqs.length > 1 ? freqs[1] - freqs[0] : sr / winLen, dt = hop / sr;
        const out: (CallPatch | null)[] = [];
        for (const [k, b] of boxes.entries()) {
            if (opts.cancelled?.()) return null;
            const f0 = Math.max(0, Math.floor((b.start - FLOOR_PAD_S) / dt));
            const n = Math.min(total - f0, Math.ceil((b.end - b.start + 2 * FLOOR_PAD_S) / dt) + 1);
            if (n < 3 || b.end <= b.start || b.freqMax <= b.freqMin) { out.push(null); continue; }
            const [lo, hi] = stft.blockFrameRange(f0, n, total);
            const [start, len] = stft.sampleRange(lo, hi - lo);
            const first = Math.max(0, start), last = Math.min(audio.length, start + len);
            const mono = new Float32Array(Math.max(0, last - first));
            for (const ch of channels) for (let i = 0; i < mono.length; i++) mono[i] += ch[first + i] / channels.length;
            const block = stft.blockValues(mono, first, f0, n, total);   // n × bins
            const r0 = Math.max(0, Math.floor((b.freqMin - freqs[0]) / df) - 1);
            const r1 = Math.min(bins, Math.ceil((b.freqMax - freqs[0]) / df) + 2);
            const c0 = Math.max(0, Math.floor(b.start / dt) - 2 - f0), c1 = Math.min(n, Math.floor(b.end / dt) + 3 - f0);
            const rows = r1 - r0, cols = c1 - c0;
            if (rows < 2 || cols < 2) { out.push(null); continue; }
            const values = new Float32Array(rows * cols), col = new Float32Array(n);
            for (let r = 0; r < rows; r++) {
                for (let f = 0; f < n; f++) col[f] = block[f * bins + r0 + r];
                col.sort();
                const floor = col[n >> 1];
                for (let c = 0; c < cols; c++) values[r * cols + c] = block[(c0 + c) * bins + r0 + r] - floor;
            }
            out.push({ values, rows, cols, duration: b.end - b.start, centreHz: (b.freqMin + b.freqMax) / 2 });
            if (k % 25 === 24) await opts.yieldEvery?.();
        }
        return out;
    } finally { stft.free(); }
}
