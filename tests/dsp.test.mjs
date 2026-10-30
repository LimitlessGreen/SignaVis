// ═══════════════════════════════════════════════════════════════════════
// dsp.test.mjs — Tests for the shared DSP module
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    hzToMel,
    melToHz,
    buildMelFrequencies,
    iterativeFFT,
    buildCQTFrequencies,
} from '../src/domain/dsp.ts';
import { windowHopFromOverlap, fftSizeFromOversampling } from '../src/shared/constants.ts';

// ─── Mel Scale ──────────────────────────────────────────────────────

test('hzToMel(0) returns 0', () => {
    assert.equal(hzToMel(0), 0);
});

test('hzToMel and melToHz are inverse', () => {
    for (const hz of [100, 440, 1000, 4000, 8000, 16000]) {
        const mel = hzToMel(hz);
        const back = melToHz(mel);
        assert.ok(
            Math.abs(back - hz) < 0.01,
            `roundtrip failed: ${hz} → ${mel} → ${back}`,
        );
    }
});

test('hzToMel is monotonically increasing', () => {
    let prev = -1;
    for (let hz = 0; hz <= 22050; hz += 500) {
        const mel = hzToMel(hz);
        assert.ok(mel > prev, `hzToMel(${hz}) = ${mel} should be > ${prev}`);
        prev = mel;
    }
});

// ─── buildMelFrequencies ────────────────────────────────────────────

test('buildMelFrequencies returns correct length', () => {
    const freqs = buildMelFrequencies(32000, 128);
    assert.equal(freqs.length, 128);
});

test('buildMelFrequencies spans 0 Hz to Nyquist', () => {
    const freqs = buildMelFrequencies(32000, 128);
    assert.ok(freqs[0] < 10, `first freq ${freqs[0]} should be near 0 Hz`);
    assert.ok(
        Math.abs(freqs[127] - 16000) < 10,
        `last freq ${freqs[127]} should be near 16000 Hz (Nyquist)`,
    );
});

test('buildMelFrequencies is monotonically increasing', () => {
    const freqs = buildMelFrequencies(32000, 128);
    for (let i = 1; i < freqs.length; i++) {
        assert.ok(freqs[i] > freqs[i - 1], `freqs[${i}] = ${freqs[i]} should be > freqs[${i - 1}] = ${freqs[i - 1]}`);
    }
});

// ─── FFT ────────────────────────────────────────────────────────────

test('iterativeFFT of impulse gives flat spectrum', () => {
    const n = 64;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    real[0] = 1; // delta impulse

    iterativeFFT(real, imag);

    // All bins should have magnitude ~1 for a delta impulse
    for (let i = 0; i < n; i++) {
        const mag = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
        assert.ok(
            Math.abs(mag - 1) < 1e-6,
            `bin ${i}: mag = ${mag}, expected ~1`,
        );
    }
});

test('iterativeFFT of pure sine detects the right bin', () => {
    const n = 256;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    const freq = 8; // 8 cycles in n samples → bin 8

    for (let i = 0; i < n; i++) {
        real[i] = Math.sin(2 * Math.PI * freq * i / n);
    }

    iterativeFFT(real, imag);

    // Find the bin with maximum magnitude
    let maxBin = 0;
    let maxMag = 0;
    for (let i = 0; i < n / 2; i++) {
        const mag = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
        if (mag > maxMag) {
            maxMag = mag;
            maxBin = i;
        }
    }
    assert.equal(maxBin, freq, `peak should be at bin ${freq}, got ${maxBin}`);
});

// ─── FFT Twiddle Cache ─────────────────────────────────────────────

test('iterativeFFT produces identical results on repeated calls (twiddle cache)', () => {
    const n = 128;
    const makeSignal = () => {
        const real = new Float32Array(n);
        const imag = new Float32Array(n);
        for (let i = 0; i < n; i++) real[i] = Math.sin(2 * Math.PI * 5 * i / n);
        return { real, imag };
    };
    const a = makeSignal();
    iterativeFFT(a.real, a.imag);
    const b = makeSignal();
    iterativeFFT(b.real, b.imag);

    for (let i = 0; i < n; i++) {
        assert.ok(Math.abs(a.real[i] - b.real[i]) < 1e-10, `real[${i}] mismatch`);
        assert.ok(Math.abs(a.imag[i] - b.imag[i]) < 1e-10, `imag[${i}] mismatch`);
    }
});

