// overview-spectrogram.test.mjs — max-pooled whole-file overview
import test from 'node:test';
import assert from 'node:assert/strict';
import { poolFramesMax } from '../src/domain/spectrogram.ts';

test('poolFramesMax keeps each bin maximum per column', () => {
    // 6 frames × 2 bins, frame-major; a short "call" in frame 4, bin 1
    const data = Float32Array.from([
        0, 1,  0, 1,  0, 1,
        0, 1,  0, 9,  2, 1,
    ]);
    const { data: out, frames } = poolFramesMax(data, 6, 2, 3);
    assert.equal(frames, 3);
    assert.deepEqual([...out], [0, 1, 0, 1, 2, 9]);
});

test('poolFramesMax passes short data through', () => {
    const data = Float32Array.from([1, 2, 3, 4]);
    const { data: out, frames } = poolFramesMax(data, 2, 2, 10);
    assert.equal(frames, 2);
    assert.deepEqual([...out], [1, 2, 3, 4]);
});

test('poolFramesMax covers uneven splits without gaps', () => {
    const data = Float32Array.from([5, 1, 1, 1, 7]); // 5 frames × 1 bin
    const { data: out } = poolFramesMax(data, 5, 1, 2);
    assert.deepEqual([...out], [5, 7]);
});

test('poolFramesMax samples phase instead of taking the largest angle', () => {
    const data = Float32Array.from([-3, 3, -3, 3, -3, 3]); // 6 frames × 1 bin
    const { data: out } = poolFramesMax(data, 6, 1, 2, 'sample');
    assert.deepEqual([...out], [3, -3]); // frames 1 and 4 (column centres)
});
