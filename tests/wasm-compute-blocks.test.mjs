import test from 'node:test';
import assert from 'node:assert/strict';
import { wasmComputeBlockFrames } from '../src/shared/constants.ts';

test('whole-file blocks stay small for long recordings', () => {
    assert.equal(wasmComputeBlockFrames(107_000, 8), 1024);
    assert.equal(wasmComputeBlockFrames(10_000, 8), 625);
    assert.equal(wasmComputeBlockFrames(1_000, 8), 256);
});
