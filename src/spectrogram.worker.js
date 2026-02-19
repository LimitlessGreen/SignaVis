// ═══════════════════════════════════════════════════════════════════════
// spectrogram.worker.js — Web Worker for spectrogram computation
//
// Imported via Vite `?worker&inline` so it gets bundled into the
// main library output as a Blob URL — no separate file needed.
// ═══════════════════════════════════════════════════════════════════════

import { computeSpectrogram } from './dsp.js';

self.onmessage = (event) => {
    const { requestId, channelData, ...options } = event.data;

    const result = computeSpectrogram({
        channelData: new Float32Array(channelData),
        ...options,
    });

    self.postMessage(
        {
            requestId,
            data: result.data.buffer,
            nFrames: result.nFrames,
            nMels: result.nMels,
        },
        [result.data.buffer],
    );
};
