// ═══════════════════════════════════════════════════════════════════════
// spectrogram-too-large.test.mjs — Hours of audio without tile storage (no OPFS space,
// e.g. private windows) must not try a multi-GB whole-file spectrogram: the size estimate
// bounds the engine's real output, and the player falls back to the waveform with a note.
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fullSpectrogramBytes, FULL_SPECTROGRAM_MAX_BYTES } from '../src/app/SpectrogramController.ts';
import { wasmV2ParamsFromDspOptions } from '../src/app/WasmTileManager.ts';
import { initSync, WasmStft } from '../src/infrastructure/wasm-dsp/pkg/aw_dsp_wasm.js';

initSync({ module: fs.readFileSync(new URL('../src/infrastructure/wasm-dsp/pkg/aw_dsp_wasm_bg.wasm', import.meta.url)) });

const base = { windowSize: 1024, hopSize: 256, fftSize: 2048, windowFunction: 'hann', usePcen: false, nMels: 160 };

for (const scale of ['linear', 'mel']) {
    test(`fullSpectrogramBytes bounds the WASM output closely (${scale})`, () => {
        const sr = 48000;
        const params = wasmV2ParamsFromDspOptions({ ...base, scale });
        const p = { ...params, sampleRate: sr };
        if (p.scale.kind !== 'linear') p.scale = { ...p.scale, fMax: sr / 2 };
        const stft = new WasmStft(JSON.stringify(p));
        try {
            for (const n of [1, 1000, 48000 * 60, 48000 * 3600 * 3 + 17]) {
                const exact = stft.nFrames(n) * stft.outBins() * 4;
                const est = fullSpectrogramBytes(params, n);
                assert.ok(est >= exact, `${n}: ${est} >= ${exact}`);
                assert.ok(est <= exact + 2 * stft.outBins() * 4, `${n}: within two frames`);
            }
        } finally { stft.free(); }
    });
}

test('the limit allows an hour of mel audio and rejects three hours of linear audio', () => {
    const mel = wasmV2ParamsFromDspOptions({ ...base, scale: 'mel' });
    const lin = wasmV2ParamsFromDspOptions({ ...base, scale: 'linear' });
    assert.ok(fullSpectrogramBytes(mel, 48000 * 3600) <= FULL_SPECTROGRAM_MAX_BYTES);
    assert.ok(fullSpectrogramBytes(lin, 48000 * 3600 * 3) > FULL_SPECTROGRAM_MAX_BYTES);
});
