// app/similarSpectrogram.ts — band spectrogram of a whole recording for "find similar calls"
//
// Same STFT as the benchmark (scripts/similar/similar-benchmark.py): window ≈ 16 ms
// (512 at 32 kHz), no zero padding, hop = window / 4, dB; each row's median over the
// recording is subtracted (the band floor), like snap. Only rows inside [loHz, hiHz]
// are kept; frames are computed in blocks so a long recording never needs the full matrix.

import { wasmMain } from '../infrastructure/wasm-dsp/wasmMain.ts';
import { channelData } from '../shared/utils.ts';
import { findSimilar, type BandSpectrogram, type Box, type FindOptions, type SimilarHit } from '../domain/similar/ncc.ts';

const WINDOW_SECONDS = 0.016;
const BLOCK_FRAMES = 4096;

export interface BandOptions {
    /** Called between blocks; return a promise to yield to the UI. */
    yieldEvery?: () => Promise<void> | void;
    /** Stops early when it returns true. */
    cancelled?: () => boolean;
}

/** Spectrogram rows covering loHz..hiHz of the whole recording, or null before aw-dsp is ready / when cancelled. */
export async function bandSpectrogram(audio: AudioBuffer, loHz: number, hiHz: number, opts: BandOptions = {}): Promise<BandSpectrogram | null> {
    const wasm = wasmMain();
    if (!wasm) return null;
    const sr = audio.sampleRate;
    const winLen = 2 ** Math.round(Math.log2(sr * WINDOW_SECONDS));
    const hop = winLen / 4;
    const params = { winLen, hop, nFft: winLen, window: { kind: 'hann' }, scale: { kind: 'linear' },
        pcen: null, reassign: false, output: 'db', sampleRate: sr };
    const stft = new wasm.WasmStft(JSON.stringify(params));
    try {
        const total = stft.nFrames(audio.length);
        const bins = stft.outBins();
        const freqs = stft.binFrequencies();
        const df = freqs.length > 1 ? freqs[1] - freqs[0] : sr / winLen;
        const b0 = Math.max(0, Math.floor((loHz - freqs[0]) / df));
        const b1 = Math.min(bins, Math.ceil((hiHz - freqs[0]) / df) + 1);
        const rows = Math.max(0, b1 - b0);
        if (!rows || total < 3) return null;
        const values = new Float32Array(rows * total);
        const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => channelData(audio, c));
        for (let f0 = 0; f0 < total; f0 += BLOCK_FRAMES) {
            if (opts.cancelled?.()) return null;
            const n = Math.min(BLOCK_FRAMES, total - f0);
            const [lo, hi] = stft.blockFrameRange(f0, n, total);
            const [start, len] = stft.sampleRange(lo, hi - lo);
            const first = Math.max(0, start), last = Math.min(audio.length, start + len);
            const mono = new Float32Array(Math.max(0, last - first));
            for (const ch of channels) for (let i = 0; i < mono.length; i++) mono[i] += ch[first + i] / channels.length;
            const block = stft.blockValues(mono, first, f0, n, total);   // n × bins, frame-major
            for (let f = 0; f < n; f++) {
                const src = f * bins;
                for (let r = 0; r < rows; r++) values[r * total + f0 + f] = block[src + b0 + r];
            }
            await opts.yieldEvery?.();
        }
        // Band floor: subtract each row's median
        const tmp = new Float32Array(total);
        for (let r = 0; r < rows; r++) {
            const row = values.subarray(r * total, (r + 1) * total);
            tmp.set(row); tmp.sort();
            const med = tmp[total >> 1];
            for (let j = 0; j < total; j++) row[j] -= med;
        }
        return { values, rows, frames: total, f0: freqs[0] + b0 * df, df, t0: 0, dt: hop / sr };
    } finally { stft.free(); }
}

// ── Correlation off the main thread ───────────────────────────────
let _ctor: any;
async function workerCtor() {
    if (_ctor !== undefined) return _ctor;
    try { _ctor = (await import('../infrastructure/similar.worker.ts?worker&inline')).default; } catch { _ctor = null; }
    return _ctor;
}

/** findSimilar in a worker (one per search); in place where workers are unavailable. `spec` is consumed. */
export async function findSimilarOffThread(spec: BandSpectrogram, exemplar: Box, opts: FindOptions = {}): Promise<SimilarHit[]> {
    const Ctor = await workerCtor();
    if (!Ctor) return findSimilar(spec, exemplar, opts);
    const w = new Ctor();
    try {
        return await new Promise<SimilarHit[]>((resolve, reject) => {
            w.onmessage = (e: MessageEvent) => (e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.hits));
            w.onerror = (e: ErrorEvent) => reject(new Error(e.message || 'similar worker failed'));
            w.postMessage({ spec, exemplar, opts }, [spec.values.buffer]);
        });
    } finally { w.terminate(); }
}
