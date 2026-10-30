// Generates JS reference spectrograms for tests/parity.rs.
// Run from Audio-Workbench/: node src-tauri/crates/aw-dsp/tests/gen-fixtures.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { computeSpectrogram } from '../../../../src/domain/dsp.ts';

const dir = new URL('./fixtures/', import.meta.url);
mkdirSync(dir, { recursive: true });

const SR = 32000;
const N = SR * 3 + 1234; // non-integer number of hops
const audio = new Float32Array(N);
let seed = 1;
for (let i = 0; i < N; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const sec = Math.floor(i / SR);
    audio[i] = 0.01 * (seed / 2 ** 32 - 0.5)
             + ((i % SR) < SR * 0.05 ? 0.5 * Math.sin(2 * Math.PI * (500 + sec * 200) * i / SR) : 0)
             + 0.05 * Math.sin(2 * Math.PI * (2000 + 3000 * i / N) * i / SR);
}
writeFileSync(new URL('audio.f32', dir), Buffer.from(audio.buffer));

const base = { sampleRate: SR, frameRate: 100, nMels: 160, fftSize: 2048, windowSize: 1280, hopSize: 320,
    pcenGain: 0.8, pcenBias: 0.01, pcenRoot: 4, pcenSmoothing: 0.025, colourScale: 'dbSquared', windowFunction: 'hann' };
const cases = {
    mel_pcen: { scale: 'mel', usePcen: true },
    mel_db: { scale: 'mel', usePcen: false },
    linear_db: { scale: 'linear', usePcen: false, fftSize: 1024, windowSize: 1024, hopSize: 512 },
};
for (const [name, c] of Object.entries(cases)) {
    const r = computeSpectrogram({ channelData: audio, ...base, ...c });
    writeFileSync(new URL(`${name}.f32`, dir), Buffer.from(r.data.buffer));
    console.log(name, r.nFrames, r.nMels);
}
