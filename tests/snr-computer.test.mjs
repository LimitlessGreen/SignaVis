/**
 * Tests for the SNR computation module.
 *
 * Two scopes:
 *  1. DSP math (biquad filter + RMS) — inlined here because the worker code
 *     is embedded as a Blob string and not importable as an ES module.
 *     These tests verify the mathematical specification independently.
 *
 *  2. SnrComputer class — browser globals (Worker, Blob, URL) are mocked so
 *     the class can be imported and exercised in Node.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ── DSP helpers (mirror of the worker source) ─────────────────────────────

function biquadFilter(samples, fc, fs, type) {
  if (fc <= 0 || fc >= fs / 2) return samples;
  const w0 = 2 * Math.PI * fc / fs;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / Math.SQRT2;

  let b0, b1, b2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosW0;
  const a2 = 1 - alpha;

  if (type === 'lp') {
    b0 = (1 - cosW0) / 2;
    b1 =  1 - cosW0;
    b2 = (1 - cosW0) / 2;
  } else {
    b0 =  (1 + cosW0) / 2;
    b1 = -(1 + cosW0);
    b2 =  (1 + cosW0) / 2;
  }

  const nb0 = b0 / a0, nb1 = b1 / a0, nb2 = b2 / a0;
  const na1 = a1 / a0, na2 = a2 / a0;

  const out = new Float32Array(samples.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    const y0 = nb0*x0 + nb1*x1 + nb2*x2 - na1*y1 - na2*y2;
    out[i] = y0; x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}

function applyBandpass(samples, freqMin, freqMax, fs) {
  let s = samples;
  if (freqMin != null && freqMin > 0)       s = biquadFilter(s, freqMin, fs, 'hp');
  if (freqMax != null && freqMax < fs / 2)  s = biquadFilter(s, freqMax, fs, 'lp');
  return s;
}

function rms(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

// Generates a pure sine wave (Float32Array, length = nSamples)
function sine(freq, fs, nSamples, amplitude = 1) {
  const out = new Float32Array(nSamples);
  for (let i = 0; i < nSamples; i++) out[i] = amplitude * Math.sin(2 * Math.PI * freq * i / fs);
  return out;
}

// dB of ratio a/b
const toDb = (a, b) => 20 * Math.log10(a / b);

const FS = 44100;
const N  = FS * 2; // 2-second buffer — long enough for transients to settle

// ── RMS ───────────────────────────────────────────────────────────────────────

test('rms: empty array returns 0', () => {
  assert.equal(rms(new Float32Array(0)), 0);
});

test('rms: DC signal of amplitude A has rms = A', () => {
  const dc = new Float32Array(1000).fill(0.5);
  assert.ok(Math.abs(rms(dc) - 0.5) < 1e-9);
});

test('rms: sine wave of amplitude A has rms ≈ A / sqrt(2)', () => {
  const A = 0.8;
  const signal = sine(440, FS, N, A);
  const expected = A / Math.SQRT2;
  assert.ok(Math.abs(rms(signal) - expected) < 0.001, `Got ${rms(signal)}, expected ~${expected}`);
});

test('rms: amplitude doubles → rms doubles', () => {
  const s1 = sine(440, FS, N, 0.3);
  const s2 = sine(440, FS, N, 0.6);
  assert.ok(Math.abs(rms(s2) / rms(s1) - 2) < 0.01);
});

// ── Lowpass filter ────────────────────────────────────────────────────────────

test('LP filter: passes signal well below cutoff', () => {
  const fc = 4000;
  const testFreq = 250; // 4 octaves below — should pass
  const signal = sine(testFreq, FS, N);
  const filtered = biquadFilter(signal, fc, FS, 'lp');
  // Attenuation should be < 1 dB
  const attenDb = toDb(rms(signal), rms(filtered));
  assert.ok(Math.abs(attenDb) < 1, `Attenuation ${attenDb.toFixed(2)} dB > 1 dB at ${testFreq} Hz`);
});

test('LP filter: strongly attenuates signal well above cutoff', () => {
  const fc = 500;
  const testFreq = 8000; // 4 octaves above — should be attenuated
  const signal = sine(testFreq, FS, N);
  const filtered = biquadFilter(signal, fc, FS, 'lp');
  const attenDb = toDb(rms(signal), rms(filtered));
  // 2nd-order Butterworth: -12 dB/oct → at 4 oct above: ~ -48 dB
  assert.ok(attenDb > 30, `Attenuation ${attenDb.toFixed(2)} dB too low for ${testFreq} Hz above LP at ${fc} Hz`);
});

test('LP filter: fc >= fs/2 returns original samples unchanged', () => {
  const signal = sine(1000, FS, N);
  const filtered = biquadFilter(signal, FS / 2, FS, 'lp');
  assert.equal(filtered, signal); // same reference
});

test('LP filter: fc <= 0 returns original samples unchanged', () => {
  const signal = sine(1000, FS, N);
  const filtered = biquadFilter(signal, 0, FS, 'lp');
  assert.equal(filtered, signal);
});

// ── Highpass filter ───────────────────────────────────────────────────────────

test('HP filter: passes signal well above cutoff', () => {
  const fc = 500;
  const testFreq = 8000; // 4 octaves above
  const signal = sine(testFreq, FS, N);
  const filtered = biquadFilter(signal, fc, FS, 'hp');
  const attenDb = toDb(rms(signal), rms(filtered));
  assert.ok(Math.abs(attenDb) < 1, `Attenuation ${attenDb.toFixed(2)} dB > 1 dB at ${testFreq} Hz`);
});

test('HP filter: strongly attenuates signal well below cutoff', () => {
  const fc = 4000;
  const testFreq = 250; // 4 octaves below
  const signal = sine(testFreq, FS, N);
  const filtered = biquadFilter(signal, fc, FS, 'hp');
  const attenDb = toDb(rms(signal), rms(filtered));
  assert.ok(attenDb > 30, `Attenuation ${attenDb.toFixed(2)} dB too low for ${testFreq} Hz below HP at ${fc} Hz`);
});

// ── Bandpass filter ───────────────────────────────────────────────────────────

test('bandpass: preserves in-band signal', () => {
  const fMin = 1000, fMax = 8000;
  const signal = sine(3000, FS, N); // center of band
  const filtered = applyBandpass(signal, fMin, fMax, FS);
  const attenDb = toDb(rms(signal), rms(filtered));
  assert.ok(Math.abs(attenDb) < 2, `${attenDb.toFixed(2)} dB loss for in-band signal`);
});

test('bandpass: attenuates signal below lower edge', () => {
  const fMin = 2000, fMax = 8000;
  const signal = sine(125, FS, N); // 4 oct below fMin
  const filtered = applyBandpass(signal, fMin, fMax, FS);
  const attenDb = toDb(rms(signal), rms(filtered));
  assert.ok(attenDb > 20, `${attenDb.toFixed(2)} dB not enough attenuation below band`);
});

test('bandpass: attenuates signal above upper edge', () => {
  const fMin = 500, fMax = 1000;
  const signal = sine(16000, FS, N); // 4 oct above fMax
  const filtered = applyBandpass(signal, fMin, fMax, FS);
  const attenDb = toDb(rms(signal), rms(filtered));
  assert.ok(attenDb > 20, `${attenDb.toFixed(2)} dB not enough attenuation above band`);
});

test('bandpass: null freqMin/freqMax → no filtering', () => {
  const signal = sine(1000, FS, 100);
  const filtered = applyBandpass(signal, null, null, FS);
  // Without any filter, the same array reference is returned
  assert.equal(filtered, signal);
});

// ── SnrComputer class ─────────────────────────────────────────────────────────

// Mock browser globals before importing SnrComputer
let _lastWorker = null;

class FakeWorker {
  constructor() {
    this.onmessage = null;
    this.onerror = null;
    this._messages = [];
    _lastWorker = this;
  }
  postMessage(data, transfer) { this._messages.push(data); }
  terminate() {}
  // Test helper: simulate a message coming back from the worker
  _respond(data) { this.onmessage?.({ data }); }
}

globalThis.Blob = class { constructor(parts, opts) { this._parts = parts; } };
globalThis.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} };
globalThis.Worker = FakeWorker;

// Now import SnrComputer (browser globals already set above)
const { SnrComputer } = await import('../demo/lib/snr-computer.js');

function makeAudioBuffer(duration = 5, sampleRate = 44100) {
  const nSamples = Math.ceil(duration * sampleRate);
  const data = new Float32Array(nSamples);
  // Fill with white noise so RMS > 0
  for (let i = 0; i < nSamples; i++) data[i] = (Math.random() * 2 - 1) * 0.5;
  return {
    duration,
    sampleRate,
    getChannelData: () => data,
  };
}

function makeLabel(overrides = {}) {
  return { id: 'lbl-1', start: 1, end: 2, freqMin: 1000, freqMax: 8000, ...overrides };
}

// ── Cache / status API ────────────────────────────────────────────────────────

test('SnrComputer: getStatus returns null for unknown id', () => {
  const sc = new SnrComputer();
  assert.equal(sc.getStatus('nope'), null);
});

test('SnrComputer: invalidate removes cached entry', () => {
  const sc = new SnrComputer();
  // Manually plant a cache entry
  sc._cache.set('x', { status: 'done', value: 12 });
  assert.deepEqual(sc.getStatus('x'), { status: 'done', value: 12 });
  sc.invalidate('x');
  assert.equal(sc.getStatus('x'), null);
});

test('SnrComputer: invalidate cancels pending debounce timer', () => {
  const sc = new SnrComputer();
  const ab = makeAudioBuffer();
  const lbl = makeLabel();
  // Start a request (sets a timer, does not post immediately)
  sc.request(lbl, ab, ab.sampleRate);
  assert.ok(sc._timers.has(lbl.id), 'Timer should be pending');
  sc.invalidate(lbl.id);
  assert.ok(!sc._timers.has(lbl.id), 'Timer should be cleared after invalidate');
});

// ── request() guard conditions ────────────────────────────────────────────────

test('SnrComputer: request with null audioBuffer is a no-op', () => {
  const sc = new SnrComputer();
  const workerBefore = _lastWorker;
  sc.request(makeLabel(), null, 44100);
  // No timer should be set
  assert.equal(sc._timers.size, 0);
});

test('SnrComputer: request with null label is a no-op', () => {
  const sc = new SnrComputer();
  sc.request(null, makeAudioBuffer(), 44100);
  assert.equal(sc._timers.size, 0);
});

// ── Worker communication ──────────────────────────────────────────────────────

test('SnrComputer: request sets pending status and posts to worker', async () => {
  const sc = new SnrComputer();
  const ab = makeAudioBuffer(10);
  const lbl = makeLabel({ id: 'lbl-pending', start: 2, end: 3 });

  const results = [];
  sc.setOnResult((id, status, value) => results.push({ id, status, value }));

  sc.request(lbl, ab, ab.sampleRate);

  // Wait for the 300 ms debounce
  await new Promise(r => setTimeout(r, 350));

  assert.deepEqual(sc.getStatus('lbl-pending'), { status: 'pending' });
  assert.equal(_lastWorker._messages.length, 1);
  assert.equal(_lastWorker._messages[0].id, 'lbl-pending');
  // onResult should have been called with 'pending'
  assert.ok(results.some(r => r.id === 'lbl-pending' && r.status === 'pending'));
});

test('SnrComputer: worker done response updates cache and calls onResult', async () => {
  const sc = new SnrComputer();
  const ab = makeAudioBuffer(10);
  const lbl = makeLabel({ id: 'lbl-done', start: 2, end: 3 });

  const results = [];
  sc.setOnResult((id, status, value) => results.push({ id, status, value }));

  sc.request(lbl, ab, ab.sampleRate);
  await new Promise(r => setTimeout(r, 350));

  // Simulate worker responding
  _lastWorker._respond({ id: 'lbl-done', status: 'done', value: 7.5 });

  assert.deepEqual(sc.getStatus('lbl-done'), { status: 'done', value: 7.5 });
  const doneResult = results.find(r => r.id === 'lbl-done' && r.status === 'done');
  assert.ok(doneResult, 'onResult should be called with done status');
  assert.equal(doneResult.value, 7.5);
});

test('SnrComputer: worker error response updates cache', async () => {
  const sc = new SnrComputer();
  const ab = makeAudioBuffer(10);
  const lbl = makeLabel({ id: 'lbl-err', start: 2, end: 3 });

  sc.request(lbl, ab, ab.sampleRate);
  await new Promise(r => setTimeout(r, 350));

  _lastWorker._respond({ id: 'lbl-err', status: 'error', error: 'silence' });

  assert.deepEqual(sc.getStatus('lbl-err'), { status: 'error' });
});

test('SnrComputer: no noise room → sets error without posting to worker', () => {
  const sc = new SnrComputer();
  // 2-second buffer: label 0→1 with no room before AND after would fill the buffer
  const ab = makeAudioBuffer(1.5); // only 1.5 s total
  // Label 0.2→1.2 → needs 1 s noise before (only 0.2 s available) or after (only 0.3 s)
  const lbl = makeLabel({ id: 'lbl-noroom', start: 0.2, end: 1.2 });

  const results = [];
  sc.setOnResult((id, status) => results.push({ id, status }));

  // Call _compute directly (bypass debounce)
  sc._compute(lbl, ab, ab.sampleRate);

  assert.deepEqual(sc.getStatus('lbl-noroom'), { status: 'error' });
  assert.ok(results.some(r => r.id === 'lbl-noroom' && r.status === 'error'));
});

test('SnrComputer: request is debounced — rapid calls result in one worker message', async () => {
  const sc = new SnrComputer();
  const ab = makeAudioBuffer(10);
  const lbl = makeLabel({ id: 'lbl-debounce', start: 2, end: 3 });

  const workerMessages = [];
  // Capture postMessage on the current worker
  _lastWorker.postMessage = (data) => workerMessages.push(data);

  for (let i = 0; i < 5; i++) sc.request(lbl, ab, ab.sampleRate);

  await new Promise(r => setTimeout(r, 400));

  assert.equal(workerMessages.filter(m => m.id === 'lbl-debounce').length, 1,
    'Multiple rapid requests should collapse into one worker call');
});
