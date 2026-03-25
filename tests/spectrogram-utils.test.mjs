// ═══════════════════════════════════════════════════════════════════════
// spectrogram-utils.test.mjs — Tests for spectrogram utility functions
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    computeAmplitudePeak,
    updateSpectrogramStats,
    autoContrastStats,
    detectMaxFrequency,
} from '../src/spectrogram.js';

// ─── computeAmplitudePeak ───────────────────────────────────────────

test('computeAmplitudePeak finds the absolute maximum', () => {
    const data = new Float32Array([0.1, -0.5, 0.3, -0.2, 0.4]);
    assert.ok(
        Math.abs(computeAmplitudePeak(data) - 0.5) < 1e-6,
        'peak should be 0.5',
    );
});

test('computeAmplitudePeak returns minimum epsilon for silence', () => {
    const data = new Float32Array(100); // all zeros
    const peak = computeAmplitudePeak(data);
    assert.ok(peak > 0, 'peak should be > 0 even for silence');
    assert.ok(peak < 0.001, 'peak should be tiny for silence');
});

// ─── updateSpectrogramStats ─────────────────────────────────────────

test('updateSpectrogramStats computes min/max over data values', () => {
    const data = new Float32Array([0.01, 0.5, 1.0, 2.0, 0.001]);
    const { logMin, logMax } = updateSpectrogramStats(data);
    assert.ok(logMin < logMax, 'min should be < max');
    assert.ok(Number.isFinite(logMin), 'logMin should be finite');
    assert.ok(Number.isFinite(logMax), 'logMax should be finite');
    assert.ok(Math.abs(logMin - 0.001) < 0.01, 'logMin should be near 0.001');
    assert.ok(Math.abs(logMax - 2.0) < 0.01, 'logMax should be near 2.0');
});

// ─── autoContrastStats ──────────────────────────────────────────────

test('autoContrastStats returns percentile-based logMin and logMax', () => {
    // Create data with known distribution
    const n = 1000;
    const data = new Float32Array(n);
    for (let i = 0; i < n; i++) data[i] = i / n;

    const { logMin, logMax } = autoContrastStats(data);
    assert.ok(Number.isFinite(logMin), 'logMin should be finite');
    assert.ok(Number.isFinite(logMax), 'logMax should be finite');
    assert.ok(logMin < logMax, 'logMin should be less than logMax');
    // 2nd percentile of 0..1 → ~0.02, 98th → ~0.98
    assert.ok(logMin < 0.1, `logMin = ${logMin} should be near low end`);
    assert.ok(logMax > 0.9, `logMax = ${logMax} should be near high end`);
});

// ─── detectMaxFrequency ─────────────────────────────────────────────

test('detectMaxFrequency returns Nyquist for null data', () => {
    const sr = 32000;
    const result = detectMaxFrequency(null, 0, 0, sr, 'mel');
    assert.equal(result, sr / 2);
});

test('detectMaxFrequency linear scale uses linear bin mapping', () => {
    // Create data with energy concentrated in lower bins only
    const nBins = 512; // fftSize/2 = 1024/2
    const nFrames = 10;
    const data = new Float32Array(nFrames * nBins);
    // Put energy in bins 0-50 (low frequencies only)
    for (let f = 0; f < nFrames; f++) {
        for (let b = 0; b < 50; b++) {
            data[f * nBins + b] = 1.0;
        }
    }
    const sr = 32000;
    const result = detectMaxFrequency(data, nFrames, nBins, sr, 'linear');
    // Should detect max around bin 50 → ~50/512 * 16000 ≈ 1562 Hz + 10% margin
    assert.ok(result < 5000, `linear scale result ${result} should be low frequency`);
    assert.ok(result > 500, `linear scale result ${result} should be above 500 Hz`);
});

test('detectMaxFrequency mel scale uses mel mapping', () => {
    const nMels = 128;
    const nFrames = 10;
    const data = new Float32Array(nFrames * nMels);
    // Energy in all bins → should detect near Nyquist
    for (let i = 0; i < data.length; i++) data[i] = 1.0;
    const sr = 32000;
    const result = detectMaxFrequency(data, nFrames, nMels, sr, 'mel');
    // With energy everywhere, should be near Nyquist
    assert.ok(result > 10000, `mel scale result ${result} with full energy should be high`);
});
