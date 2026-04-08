// ═══════════════════════════════════════════════════════════════════════
// spectrolipi-engine.test.mjs — Tests for the Spectrolipi engine
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpectrolipiProcessor } from '../src/spectrolipiEngine.js';

// ─── Factory ────────────────────────────────────────────────────────

test('createSpectrolipiProcessor returns compute and dispose', () => {
    const proc = createSpectrolipiProcessor();
    assert.equal(typeof proc.compute, 'function');
    assert.equal(typeof proc.dispose, 'function');
});

// ─── Compute: basic sine wave ───────────────────────────────────────

test('compute returns correct structure for sine wave', async () => {
    const sr = 16000;
    const dur = 0.5;
    const len = sr * dur;
    const audio = new Float32Array(len);
    const freq = 1000;
    for (let i = 0; i < len; i++) {
        audio[i] = Math.sin(2 * Math.PI * freq * i / sr);
    }

    const proc = createSpectrolipiProcessor();
    const result = await proc.compute(audio, {
        fftSize: 1024,
        sampleRate: sr,
        frameRate: 100,
    });

    assert.ok(result.data instanceof Float32Array, 'data is Float32Array');
    assert.ok(result.nFrames > 0, 'has frames');
    assert.ok(result.nMels > 0, 'has bins (nMels)');
    assert.equal(result.nMels, 512, 'linear bins = fftSize/2');
    assert.ok(result.hopSize > 0, 'has hopSize');
    assert.ok(result.winLength > 0, 'has winLength');
    assert.equal(result.data.length, result.nFrames * result.nMels, 'data length matches');
});

// ─── Output is dB values ────────────────────────────────────────────

test('output values are in dB (negative range)', async () => {
    const sr = 16000;
    const audio = new Float32Array(sr);
    for (let i = 0; i < sr; i++) {
        audio[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / sr);
    }

    const proc = createSpectrolipiProcessor();
    const result = await proc.compute(audio, {
        fftSize: 2048,
        sampleRate: sr,
        frameRate: 100,
    });

    // dB values should be mostly negative (mag < 1 after /N normalization)
    let negCount = 0;
    for (let i = 0; i < result.data.length; i++) {
        if (result.data[i] < 0) negCount++;
    }
    const negRatio = negCount / result.data.length;
    assert.ok(negRatio > 0.9, `expected mostly negative dB values, got ${(negRatio*100).toFixed(1)}% negative`);
});

// ─── Hop size defaults to fftSize/2 ────────────────────────────────

test('default hop = fftSize / 2 (spectrolipi convention)', async () => {
    const sr = 16000;
    const audio = new Float32Array(sr);
    const proc = createSpectrolipiProcessor();
    const result = await proc.compute(audio, {
        fftSize: 1024,
        sampleRate: sr,
        frameRate: 100,
    });

    assert.equal(result.hopSize, 512, 'hop should be fftSize/2');
});

// ─── User hopSize override ──────────────────────────────────────────

test('respects user-specified hopSize', async () => {
    const sr = 16000;
    const audio = new Float32Array(sr);
    const proc = createSpectrolipiProcessor();
    const result = await proc.compute(audio, {
        fftSize: 1024,
        sampleRate: sr,
        frameRate: 100,
        hopSize: 256,
    });

    assert.equal(result.hopSize, 256);
    // With smaller hop, more frames
    const expectedFrames = Math.floor((sr - 1024) / 256) + 1;
    assert.equal(result.nFrames, expectedFrames);
});

// ─── Sine wave peak detection ───────────────────────────────────────

test('1 kHz sine shows energy peak near bin 64 (fftSize=1024, sr=16000)', async () => {
    const sr = 16000;
    const dur = 1;
    const audio = new Float32Array(sr * dur);
    for (let i = 0; i < audio.length; i++) {
        audio[i] = Math.sin(2 * Math.PI * 1000 * i / sr);
    }

    const proc = createSpectrolipiProcessor();
    const result = await proc.compute(audio, {
        fftSize: 1024,
        sampleRate: sr,
        frameRate: 100,
    });

    // Average across frames to find which bin has max energy
    const bins = result.nMels;
    const avg = new Float64Array(bins);
    for (let f = 0; f < result.nFrames; f++) {
        for (let b = 0; b < bins; b++) {
            avg[b] += result.data[f * bins + b];
        }
    }

    let maxBin = 0, maxVal = -Infinity;
    for (let b = 0; b < bins; b++) {
        if (avg[b] > maxVal) { maxVal = avg[b]; maxBin = b; }
    }

    // Expected bin: 1000 Hz / (sr/fftSize) = 1000 / 15.625 = 64
    assert.ok(Math.abs(maxBin - 64) <= 2, `peak bin should be near 64, got ${maxBin}`);
});

// ─── Dispose is safe to call multiple times ─────────────────────────

test('dispose is idempotent', () => {
    const proc = createSpectrolipiProcessor();
    proc.dispose();
    proc.dispose(); // should not throw
});
