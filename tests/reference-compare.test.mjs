import test from 'node:test';
import assert from 'node:assert/strict';
import { loudestWindow } from '../src/ui/components/reference-compare/reference-compare.ts';

const patch = (frames, loudAt) => {
    const bins = 4, values = new Float32Array(frames * bins).fill(-80);
    for (let f = loudAt; f < loudAt + 5; f++) for (let b = 0; b < bins; b++) values[f * bins + b] = -20;
    return { values, frames, bins, t0: 0, dt: 0.1, f0: 0, df: 1000 };
};

test('loudest window starts at the loud part', () => {
    assert.ok(Math.abs(loudestWindow(patch(100, 60), 0.5) - 6) < 1e-9);
});

test('a window longer than the recording starts at its beginning', () => {
    assert.equal(loudestWindow(patch(10, 3), 5), 0);
});
