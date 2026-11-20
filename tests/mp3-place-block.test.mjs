import test from 'node:test';
import assert from 'node:assert/strict';
import { placeBlock } from '../src/infrastructure/audio/chunkedMp3Decode.ts';

/** The per-sample loop placeBlock replaced (reference). */
function reference(dst, c0, c1, len, written, want) {
    const srcStart = Math.max(0, len - want), missing = Math.max(0, want - len);
    for (let k = 0; k < want; k++) {
        const pos = written + k;
        if (pos < 0 || pos >= dst.length) continue;
        const s = k - missing;
        if (s < 0) { dst[pos] = 0; continue; }
        const j = srcStart + s;
        dst[pos] = c1 ? (c0[j] + c1[j]) * 0.5 : c0[j];
    }
}

test('placeBlock equals the per-sample loop (trim, padding, short blocks, mono/stereo)', () => {
    let seed = 7;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let t = 0; t < 400; t++) {
        const total = 1 + Math.floor(rnd() * 3000);
        const want = 1 + Math.floor(rnd() * 1200);
        const len = Math.floor(rnd() * 1500);
        const written = Math.floor(rnd() * (total + 1400)) - 1200;
        const c0 = Float32Array.from({ length: len }, rnd), c1 = t % 2 ? Float32Array.from({ length: len }, rnd) : null;
        const a = Float32Array.from({ length: total }, () => -1), b = a.slice();
        reference(a, c0, c1, len, written, want);
        placeBlock(b, c0, c1, len, written, want);
        assert.deepEqual(b, a, `case ${t}: total ${total} want ${want} len ${len} written ${written}`);
    }
});
