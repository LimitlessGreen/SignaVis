// app/similarBand.ts — band spectrogram for "find similar calls" on raw channels
// (see similarSpectrogram.ts). No other app imports: the search worker loads it too.

import type { BandSpectrogram } from '../domain/similar/ncc.ts';

const WINDOW_SECONDS = 0.016;
const BLOCK_FRAMES = 4096;

export interface BandOptions {
    /** Called between blocks; return a promise to yield to the UI. */
    yieldEvery?: () => Promise<void> | void;
    /** Stops early when it returns true. */
    cancelled?: () => boolean;
}

/** bandSpectrogram() on raw channels with a given aw-dsp instance (also used inside the search worker). */
export async function bandSpectrogramOf(wasm: { WasmStft: any }, channels: Float32Array[], length: number, sr: number,
    loHz: number, hiHz: number, opts: BandOptions = {}): Promise<BandSpectrogram | null> {
    const audio = { length };
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

