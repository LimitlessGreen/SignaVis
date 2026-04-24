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
    fftMagnitudePhaseSpectrum,
    iecDbToFader,
    computeSpectrogram,
    WINDOW_FUNCTION_KEYS,
    createCQTFilterbank,
    buildCQTFrequencies,
    computeReassignedSpectrogram,
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

test('createMelFilterbank degenerate filters produce non-zero output with flat spectrum', () => {
    // Small FFT (256 → 128 bins) with 128 mel bands causes many degenerate
    // filters in the low frequencies. The point-filter fallback must ensure
    // every mel band picks up energy from a flat spectrum (no white stripes).
    const fb = createMelFilterbank(32000, 256, 128, 0, 16000);
    const spectrum = new Float32Array(128).fill(1);
    const mel = applyMelFilterbank(spectrum, fb);
    for (let i = 0; i < mel.length; i++) {
        assert.ok(mel[i] > 0, `mel[${i}] = ${mel[i]} should be > 0 (degenerate filter?)`);
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

test('computeSpectrogram in mel scale produces correct shape', () => {
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
        scale: 'mel',
    });

    assert.ok(result.nFrames > 0, 'should have frames');
    assert.equal(result.nMels, 128, 'nMels should match');
    assert.equal(result.data.length, result.nFrames * result.nMels);
});

test('computeSpectrogram in linear scale uses linear bins', () => {
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
        nMels: 128, // ignored in linear scale
        pcenGain: 0.98,
        pcenBias: 2,
        pcenRoot: 2,
        pcenSmoothing: 0.025,
        scale: 'linear',
    });

    assert.ok(result.nFrames > 0, 'should have frames');
    assert.equal(result.nMels, 1024, 'linear scale should use fftSize/2 bins');
    assert.equal(result.data.length, result.nFrames * result.nMels);
});

test('computeSpectrogram linear scale produces dB values', () => {
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
        scale: 'linear',
    });

    // dB values should be negative for quiet bins
    let hasNegative = false;
    for (let i = 0; i < result.data.length; i++) {
        if (result.data[i] < 0) { hasNegative = true; break; }
    }
    assert.ok(hasNegative, 'linear scale should produce negative dB values for quiet bins');
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

test('computeSpectrogram mel+PCEN returns smoothState', () => {
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
        scale: 'mel',
        usePcen: true,
    });

    assert.ok(result.smoothState, 'mel+PCEN should return smoothState');
    assert.equal(result.smoothState.length, 128, 'smoothState should have nMels entries');
    // smoothState should have non-zero values after processing a signal
    let hasNonZero = false;
    for (let i = 0; i < result.smoothState.length; i++) {
        if (result.smoothState[i] > 0) { hasNonZero = true; break; }
    }
    assert.ok(hasNonZero, 'smoothState should have non-zero values');
});

test('computeSpectrogram linear scale does not return smoothState', () => {
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
        scale: 'linear',
    });
    assert.ok(!result.smoothState, 'linear scale should not return smoothState');
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
        scale: 'mel',
        usePcen: true,
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
        scale: 'mel',
        usePcen: true,
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

// ═══════════════════════════════════════════════════════════════════════
// fftMagnitudePhaseSpectrum
// ═══════════════════════════════════════════════════════════════════════

test('fftMagnitudePhaseSpectrum returns magnitude and phase arrays', () => {
    const n = 2048;
    const audio = new Float32Array(n);
    for (let i = 0; i < n; i++) audio[i] = Math.sin(2 * Math.PI * 5 * i / n);
    const { magnitude, phase } = fftMagnitudePhaseSpectrum(audio, 0, n, n);
    assert.equal(magnitude.length, n / 2, 'magnitude should have fftSize/2 bins');
    assert.equal(phase.length, n / 2, 'phase should have fftSize/2 bins');
});

test('fftMagnitudePhaseSpectrum phase values are in [-π, +π]', () => {
    const n = 1024;
    const audio = new Float32Array(n);
    for (let i = 0; i < n; i++) audio[i] = Math.sin(2 * Math.PI * 10 * i / n) + 0.5 * Math.cos(2 * Math.PI * 50 * i / n);
    const { phase } = fftMagnitudePhaseSpectrum(audio, 0, n, n);
    for (let k = 0; k < phase.length; k++) {
        assert.ok(phase[k] >= -Math.PI - 1e-6 && phase[k] <= Math.PI + 1e-6,
            `phase[${k}] = ${phase[k]} should be in [-π, π]`);
    }
});

