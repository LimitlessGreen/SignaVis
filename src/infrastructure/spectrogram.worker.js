// ═══════════════════════════════════════════════════════════════════════
// spectrogram.worker.js — Web Worker for spectrogram computation
//
// Imported via Vite `?worker&inline` so it gets bundled into the
// main library output as a Blob URL — no separate file needed.
// ═══════════════════════════════════════════════════════════════════════

import { computeSpectrogram } from '../domain/dsp.ts';

self.onmessage = (event) => {
    const { requestId, channelData, ...options } = event.data;

    const result = computeSpectrogram({
        channelData: new Float32Array(channelData),
        ...options,
    });

    const msg = {
        requestId,
        data: result.data.buffer,
        nFrames: result.nFrames,
        nMels: result.nMels,
        hopSize: result.hopSize,
        winLength: result.winLength,
        colourScale: result.colourScale,
    };
    const transfer = [result.data.buffer];
    if (result.smoothState) {
        msg.smoothState = result.smoothState.buffer;
        transfer.push(result.smoothState.buffer);
    }
    self.postMessage(msg, /** @type {StructuredSerializeOptions} */ ({ transfer }));
};
