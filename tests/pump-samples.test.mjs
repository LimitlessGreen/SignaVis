import test from 'node:test';
import assert from 'node:assert/strict';
import { pumpSamples } from '../src/shared/pumpSamples.ts';

test('pumpSamples: every sample once, in order, with reused buffers and bounded concurrency', async () => {
    const data = Float32Array.from({ length: 10_050 }, (_, i) => i);
    const seen = new Float32Array(data.length).fill(-1);
    const buffers = new Set();
    let active = 0, maxActive = 0;
    await pumpSamples(data, 1000, async (piece, offset) => {
        active++; maxActive = Math.max(maxActive, active);
        buffers.add(piece.buffer);
        await new Promise((r) => setTimeout(r, 1));
        seen.set(piece, offset);
        const back = structuredClone(piece.buffer, { transfer: [piece.buffer] }); // like a worker round trip
        buffers.add(back);
        active--;
        return back;
    }, 2);
    assert.deepEqual(seen, data);
    assert.ok(maxActive <= 2, `max in flight ${maxActive}`);
});

test('pumpSamples: allocates no more than poolSize buffers when they come back', async () => {
    let allocs = 0;
    const Orig = globalThis.ArrayBuffer;
    const data = new Float32Array(20_000);
    const returned = [];
    await pumpSamples(data, 1000, async (piece) => { if (!returned.includes(piece.buffer)) { allocs++; returned.push(piece.buffer); } return piece.buffer; }, 3);
    assert.equal(allocs, 3);
    assert.equal(globalThis.ArrayBuffer, Orig);
});