test('fftMagnitudePhaseSpectrum magnitude matches fftMagnitudeSpectrum', () => {
    const n = 2048;
    const audio = new Float32Array(n);
    for (let i = 0; i < n; i++) audio[i] = Math.sin(2 * Math.PI * 100 * i / n);
    const mag = fftMagnitudeSpectrum(audio, 0, n, n);
    const { magnitude } = fftMagnitudePhaseSpectrum(audio, 0, n, n);
    for (let k = 0; k < mag.length; k++) {
        assert.ok(Math.abs(mag[k] - magnitude[k]) < 1e-6,
            `magnitude[${k}] should match fftMagnitudeSpectrum (${magnitude[k]} vs ${mag[k]})`);
    }
});

// ═══════════════════════════════════════════════════════════════════════
// iecDbToFader — IEC 60268-18 meter law
// ═══════════════════════════════════════════════════════════════════════

test('iecDbToFader returns 0 for values ≤ -70 dB', () => {
    assert.equal(iecDbToFader(-70), 0);
    assert.equal(iecDbToFader(-80), 0);
    assert.equal(iecDbToFader(-100), 0);
});

test('iecDbToFader returns 100 for 0 dB', () => {
    assert.ok(Math.abs(iecDbToFader(0) - 100) < 1e-6,
        `iecDbToFader(0) = ${iecDbToFader(0)} should be 100`);
});

test('iecDbToFader known IEC breakpoint values', () => {
    // At -60 dB: 0.25 * (-60 - (-70)) + 0 = 2.5
    assert.ok(Math.abs(iecDbToFader(-60) - 2.5) < 1e-6, '-60 dB → 2.5');
    // At -50 dB: 0.5 * (-50 - (-60)) + 2.5 = 7.5
    assert.ok(Math.abs(iecDbToFader(-50) - 7.5) < 1e-6, '-50 dB → 7.5');
    // At -40 dB: 0.75 * (-40 - (-50)) + 7.5 = 15
    assert.ok(Math.abs(iecDbToFader(-40) - 15) < 1e-6, '-40 dB → 15');
    // At -30 dB: 1.5 * (-30 - (-40)) + 15 = 30
    assert.ok(Math.abs(iecDbToFader(-30) - 30) < 1e-6, '-30 dB → 30');
    // At -20 dB: 2.0 * (-20 - (-30)) + 30 = 50
    assert.ok(Math.abs(iecDbToFader(-20) - 50) < 1e-6, '-20 dB → 50');
});

test('iecDbToFader is monotonically increasing', () => {
    let prev = iecDbToFader(-70);
    for (let db = -69; db <= 0; db++) {
        const curr = iecDbToFader(db);
        assert.ok(curr >= prev, `iecDbToFader(${db}) = ${curr} should be >= iecDbToFader(${db - 1}) = ${prev}`);
        prev = curr;
    }
});

// ═══════════════════════════════════════════════════════════════════════
// computeSpectrogram — colourScale modes
// ═══════════════════════════════════════════════════════════════════════

test('computeSpectrogram colourScale=linear produces non-negative values', () => {
    const sr = 32000;
    const audio = new Float32Array(sr * 0.5);
    for (let i = 0; i < audio.length; i++) audio[i] = Math.sin(2 * Math.PI * 1000 * i / sr);
    const result = computeSpectrogram({
        channelData: audio, fftSize: 2048, sampleRate: sr, frameRate: 100,
        nMels: 128, scale: 'linear', colourScale: 'linear',
    });
    assert.equal(result.colourScale, 'linear');
    for (let i = 0; i < result.data.length; i++) {
        assert.ok(result.data[i] >= 0, `data[${i}] = ${result.data[i]} should be >= 0 (raw magnitude)`);
    }
});

test('computeSpectrogram colourScale=meter produces non-negative values', () => {
    const sr = 32000;
    const audio = new Float32Array(sr * 0.5);
    for (let i = 0; i < audio.length; i++) audio[i] = 0.8 * Math.sin(2 * Math.PI * 440 * i / sr);
    const result = computeSpectrogram({
        channelData: audio, fftSize: 2048, sampleRate: sr, frameRate: 100,
        nMels: 128, scale: 'linear', colourScale: 'meter',
    });
    assert.equal(result.colourScale, 'meter');
    for (let i = 0; i < result.data.length; i++) {
        assert.ok(result.data[i] >= 0, `data[${i}] should be >= 0 (raw magnitude for meter)`);
    }
});

