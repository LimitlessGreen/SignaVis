// ═══════════════════════════════════════════════════════════════════════
// spectralFeatures.worker.js — Web Worker for spectral features and ridges
//
// Imported via Vite `?worker&inline` so it gets bundled into the
// main library output as a Blob URL — no separate file needed.
// ═══════════════════════════════════════════════════════════════════════

import { computeSpectralFeatures, computeRidges } from '../domain/spectralFeatures.ts';

self.onmessage = (event) => {
    const msg = event.data;

    if (msg.type === 'spectralFeatures') {
        const { requestId, channelData, sampleRate, hopSize, windowSize, nFrames } = msg;
        try {
            const result = computeSpectralFeatures(
                new Float32Array(channelData), sampleRate, hopSize, windowSize, nFrames,
            );
            self.postMessage(
                { type: 'spectralFeaturesResult', requestId, centroid: result.centroid.buffer, f0: result.f0.buffer },
                /** @type {StructuredSerializeOptions} */ ({ transfer: [result.centroid.buffer, result.f0.buffer] }),
            );
        } catch (e) {
            self.postMessage({ type: 'spectralFeaturesError', requestId, message: String(e) });
        }
        return;
    }

    if (msg.type === 'ridges') {
        const { requestId, channelData, sampleRate, hopSize, windowSize, nFrames } = msg;
        try {
            const ridges = computeRidges(
                new Float32Array(channelData), sampleRate, hopSize, windowSize, nFrames,
            );
            const packed = ridges.map(r => ({
                frames: r.frames.buffer,
                freqHz: r.freqHz.buffer,
                strength: r.strength.buffer,
            }));
            const transfers = ridges.flatMap(r => [r.frames.buffer, r.freqHz.buffer, r.strength.buffer]);
            self.postMessage(
                { type: 'ridgesResult', requestId, ridges: packed },
                /** @type {StructuredSerializeOptions} */ ({ transfer: transfers }),
            );
        } catch (e) {
            self.postMessage({ type: 'ridgesError', requestId, message: String(e) });
        }
        return;
    }
};