// ── windowHopFromOverlap (SV getWindowIncrement port) ──────────────

test('windowHopFromOverlap level 0 returns windowSize (no overlap)', () => {
    assert.equal(windowHopFromOverlap(1024, 0), 1024);
    assert.equal(windowHopFromOverlap(2048, 0), 2048);
});

test('windowHopFromOverlap level 1 returns 3/4 windowSize (25% overlap)', () => {
    assert.equal(windowHopFromOverlap(1024, 1), 768);
    assert.equal(windowHopFromOverlap(2048, 1), 1536);
});

test('windowHopFromOverlap level 2 returns 1/2 windowSize (50% overlap)', () => {
    assert.equal(windowHopFromOverlap(1024, 2), 512);
    assert.equal(windowHopFromOverlap(2048, 2), 1024);
});

test('windowHopFromOverlap level 3 returns 1/4 windowSize (75% overlap)', () => {
    assert.equal(windowHopFromOverlap(1024, 3), 256);
    assert.equal(windowHopFromOverlap(2048, 3), 512);
});

test('windowHopFromOverlap level 4 returns 1/8 windowSize (87.5% overlap)', () => {
    assert.equal(windowHopFromOverlap(1024, 4), 128);
    assert.equal(windowHopFromOverlap(2048, 4), 256);
});

test('windowHopFromOverlap level 5 returns 1/16 windowSize (93.75% overlap)', () => {
    assert.equal(windowHopFromOverlap(1024, 5), 64);
    assert.equal(windowHopFromOverlap(2048, 5), 128);
});

// ── fftSizeFromOversampling ────────────────────────────────────────

test('fftSizeFromOversampling level 0 returns windowSize (1×)', () => {
    assert.equal(fftSizeFromOversampling(1024, 0), 1024);
    assert.equal(fftSizeFromOversampling(2048, 0), 2048);
});

test('fftSizeFromOversampling level 1 returns 2× windowSize', () => {
    assert.equal(fftSizeFromOversampling(1024, 1), 2048);
    assert.equal(fftSizeFromOversampling(2048, 1), 4096);
});

test('fftSizeFromOversampling level 2 returns 4× windowSize', () => {
    assert.equal(fftSizeFromOversampling(1024, 2), 4096);
    assert.equal(fftSizeFromOversampling(2048, 2), 8192);
});

test('fftSizeFromOversampling level 3 returns 8× windowSize', () => {
    assert.equal(fftSizeFromOversampling(1024, 3), 8192);
    assert.equal(fftSizeFromOversampling(2048, 3), 16384);
});

// ─── CQT Filterbank ────────────────────────────────────────────────

test('buildCQTFrequencies returns correct length and log spacing', () => {
    const nBins = 48, fMin = 100, bpo = 24;
    const freqs = buildCQTFrequencies(nBins, fMin, bpo);
    assert.equal(freqs.length, nBins);
    assert.ok(Math.abs(freqs[0] - fMin) < 0.01, `first bin should be fMin (${freqs[0]})`);

    // Check log spacing: each bin should be 2^(1/bpo) times the previous
    const ratio = Math.pow(2, 1 / bpo);
    for (let k = 1; k < nBins; k++) {
        const expected = fMin * Math.pow(2, k / bpo);
        assert.ok(Math.abs(freqs[k] - expected) < 0.01,
            `bin ${k}: got ${freqs[k]}, expected ${expected}`);
    }
});

test('buildCQTFrequencies is monotonically increasing', () => {
    const freqs = buildCQTFrequencies(96, 32.7, 24);
    for (let k = 1; k < freqs.length; k++) {
        assert.ok(freqs[k] > freqs[k - 1], `bin ${k} (${freqs[k]}) should be > bin ${k - 1} (${freqs[k - 1]})`);
    }
});