test('computeSpectrogram colourScale=db produces negative dB values for quiet bins', () => {
    const sr = 32000;
    const audio = new Float32Array(sr * 0.5);
    for (let i = 0; i < audio.length; i++) audio[i] = 0.01 * Math.sin(2 * Math.PI * 1000 * i / sr);
    const result = computeSpectrogram({
        channelData: audio, fftSize: 2048, sampleRate: sr, frameRate: 100,
        nMels: 128, scale: 'linear', colourScale: 'db',
    });
    assert.equal(result.colourScale, 'db');
    let hasNeg = false;
    for (let i = 0; i < result.data.length; i++) {
        if (result.data[i] < 0) { hasNeg = true; break; }
    }
    assert.ok(hasNeg, 'dB scale should have negative values for quiet bins');
});

test('computeSpectrogram colourScale=dbSquared backward compatible with default', () => {
    const sr = 32000;
    const audio = new Float32Array(sr * 0.5);
    for (let i = 0; i < audio.length; i++) audio[i] = Math.sin(2 * Math.PI * 2000 * i / sr);
    const explicit = computeSpectrogram({
        channelData: audio, fftSize: 2048, sampleRate: sr, frameRate: 100,
        nMels: 128, scale: 'linear', colourScale: 'dbSquared',
    });
    const implicit = computeSpectrogram({
        channelData: audio, fftSize: 2048, sampleRate: sr, frameRate: 100,
        nMels: 128, scale: 'linear',
    });
    assert.equal(explicit.colourScale, 'dbSquared');
    assert.equal(implicit.colourScale, 'dbSquared');
    for (let i = 0; i < explicit.data.length; i++) {
        assert.ok(Math.abs(explicit.data[i] - implicit.data[i]) < 1e-10,
            `dbSquared explicit vs implicit mismatch at [${i}]`);
    }
});

test('computeSpectrogram colourScale=phase produces values in [-π, +π]', () => {
    const sr = 32000;
    const audio = new Float32Array(sr * 0.5);
    for (let i = 0; i < audio.length; i++) audio[i] = Math.sin(2 * Math.PI * 500 * i / sr);
    const result = computeSpectrogram({
        channelData: audio, fftSize: 2048, sampleRate: sr, frameRate: 100,
        nMels: 128, scale: 'linear', colourScale: 'phase',
    });
    assert.equal(result.colourScale, 'phase');
    for (let i = 0; i < result.data.length; i++) {
        assert.ok(result.data[i] >= -Math.PI - 1e-6 && result.data[i] <= Math.PI + 1e-6,
            `phase data[${i}] = ${result.data[i]} should be in [-π, π]`);
    }
});

test('computeSpectrogram colourScale=phase mel scale produces values in [-π, +π]', () => {
    const sr = 32000;
    const audio = new Float32Array(sr * 0.5);
    for (let i = 0; i < audio.length; i++) audio[i] = Math.sin(2 * Math.PI * 1000 * i / sr);
    const result = computeSpectrogram({
        channelData: audio, fftSize: 2048, sampleRate: sr, frameRate: 100,
        nMels: 128, scale: 'mel', colourScale: 'phase',
    });
    assert.equal(result.colourScale, 'phase');
    assert.equal(result.nMels, 128);
    for (let i = 0; i < result.data.length; i++) {
        assert.ok(result.data[i] >= -Math.PI - 1e-6 && result.data[i] <= Math.PI + 1e-6,
            `mel phase data[${i}] = ${result.data[i]} should be in [-π, π]`);
    }
});

test('computeSpectrogram colourScale=linear mel without PCEN produces non-negative values', () => {
    const sr = 32000;
    const audio = new Float32Array(sr * 0.5);
    for (let i = 0; i < audio.length; i++) audio[i] = Math.sin(2 * Math.PI * 3000 * i / sr);
    const result = computeSpectrogram({
        channelData: audio, fftSize: 2048, sampleRate: sr, frameRate: 100,
        nMels: 128, scale: 'mel', usePcen: false, colourScale: 'linear',
    });
    assert.equal(result.colourScale, 'linear');
    for (let i = 0; i < result.data.length; i++) {
        assert.ok(result.data[i] >= 0, `mel linear data[${i}] = ${result.data[i]} should be >= 0`);
    }
});

