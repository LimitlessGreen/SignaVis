// ═══════════════════════════════════════════════════════════════════════
// detector-render.test.mjs — heterodyne / frequency-division chunks through
// the real aw-dsp WASM module: output rate, time alignment, chunk joins.
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { initWasmMain } from '../src/infrastructure/wasm-dsp/wasmMain.ts';
import { renderDetectorChunk } from '../src/infrastructure/audio/detectorRender.ts';

const wasmBytes = readFileSync(new URL('../src/infrastructure/wasm-dsp/pkg/aw_dsp_wasm_bg.wasm', import.meta.url));
initWasmMain(new WebAssembly.Module(wasmBytes));

/** Minimal AudioBuffer for Node (mono is all the renderer touches). */
class FakeAudioBuffer {
  constructor({ length, sampleRate, numberOfChannels = 1, data = null }) {
    this.length = length;
    this.sampleRate = sampleRate;
    this.numberOfChannels = numberOfChannels;
    this.duration = length / sampleRate;
    this._data = data ?? new Float32Array(length);
  }
  getChannelData() { return this._data; }
}
globalThis.AudioBuffer = FakeAudioBuffer;

const SR = 384000;

function toneBuffer(freq, seconds, amp = 0.5) {
  const n = Math.round(SR * seconds);
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = amp * Math.sin(2 * Math.PI * freq * i / SR);
  return new FakeAudioBuffer({ length: n, sampleRate: SR, data });
}

function zcFreq(y, rate) {
  const s = y.subarray(Math.floor(y.length / 4), Math.floor(3 * y.length / 4));
  let n = 0;
  for (let i = 1; i < s.length; i++) if ((s[i - 1] < 0) !== (s[i] < 0)) n++;
  return n / 2 / (s.length / rate);
}

test('heterodyne chunk: 48 kHz output, difference tone, aligned start', () => {
  const src = toneBuffer(45000, 1);
  const chunk = renderDetectorChunk(src, { kind: 'heterodyne', carrierHz: 40000 }, 0.30001, 0.5);
  assert.equal(chunk.buffer.sampleRate, 48000);
  // start snapped down to the decimation grid (8 input samples)
  assert.ok(chunk.startSec <= 0.30001 && 0.30001 - chunk.startSec < 8 / SR);
  assert.ok(Math.abs(chunk.buffer.duration - (chunk.endSec - chunk.startSec)) < 1 / 48000 + 1e-9);
  const f = zcFreq(chunk.buffer.getChannelData(0), 48000);
  assert.ok(Math.abs(f - 5000) < 100, `got ${f}`);
});

test('successive heterodyne chunks join without a jump', () => {
  const src = toneBuffer(45000, 1);
  const mode = { kind: 'heterodyne', carrierHz: 40000 };
  const a = renderDetectorChunk(src, mode, 0.2, 0.4).buffer.getChannelData(0);
  const b = renderDetectorChunk(src, mode, 0.4, 0.6).buffer.getChannelData(0);
  const whole = renderDetectorChunk(src, mode, 0.2, 0.6).buffer.getChannelData(0);
  // the joined chunks equal one long render (filters warmed up on both sides)
  for (const k of [a.length - 2, a.length - 1, a.length, a.length + 1]) {
    const joined = k < a.length ? a[k] : b[k - a.length];
    assert.ok(Math.abs(joined - whole[k]) < 1e-3, `sample ${k}: ${joined} vs ${whole[k]}`);
  }
});

test('frequency-division chunk divides by the divisor', () => {
  const n = SR;
  const data = new Float32Array(n);
  let seed = 1;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.002;
    const t = i / SR;
    if (t % 0.1 < 0.02) data[i] += 0.5 * Math.sin(2 * Math.PI * 45000 * t);
  }
  const src = new FakeAudioBuffer({ length: n, sampleRate: SR, data });
  const chunk = renderDetectorChunk(src, { kind: 'division', divisor: 10, envelope: false }, 0.203, 0.217);
  const f = zcFreq(chunk.buffer.getChannelData(0), 48000);
  assert.ok(Math.abs(f - 4500) < 300, `got ${f}`);
});

test('pitch-shift chunk: frequency ÷ factor at 48 kHz, tempo kept', () => {
  const src = toneBuffer(45000, 1);
  const chunk = renderDetectorChunk(src, { kind: 'pitch', factor: 10 }, 0.2, 0.5, 1);
  assert.equal(chunk.buffer.sampleRate, 48000);
  assert.ok(Math.abs(chunk.buffer.duration - 0.3) < 1e-3, `duration ${chunk.buffer.duration}`);
  const f = zcFreq(chunk.buffer.getChannelData(0), 48000);
  assert.ok(Math.abs(f - 4500) < 50, `got ${f}`);
});
