// ═══════════════════════════════════════════════════════════════════════
// snapPatch.ts — dB patch around a click for "Snap to call"
//
// Independent of the displayed spectrogram (mel/PCEN/tiles): a linear dB
// STFT with the XC analysis (Hann ≈ 11.6 ms, 75 % overlap, 2× zero padding)
// over ±halfWidth seconds, computed synchronously with aw-dsp on the main
// thread.
// ═══════════════════════════════════════════════════════════════════════

import { wasmMain } from '../infrastructure/wasm-dsp/wasmMain.ts';
import type { SnapPatch } from '../domain/snapToCall.ts';
import { channelData } from '../shared/utils.ts';

const WINDOW_SECONDS = 0.0116;

/** Patch for ±halfWidth s around `time`, or null before aw-dsp is ready. */
export function computeSnapPatch(audio: AudioBuffer, time: number, halfWidth: number): SnapPatch | null {
    const wasm = wasmMain();
    if (!wasm) return null;
    const sr = audio.sampleRate;
    const winLen = 2 ** Math.round(Math.log2(sr * WINDOW_SECONDS));
    const hop = winLen / 4;
    const params = { winLen, hop, nFft: 2 * winLen, window: { kind: 'hann' }, scale: { kind: 'linear' },
        pcen: null, reassign: false, output: 'db', sampleRate: sr };
    const stft = new wasm.WasmStft(JSON.stringify(params));
    try {
        const total = stft.nFrames(audio.length);
        const f0 = Math.max(0, Math.floor((time - halfWidth) * sr / hop));
        const n = Math.min(total - f0, Math.ceil(2 * halfWidth * sr / hop));
        if (n < 3) return null;
        const [lo, hi] = stft.blockFrameRange(f0, n, total);
        const [start, len] = stft.sampleRange(lo, hi - lo);
        const first = Math.max(0, start), last = Math.min(audio.length, start + len);
        const mono = new Float32Array(Math.max(0, last - first));
        for (let c = 0; c < audio.numberOfChannels; c++) {
            const ch = channelData(audio, c);
            for (let i = 0; i < mono.length; i++) mono[i] += ch[first + i] / audio.numberOfChannels;
        }
        const values = stft.blockValues(mono, first, f0, n, total);
        const freqs = stft.binFrequencies();
        return {
            values, frames: n, bins: stft.outBins(),
            t0: f0 * hop / sr, dt: hop / sr,
            f0: freqs[0], df: freqs.length > 1 ? freqs[1] - freqs[0] : sr / (2 * winLen),
            atStart: f0 === 0, atEnd: f0 + n >= total,
        };
    } finally { stft.free(); }
}