test('computeSpectrogram result includes colourScale field', () => {
    const sr = 16000;
    const audio = new Float32Array(sr * 0.2);
    for (const cs of ['linear', 'meter', 'dbSquared', 'db', 'phase']) {
        const result = computeSpectrogram({
            channelData: audio, fftSize: 1024, sampleRate: sr, frameRate: 50,
            nMels: 64, scale: 'linear', colourScale: cs,
        });
        assert.equal(result.colourScale, cs, `result should include colourScale=${cs}`);
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

// ─── Window Functions ───────────────────────────────────────────────

test('WINDOW_FUNCTION_KEYS contains all 6 window types', () => {
    const expected = ['hann', 'hamming', 'blackman', 'blackmanHarris', 'flatTop', 'kaiser'];
    for (const key of expected) {
        assert.ok(WINDOW_FUNCTION_KEYS.includes(key), `missing window: ${key}`);
    }
    assert.equal(WINDOW_FUNCTION_KEYS.length, expected.length);
});

test('all window functions work in fftMagnitudeSpectrum', () => {
    const sr = 16000, len = sr; // 1 second
    const audio = new Float32Array(len);
    // 1kHz sine
    for (let i = 0; i < len; i++) audio[i] = Math.sin(2 * Math.PI * 1000 * i / sr);

    for (const wf of WINDOW_FUNCTION_KEYS) {
        const spec = fftMagnitudeSpectrum(audio, 0, 1024, 1024, wf);
        assert.equal(spec.length, 512, `${wf}: should return fftSize/2 bins`);
        // Energy should be non-negative and the peak should be near bin 64 (1kHz)
        let maxBin = 0, maxVal = -Infinity;
        for (let i = 0; i < spec.length; i++) {
            assert.ok(spec[i] >= 0, `${wf}: negative value at bin ${i}`);
            if (spec[i] > maxVal) { maxVal = spec[i]; maxBin = i; }
        }
        assert.ok(Math.abs(maxBin - 64) <= 2, `${wf}: peak at ${maxBin}, expected ~64`);
    }
});

// ─── CQT Filterbank ────────────────────────────────────────────────

test('createCQTFilterbank returns correct number of bins', () => {
    const nBins = 96; // 4 octaves × 24 bpo
    const fb = createCQTFilterbank(16000, 1024, nBins, 32.7, 24);
    assert.equal(fb.length, nBins);
});

test('createCQTFilterbank each filter has positive weights and start index', () => {
    const fb = createCQTFilterbank(16000, 2048, 48, 100, 24);
    for (let k = 0; k < fb.length; k++) {
        assert.ok(fb[k].start >= 0, `filter ${k}: start should be ≥ 0`);
        assert.ok(fb[k].weights.length >= 1, `filter ${k}: should have at least 1 weight`);
        let sum = 0;
        for (const w of fb[k].weights) {
            assert.ok(w >= 0, `filter ${k}: weight should be ≥ 0`);
            sum += w;
        }
        assert.ok(sum > 0, `filter ${k}: total weight should be > 0`);
    }
});

test('createCQTFilterbank weights are normalised to sum ≈ 1', () => {
    const fb = createCQTFilterbank(16000, 2048, 48, 100, 24);
    for (let k = 0; k < fb.length; k++) {
        let sum = 0;
        for (const w of fb[k].weights) sum += w;
        assert.ok(Math.abs(sum - 1) < 0.01, `filter ${k}: sum=${sum}, expected ~1`);
    }
});

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

// ─── Reassigned Spectrogram ─────────────────────────────────────────

test('computeReassignedSpectrogram returns correct shape (linear)', () => {
    const sr = 16000, duration = 0.5;
    const len = sr * duration;
    const audio = new Float32Array(len);
    for (let i = 0; i < len; i++) audio[i] = Math.sin(2 * Math.PI * 1000 * i / sr);

    const result = computeReassignedSpectrogram({
        channelData: audio, fftSize: 1024, sampleRate: sr,
        frameRate: 100, nMels: 128, scale: 'linear',
    });
    assert.ok(result.nFrames > 0, 'should produce frames');
    assert.equal(result.nMels, 512, 'linear: nMels should be fftSize/2');
    assert.equal(result.data.length, result.nFrames * result.nMels);
    assert.equal(result.colourScale, 'dbSquared');
});

test('computeReassignedSpectrogram returns correct shape (mel)', () => {
    const sr = 16000, len = sr;
    const audio = new Float32Array(len);
    for (let i = 0; i < len; i++) audio[i] = Math.sin(2 * Math.PI * 2000 * i / sr);

    const result = computeReassignedSpectrogram({
        channelData: audio, fftSize: 1024, sampleRate: sr,
        frameRate: 100, nMels: 64, scale: 'mel',
    });
    assert.ok(result.nFrames > 0);
    assert.equal(result.nMels, 64);
    assert.equal(result.data.length, result.nFrames * result.nMels);
});

test('computeReassignedSpectrogram detects sine frequency (linear)', () => {
    const sr = 16000, len = sr;
    const audio = new Float32Array(len);
    const freq = 2000;
    for (let i = 0; i < len; i++) audio[i] = Math.sin(2 * Math.PI * freq * i / sr);

    const result = computeReassignedSpectrogram({
        channelData: audio, fftSize: 1024, sampleRate: sr,
        frameRate: 100, nMels: 128, scale: 'linear',
        colourScale: 'linear',
    });

    // Find bin with maximum energy — should be near the 2kHz bin
    const nBins = result.nMels;
    const avgEnergy = new Float32Array(nBins);
    for (let f = 0; f < result.nFrames; f++) {
        for (let b = 0; b < nBins; b++) {
            avgEnergy[b] += result.data[f * nBins + b];
        }
    }
    let peakBin = 0, peakVal = -Infinity;
    for (let b = 0; b < nBins; b++) {
        if (avgEnergy[b] > peakVal) { peakVal = avgEnergy[b]; peakBin = b; }
    }
    const expectedBin = Math.round(freq * 1024 / sr);
    assert.ok(Math.abs(peakBin - expectedBin) <= 3,
        `peak at bin ${peakBin}, expected ~${expectedBin} (2kHz)`);
});

test('computeSpectrogram with scale=cqt uses CQT filterbank', () => {
    const sr = 16000, len = sr;
    const audio = new Float32Array(len);
    for (let i = 0; i < len; i++) audio[i] = Math.sin(2 * Math.PI * 1000 * i / sr);

    const nMels = 96; // 4 octaves × 24 bpo
    const result = computeSpectrogram({
        channelData: audio, fftSize: 1024, sampleRate: sr,
        frameRate: 100, nMels, scale: 'cqt', usePcen: false,
    });
    assert.ok(result.nFrames > 0);
    assert.equal(result.nMels, nMels);
    assert.equal(result.data.length, result.nFrames * nMels);

    // Energy should be concentrated in the CQT bin nearest 1kHz
    // CQT bin k has center freq = 32.7 * 2^(k/24)
    // 1000 Hz → k = 24 * log2(1000/32.7) ≈ 24 * 4.93 ≈ 118 — but we only have 96 bins
    // With fMin=32.7 and 96 bins: max freq = 32.7 * 2^(96/24) = 32.7 * 16 = 523 Hz
    // So 1kHz is above our CQT range → energy lands in highest bins
    // Let's use a lower frequency instead
    const audio2 = new Float32Array(len);
    for (let i = 0; i < len; i++) audio2[i] = Math.sin(2 * Math.PI * 200 * i / sr);
    const result2 = computeSpectrogram({
        channelData: audio2, fftSize: 1024, sampleRate: sr,
        frameRate: 100, nMels, scale: 'cqt', usePcen: false,
    });
    // 200 Hz → k = 24 * log2(200/32.7) ≈ 24 * 2.61 ≈ 63
    const expectedBinCQT = Math.round(24 * Math.log2(200 / 32.7));
    const avgE = new Float32Array(nMels);
    for (let f = 0; f < result2.nFrames; f++) {
        for (let b = 0; b < nMels; b++) avgE[b] += result2.data[f * nMels + b];
    }
    let peak = 0, peakV = -Infinity;
    for (let b = 0; b < nMels; b++) {
        if (avgE[b] > peakV) { peakV = avgE[b]; peak = b; }
    }
    assert.ok(Math.abs(peak - expectedBinCQT) <= 3,
        `CQT peak at bin ${peak}, expected ~${expectedBinCQT} (200 Hz)`);
});
