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

// ─── PCEN smooth state carry-over ───────────────────────────────────

test('computeSpectrogram Perch mode returns smoothState', () => {
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
        spectrogramMode: 'perch',
    });

    assert.ok(result.smoothState, 'Perch mode should return smoothState');
    assert.equal(result.smoothState.length, 128, 'smoothState should have nMels entries');
    // smoothState should have non-zero values after processing a signal
    let hasNonZero = false;
    for (let i = 0; i < result.smoothState.length; i++) {
        if (result.smoothState[i] > 0) { hasNonZero = true; break; }
    }
    assert.ok(hasNonZero, 'smoothState should have non-zero values');
});

test('computeSpectrogram Classic mode does not return smoothState', () => {
    const sampleRate = 32000;
    const audio = new Float32Array(sampleRate);
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
    assert.ok(!result.smoothState, 'Classic mode should not return smoothState');
});

test('computeSpectrogram initialSmooth affects output', () => {
    const sampleRate = 32000;
    const audio = new Float32Array(sampleRate * 0.5); // 0.5s
    for (let i = 0; i < audio.length; i++) {
        audio[i] = Math.sin(2 * Math.PI * 2000 * i / sampleRate);
    }
    const opts = {
        fftSize: 2048,
        sampleRate,
        frameRate: 100,
        nMels: 128,
        pcenGain: 0.98,
        pcenBias: 2,
        pcenRoot: 2,
        pcenSmoothing: 0.025,
        spectrogramMode: 'perch',
    };

    // Run without initialSmooth
    const r1 = computeSpectrogram({ channelData: audio, ...opts });
    // Run with initialSmooth from a previous chunk
    const warmSmooth = new Float32Array(128).fill(0.5);
    const r2 = computeSpectrogram({ channelData: audio, ...opts, initialSmooth: warmSmooth });

    // First frame should differ because smooth state is different
    let differ = false;
    for (let m = 0; m < 128; m++) {
        if (Math.abs(r1.data[m] - r2.data[m]) > 1e-6) { differ = true; break; }
    }
    assert.ok(differ, 'initialSmooth should affect the first frames of output');
});

test('two-chunk progressive simulation matches single-pass at chunk boundary', () => {
    const sampleRate = 32000;
    const audio = new Float32Array(sampleRate); // 1 second
    for (let i = 0; i < audio.length; i++) {
        audio[i] = Math.sin(2 * Math.PI * 3000 * i / sampleRate) * 0.5;
    }
    const opts = {
        fftSize: 2048,
        sampleRate,
        frameRate: 100,
        nMels: 128,
        pcenGain: 0.98,
        pcenBias: 2,
        pcenRoot: 2,
        pcenSmoothing: 0.025,
        spectrogramMode: 'perch',
    };

    // Single pass
    const full = computeSpectrogram({ channelData: audio, ...opts });

    // Two-chunk pass with smooth carry-over
    const half = Math.floor(audio.length / 2);
    const chunk1 = computeSpectrogram({ channelData: audio.subarray(0, half), ...opts });
    const chunk2 = computeSpectrogram({
        channelData: audio.subarray(half),
        ...opts,
        initialSmooth: chunk1.smoothState,
    });

    // The last frame of chunk2 should be close to the corresponding frame in full
    // (not exact because hop alignment may differ slightly at boundaries)
    const fullLastBase = (full.nFrames - 1) * 128;
    const c2LastBase   = (chunk2.nFrames - 1) * 128;
    let maxDiff = 0;
    for (let m = 0; m < 128; m++) {
        const diff = Math.abs(full.data[fullLastBase + m] - chunk2.data[c2LastBase + m]);
        if (diff > maxDiff) maxDiff = diff;
    }
    // With proper smooth state carry-over, the last frames should be reasonably close
    // (exact match not expected due to different hop-alignment at split point)
    assert.ok(maxDiff < 2.0, `max difference at last frame: ${maxDiff} should be < 2.0`);
});
