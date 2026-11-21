import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSync, bandFloor } from '../src/infrastructure/wasm-dsp/pkg/aw_dsp_wasm.js';
import { bandFloorSampled } from '../src/infrastructure/wasm-dsp/bandFloorSampled.ts';

const wasm = initSync({ module: fs.readFileSync(new URL('../src/infrastructure/wasm-dsp/pkg/aw_dsp_wasm_bg.wasm', import.meta.url)) });

function noise(frames, bins, seed = 1) {
    const v = new Float32Array(frames * bins);
    let s = seed;
    for (let i = 0; i < v.length; i++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        v[i] = -80 + (s / 2 ** 32) * 60 + (i % bins) * 0.1;
    }
    return v;
}

test('bandFloorSampled matches bandFloor on the full values', () => {
    for (const frames of [10, 3999, 4000, 8001, 25_000, 107_001]) {
        const bins = 33;
        const v = noise(frames, bins, frames);
        assert.deepEqual(Array.from(bandFloorSampled(v, bins)), Array.from(bandFloor(v, bins)), `frames ${frames}`);
    }
});

test('bandFloorSampled copies only the sampled frames into WebAssembly memory', () => {
    const v = noise(100_000, 513);            // 205 MB
    const before = wasm.memory.buffer.byteLength;
    bandFloorSampled(v, 513);
    const grown = wasm.memory.buffer.byteLength - before;
    assert.ok(grown < 32 * 2 ** 20, `grew ${grown >> 20} MB`);
});
