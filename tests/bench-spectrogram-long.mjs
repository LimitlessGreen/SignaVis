/**
 * Long-recording benchmark: time + memory of the JS spectrogram pipeline.
 *
 * Synthetic signal with known structure so tile/chunk boundary errors are
 * visible: every second a 50 ms tone burst whose frequency encodes the
 * second index (500 Hz + (sec % 60) * 200 Hz), plus low-level noise.
 *
 * Run: node --expose-gc tests/bench-spectrogram-long.mjs [minutes=10]
 */
import { computeSpectrogram } from '../src/domain/dsp.ts';

const SR = 32000;
const MINUTES = Number(process.argv[2] || 10);
const N = SR * 60 * MINUTES;

function mb(bytes) { return (bytes / 1024 / 1024).toFixed(0) + ' MB'; }

const audio = new Float32Array(N);
let seed = 1;
for (let i = 0; i < N; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const sec = Math.floor(i / SR);
    const inBurst = (i % SR) < SR * 0.05;
    const f = 500 + (sec % 60) * 200;
    audio[i] = 0.01 * (seed / 2 ** 32 - 0.5)
             + (inBurst ? 0.5 * Math.sin(2 * Math.PI * f * i / SR) : 0);
}

const opts = {
    sampleRate: SR, frameRate: 100, nMels: 160, fftSize: 2048, windowSize: 1280, hopSize: 320,
    pcenGain: 0.8, pcenBias: 0.01, pcenRoot: 4, pcenSmoothing: 0.025,
    scale: 'mel', usePcen: true, colourScale: 'dbSquared', windowFunction: 'hann',
};

globalThis.gc?.();
const before = process.memoryUsage();
const t0 = performance.now();
const r = computeSpectrogram({ channelData: audio, ...opts });
const ms = performance.now() - t0;
const after = process.memoryUsage();

console.log(`audio: ${MINUTES} min @ ${SR} Hz mono = ${mb(audio.byteLength)}`);
console.log(`frames: ${r.nFrames} × ${r.nMels} mels = ${mb(r.data.byteLength)}`);
console.log(`time: ${(ms / 1000).toFixed(2)} s  → ${(ms / MINUTES / 1000).toFixed(2)} s per audio minute`);
console.log(`extrapolated 1 h: ${(ms * 60 / MINUTES / 1000).toFixed(0)} s, 8 h: ${(ms * 480 / MINUTES / 1000 / 60).toFixed(1)} min`);
console.log(`arrayBuffers delta: ${mb(after.arrayBuffers - before.arrayBuffers)}`);

// Sanity check: burst at second 7 must peak near 500 + 7*200 = 1900 Hz.
const frame = 7 * 100 + 2;
let best = 0;
for (let m = 1; m < r.nMels; m++) if (r.data[frame * r.nMels + m] > r.data[frame * r.nMels + best]) best = m;
const mel = (hz) => 2595 * Math.log10(1 + hz / 700);
const hz = 700 * (10 ** ((best / (r.nMels - 1)) * mel(SR / 2) / 2595) - 1);
console.log(`sanity: frame ${frame} peak at mel ${best} ≈ ${hz.toFixed(0)} Hz (expected ~1900)`);
