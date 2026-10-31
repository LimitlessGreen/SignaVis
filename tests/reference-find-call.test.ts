import test from 'node:test';
import assert from 'node:assert/strict';

import { findCall } from '../src/ui/components/reference-calls-modal/find-call.ts';

function fakeBuffer(samples: Float32Array, sampleRate: number): AudioBuffer {
  return {
    sampleRate,
    length: samples.length,
    duration: samples.length / sampleRate,
    numberOfChannels: 1,
    getChannelData: () => samples,
  } as unknown as AudioBuffer;
}

test('findCall locates the loudest window', async () => {
  const sr = 8000;
  const x = new Float32Array(sr * 6);
  for (let i = 0; i < x.length; i++) x[i] = 0.01 * Math.sin(i);           // quiet floor
  for (let i = sr * 3; i < sr * 4; i++) x[i] = 0.8 * Math.sin(i * 0.7);   // burst 3–4 s
  const call = await findCall(fakeBuffer(x, sr), NaN, NaN, 1);
  assert.ok(Math.abs(call.start - 2.9) < 0.05, `start ${call.start}`);
  assert.ok(call.end > 3.9 && call.end <= 4.25, `end ${call.end}`);
});

test('findCall clamps window to short recordings', async () => {
  const sr = 8000;
  const x = new Float32Array(sr / 2).fill(0.1);
  const call = await findCall(fakeBuffer(x, sr), NaN, NaN, 3);
  assert.equal(call.start, 0);
  assert.ok(call.end <= 0.5 + 1e-9);
});
