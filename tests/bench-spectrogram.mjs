/**
 * Quick benchmark: computeSpectrogram on synthetic audio.
 * Run: node tests/bench-spectrogram.mjs
 */
import { computeSpectrogram } from '../src/dsp.js';

const SR = 32000;
const DURATION_SEC = 30;     // 30 s test signal
const audio = new Float32Array(SR * DURATION_SEC);
// Fill with a mix of sine waves to exercise real FFT work
for (let i = 0; i < audio.length; i++) {
    audio[i] = 0.3 * Math.sin(2 * Math.PI * 1000 * i / SR)
             + 0.2 * Math.sin(2 * Math.PI * 4000 * i / SR)
             + 0.1 * Math.sin(2 * Math.PI * 8000 * i / SR);
}

const configs = [
    { label: 'Mel+PCEN 1024/50%/2×', fftSize: 2048, windowSize: 1024, hopSize: 512, scale: 'mel', usePcen: true },
    { label: 'Mel noPCEN 1024/50%/1×', fftSize: 1024, windowSize: 1024, hopSize: 512, scale: 'mel', usePcen: false },
    { label: 'Linear dB² 2048/50%', fftSize: 2048, windowSize: 2048, hopSize: 1024, scale: 'linear', usePcen: false },
    { label: 'Ultra 4096/75%/4×', fftSize: 16384, windowSize: 4096, hopSize: 1024, scale: 'mel', usePcen: true },
];

for (const cfg of configs) {
    // Warm up
    computeSpectrogram({
        channelData: audio, sampleRate: SR, frameRate: 100, nMels: 160,
        pcenGain: 0.8, pcenBias: 0.01, pcenRoot: 4, pcenSmoothing: 0.025,
        colourScale: 'dbSquared', ...cfg,
    });

    const t0 = performance.now();
    const RUNS = 3;
    for (let r = 0; r < RUNS; r++) {
        computeSpectrogram({
            channelData: audio, sampleRate: SR, frameRate: 100, nMels: 160,
            pcenGain: 0.8, pcenBias: 0.01, pcenRoot: 4, pcenSmoothing: 0.025,
            colourScale: 'dbSquared', ...cfg,
        });
    }
    const elapsed = performance.now() - t0;
    const avgMs = (elapsed / RUNS).toFixed(0);
    const realTimeFactor = (DURATION_SEC * 1000 / (elapsed / RUNS)).toFixed(1);
    console.log(`${cfg.label.padEnd(30)} ${avgMs} ms avg  (${realTimeFactor}× realtime)`);
}
