// ═══════════════════════════════════════════════════════════════════════
// dsp.test.mjs — Tests for the shared DSP module
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    hzToMel,
    melToHz,
    buildMelFrequencies,
    createMelFilterbank,
    applyMelFilterbank,
    iterativeFFT,
    fftMagnitudeSpectrum,
    computeSpectrogram,
} from '../src/dsp.js';

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

// ─── Mel Filterbank ─────────────────────────────────────────────────

test('createMelFilterbank returns nMels filters', () => {
    const fb = createMelFilterbank(32000, 2048, 64, 0, 16000);
    assert.equal(fb.length, 64);
});

test('each mel filter has fftSize/2 bins', () => {
    const fb = createMelFilterbank(32000, 2048, 64, 0, 16000);
    for (const filter of fb) {
        assert.equal(filter.length, 1024);
    }
});

test('mel filter weights are non-negative', () => {
    const fb = createMelFilterbank(32000, 2048, 64, 0, 16000);
    for (const filter of fb) {
        for (let i = 0; i < filter.length; i++) {
            assert.ok(filter[i] >= 0, `negative weight at bin ${i}`);
        }
    }
});

test('applyMelFilterbank produces correct length', () => {
    const fb = createMelFilterbank(32000, 2048, 64, 0, 16000);
    const spectrum = new Float32Array(1024).fill(1);
    const mel = applyMelFilterbank(spectrum, fb);
    assert.equal(mel.length, 64);
});

test('applyMelFilterbank with flat spectrum produces positive values', () => {
    const fb = createMelFilterbank(32000, 2048, 64, 0, 16000);
    const spectrum = new Float32Array(1024).fill(1);
    const mel = applyMelFilterbank(spectrum, fb);
    for (let i = 0; i < mel.length; i++) {
        assert.ok(mel[i] > 0, `mel[${i}] = ${mel[i]} should be > 0`);
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

test('fftMagnitudeSpectrum returns fftSize/2 bins', () => {
    const audio = new Float32Array(2048).fill(0.5);
    const mag = fftMagnitudeSpectrum(audio, 0, 512, 1024);
    assert.equal(mag.length, 512);
});

test('fftMagnitudeSpectrum values are non-negative', () => {
    const audio = new Float32Array(2048);
    for (let i = 0; i < audio.length; i++) {
        audio[i] = Math.sin(2 * Math.PI * 440 * i / 16000);
    }
    const mag = fftMagnitudeSpectrum(audio, 0, 512, 1024);
    for (let i = 0; i < mag.length; i++) {
        assert.ok(mag[i] >= 0, `magnitude[${i}] = ${mag[i]} should be >= 0`);
    }
});

// ─── computeSpectrogram ─────────────────────────────────────────────

test('computeSpectrogram in Perch mode produces correct shape', () => {
    const sampleRate = 32000;
    const duration = 1; // 1 second
    const audio = new Float32Array(sampleRate * duration);
    // Simple sine wave
    for (let i = 0; i < audio.length; i++) {
        audio[i] = Math.sin(2 * Math.PI * 1000 * i / sampleRate);
    }

    const result = computeSpectrogram({
        channelData: audio,
        fftSize: 2048,
        sampleRate,
        frameRate: 100,
        nMels: 128,
        pcenGain: 0.98,
        pcenBias: 2,
        pcenRoot: 2,
        pcenSmoothing: 0.025,
        spectrogramMode: 'perch',
    });

    assert.ok(result.nFrames > 0, 'should have frames');
    assert.equal(result.nMels, 128, 'nMels should match');
    assert.equal(result.data.length, result.nFrames * result.nMels);
});

test('computeSpectrogram in Classic mode uses linear bins', () => {
    const sampleRate = 32000;
    const audio = new Float32Array(sampleRate); // 1 second
    for (let i = 0; i < audio.length; i++) {
        audio[i] = Math.sin(2 * Math.PI * 4000 * i / sampleRate);
    }

    const result = computeSpectrogram({
        channelData: audio,
        fftSize: 2048,
        sampleRate,
        frameRate: 100,
        nMels: 128, // ignored in classic mode
        pcenGain: 0.98,
        pcenBias: 2,
        pcenRoot: 2,
        pcenSmoothing: 0.025,
        spectrogramMode: 'classic',
    });

    assert.ok(result.nFrames > 0, 'should have frames');
    assert.equal(result.nMels, 1024, 'classic mode should use fftSize/2 bins');
    assert.equal(result.data.length, result.nFrames * result.nMels);
});

test('computeSpectrogram classic mode produces dB values', () => {
    const sampleRate = 32000;
    const audio = new Float32Array(sampleRate);
    for (let i = 0; i < audio.length; i++) {
        audio[i] = Math.sin(2 * Math.PI * 1000 * i / sampleRate);
    }

    const result = computeSpectrogram({
        channelData: audio,
        fftSize: 2048,
        sampleRate,
        frameRate: 100,
        nMels: 128,
        pcenGain: 0.98,
        pcenBias: 2,
        pcenRoot: 2,
        pcenSmoothing: 0.025,
        spectrogramMode: 'classic',
    });

    // dB values should be negative for quiet bins
    let hasNegative = false;
    for (let i = 0; i < result.data.length; i++) {
        if (result.data[i] < 0) { hasNegative = true; break; }
    }
    assert.ok(hasNegative, 'classic mode should produce negative dB values for quiet bins');
});
