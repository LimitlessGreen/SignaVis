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
    buildSpectrogramGrayscale,
    pixelYToFrequency,
    frequencyToPixelY,
    spectralSubtract,
    applyCLAHE,
} from '../src/spectrogram.js';
import { computeSpectrogram, buildMelFrequencies } from '../src/dsp.js';
import { MAX_BASE_SPECTROGRAM_WIDTH } from '../src/constants.js';

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

test('detectMaxFrequency handles dB (negative) values correctly', () => {
    // Simulate linear-scale dB data: 10·log₁₀(power)
    // Low bins (0-50) have signal at -30 dB, rest is silence at -200 dB
    const nBins = 512;
    const nFrames = 10;
    const data = new Float32Array(nFrames * nBins);
    for (let f = 0; f < nFrames; f++) {
        for (let b = 0; b < nBins; b++) {
            data[f * nBins + b] = b < 50 ? -30 : -200;
        }
    }
    const sr = 32000;
    const result = detectMaxFrequency(data, nFrames, nBins, sr, 'linear');
    // Should detect signal in bins 0-50 → ~50/512 * 16000 ≈ 1562 Hz + margin
    assert.ok(result < 5000, `dB data result ${result} should detect low-freq signal`);
    assert.ok(result > 500, `dB data result ${result} should be above 500 Hz`);
});

// ═══════════════════════════════════════════════════════════════════════
// buildSpectrogramGrayscale
// ═══════════════════════════════════════════════════════════════════════

test('buildSpectrogramGrayscale returns null for empty data', () => {
    assert.equal(buildSpectrogramGrayscale({
        spectrogramData: null, spectrogramFrames: 0, spectrogramMels: 0,
        sampleRateHz: 32000, maxFreq: 16000,
        spectrogramAbsLogMin: -5, spectrogramAbsLogMax: 5,
    }), null);
});

test('buildSpectrogramGrayscale returns correct dimensions', () => {
    const nFrames = 50, nMels = 64;
    const data = new Float32Array(nFrames * nMels).fill(0.5);
    const result = buildSpectrogramGrayscale({
        spectrogramData: data, spectrogramFrames: nFrames, spectrogramMels: nMels,
        sampleRateHz: 32000, maxFreq: 16000,
        spectrogramAbsLogMin: 0, spectrogramAbsLogMax: 1, scale: 'mel',
    });
    assert.ok(result !== null);
    assert.equal(result.width, nFrames); // nFrames < MAX_BASE_SPECTROGRAM_WIDTH
    assert.equal(result.height, nMels);
    assert.equal(result.gray.length, result.width * result.height);
});

test('buildSpectrogramGrayscale caps width at MAX_BASE_SPECTROGRAM_WIDTH', () => {
    const nFrames = MAX_BASE_SPECTROGRAM_WIDTH + 1000;
    const nMels = 4;
    const data = new Float32Array(nFrames * nMels).fill(1);
    const result = buildSpectrogramGrayscale({
        spectrogramData: data, spectrogramFrames: nFrames, spectrogramMels: nMels,
        sampleRateHz: 32000, maxFreq: 16000,
        spectrogramAbsLogMin: 0, spectrogramAbsLogMax: 1,
    });
    assert.equal(result.width, MAX_BASE_SPECTROGRAM_WIDTH);
});

test('buildSpectrogramGrayscale grayscale values are in [0, 255]', () => {
    const nFrames = 100, nMels = 32;
    const data = new Float32Array(nFrames * nMels);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() - 0.5) * 10;
    const result = buildSpectrogramGrayscale({
        spectrogramData: data, spectrogramFrames: nFrames, spectrogramMels: nMels,
        sampleRateHz: 32000, maxFreq: 16000,
        spectrogramAbsLogMin: -5, spectrogramAbsLogMax: 5,
    });
    for (let i = 0; i < result.gray.length; i++) {
        assert.ok(result.gray[i] >= 0 && result.gray[i] <= 255,
            `gray[${i}] = ${result.gray[i]} out of range`);
    }
});

test('buildSpectrogramGrayscale uniform data produces uniform gray', () => {
    const nFrames = 20, nMels = 16;
    const data = new Float32Array(nFrames * nMels).fill(0.5);
    const result = buildSpectrogramGrayscale({
        spectrogramData: data, spectrogramFrames: nFrames, spectrogramMels: nMels,
        sampleRateHz: 32000, maxFreq: 16000,
        spectrogramAbsLogMin: 0, spectrogramAbsLogMax: 1, scale: 'mel',
    });
    // All pixels should be the same gray value (data is uniform)
    const expected = result.gray[0];
    let allSame = true;
    for (let i = 1; i < result.gray.length; i++) {
        if (result.gray[i] !== expected) { allSame = false; break; }
    }
    assert.ok(allSame, `uniform input should produce uniform output (got ${expected})`);
});

test('buildSpectrogramGrayscale minimum data maps to 0, maximum to 1', () => {
    const nFrames = 10, nMels = 8;
    const logMin = -4, logMax = 4;
    // Fill with logMin → should all be 0
    const dataMin = new Float32Array(nFrames * nMels).fill(logMin);
    const rMin = buildSpectrogramGrayscale({
        spectrogramData: dataMin, spectrogramFrames: nFrames, spectrogramMels: nMels,
        sampleRateHz: 32000, maxFreq: 16000,
        spectrogramAbsLogMin: logMin, spectrogramAbsLogMax: logMax,
    });
    for (let i = 0; i < rMin.gray.length; i++) {
        assert.ok(Math.abs(rMin.gray[i]) < 1e-6, 'min data should map to 0');
    }
    // Fill with logMax → should all be 1
    const dataMax = new Float32Array(nFrames * nMels).fill(logMax);
    const rMax = buildSpectrogramGrayscale({
        spectrogramData: dataMax, spectrogramFrames: nFrames, spectrogramMels: nMels,
        sampleRateHz: 32000, maxFreq: 16000,
        spectrogramAbsLogMin: logMin, spectrogramAbsLogMax: logMax,
    });
    for (let i = 0; i < rMax.gray.length; i++) {
        assert.ok(Math.abs(rMax.gray[i] - 1) < 1e-6, 'max data should map to 1');
    }
});

test('buildSpectrogramGrayscale no duplicate frames across pixel columns', () => {
    // Each frame has a unique value so we can detect if frames are shared
    const nFrames = 20, nMels = 4;
    const data = new Float32Array(nFrames * nMels);
    for (let f = 0; f < nFrames; f++) {
        for (let m = 0; m < nMels; m++) {
            data[f * nMels + m] = f; // frame index as value
        }
    }
    const result = buildSpectrogramGrayscale({
        spectrogramData: data, spectrogramFrames: nFrames, spectrogramMels: nMels,
        sampleRateHz: 32000, maxFreq: 16000,
        spectrogramAbsLogMin: 0, spectrogramAbsLogMax: nFrames - 1,
    });
    // Width === nFrames (small data), so each pixel = 1 frame
    assert.equal(result.width, nFrames);
    // Bottom row (y = height-1 → bin 0) should be monotonically non-decreasing
    const bottom = result.height - 1;
    for (let x = 1; x < result.width; x++) {
        const prev = result.gray[bottom * result.width + (x - 1)];
        const curr = result.gray[bottom * result.width + x];
        assert.ok(curr >= prev,
            `column ${x} (${curr}) should be >= column ${x - 1} (${prev})`);
    }
});

test('buildSpectrogramGrayscale bilinear Y interpolation produces smooth gradient', () => {
    // Create data with a linear gradient across mel bins
    const nFrames = 1, nMels = 32;
    const data = new Float32Array(nFrames * nMels);
    for (let m = 0; m < nMels; m++) data[m] = m / (nMels - 1); // 0..1

    const result = buildSpectrogramGrayscale({
        spectrogramData: data, spectrogramFrames: nFrames, spectrogramMels: nMels,
        sampleRateHz: 32000, maxFreq: 16000,
        spectrogramAbsLogMin: 0, spectrogramAbsLogMax: 1, scale: 'mel',
    });
    // Y=0 is top (high freq = high bin = high value), Y=height-1 is bottom (low freq = low value)
    // Check that adjacent Y pixels don't jump by more than a few gray levels
    let maxJump = 0;
    for (let y = 1; y < result.height; y++) {
        const diff = Math.abs(result.gray[y] - result.gray[y - 1]);
        if (diff > maxJump) maxJump = diff;
    }
    // With bilinear interpolation, max single-step jump should be small
    // (height pixels mapping 32 bins → small fractional step per pixel)
    assert.ok(maxJump <= 0.05, `max Y jump is ${maxJump}, should be smooth (≤0.05)`);
});

test('buildSpectrogramGrayscale linear scale respects maxFreq', () => {
    // Linear scale: 512 bins, sampleRate=32000 → Nyquist=16000
    // maxFreq=8000 → only lower half of bins should appear
    const nFrames = 10, nBins = 512;
    const data = new Float32Array(nFrames * nBins);
    // Energy only in upper bins (well above 8000 Hz)
    for (let f = 0; f < nFrames; f++) {
        for (let b = 300; b < nBins; b++) data[f * nBins + b] = 1.0;
    }
    const result = buildSpectrogramGrayscale({
        spectrogramData: data, spectrogramFrames: nFrames, spectrogramMels: nBins,
        sampleRateHz: 32000, maxFreq: 8000,
        spectrogramAbsLogMin: 0, spectrogramAbsLogMax: 1, scale: 'linear',
    });
    // With maxFreq=8000, maxBin ≈ 256, so bins above that are clipped
    // The visible portion only covers bins 0-255 which have 0 energy → all gray = 0
    for (let i = 0; i < result.gray.length; i++) {
        assert.equal(result.gray[i], 0,
            'energy above maxFreq should not appear in grayscale');
    }
});

// ═══════════════════════════════════════════════════════════════════════
// pixelYToFrequency / frequencyToPixelY
// ═══════════════════════════════════════════════════════════════════════

test('pixelYToFrequency returns 0 for degenerate display', () => {
    assert.equal(pixelYToFrequency(0, 0, 16000, 32000, 128, 'mel'), 0);
    assert.equal(pixelYToFrequency(0, 1, 16000, 32000, 128, 'mel'), 0);
    assert.equal(pixelYToFrequency(0, 200, 16000, 32000, 0, 'mel'), 0);
});

test('pixelYToFrequency top pixel is high frequency, bottom is low', () => {
    const displayHeight = 200, maxFreq = 16000, sr = 32000, nMels = 128;
    const top = pixelYToFrequency(0, displayHeight, maxFreq, sr, nMels, 'mel');
    const bottom = pixelYToFrequency(displayHeight - 1, displayHeight, maxFreq, sr, nMels, 'mel');
    assert.ok(top > bottom, `top (${top} Hz) should be > bottom (${bottom} Hz)`);
    assert.ok(top > 10000, `top frequency ${top} should be near maxFreq`);
    assert.ok(bottom < 500, `bottom frequency ${bottom} should be near 0 Hz`);
});

test('pixelYToFrequency linear scale produces linear frequency mapping', () => {
    const displayHeight = 200, maxFreq = 16000, sr = 32000, nBins = 512;
    const quarterY = displayHeight * 0.75; // 75% down → ~25% frequency
    const halfY = displayHeight * 0.5;     // 50% down → ~50% frequency
    const freqQuarter = pixelYToFrequency(quarterY, displayHeight, maxFreq, sr, nBins, 'linear');
    const freqHalf = pixelYToFrequency(halfY, displayHeight, maxFreq, sr, nBins, 'linear');
    // In linear mode, frequency should scale roughly linearly with pixel position
    assert.ok(freqHalf > freqQuarter, 'higher pixel should have higher frequency');
    // Mid-point should be roughly half of max
    assert.ok(Math.abs(freqHalf - maxFreq / 2) < 1000,
        `mid-pixel freq ${freqHalf} should be near ${maxFreq / 2}`);
});

test('frequencyToPixelY returns 0 for degenerate display', () => {
    assert.equal(frequencyToPixelY(1000, 0, 16000, 32000, 128, 'mel'), 0);
    assert.equal(frequencyToPixelY(1000, 1, 16000, 32000, 128, 'mel'), 0);
    assert.equal(frequencyToPixelY(1000, 200, 16000, 32000, 0, 'mel'), 0);
});

test('frequencyToPixelY 0 Hz maps near bottom, maxFreq near top', () => {
    const displayHeight = 200, maxFreq = 16000, sr = 32000, nMels = 128;
    const yLow = frequencyToPixelY(0, displayHeight, maxFreq, sr, nMels, 'mel');
    const yHigh = frequencyToPixelY(maxFreq, displayHeight, maxFreq, sr, nMels, 'mel');
    // Y=0 is top (high freq), Y=displayHeight is bottom (low freq)
    assert.ok(yLow > yHigh, `0 Hz pixel (${yLow}) should be below maxFreq pixel (${yHigh})`);
    assert.ok(yHigh < 5, `maxFreq pixel (${yHigh}) should be near top`);
    assert.ok(yLow > displayHeight - 10, `0 Hz pixel (${yLow}) should be near bottom`);
});

test('pixelYToFrequency and frequencyToPixelY are approximate inverses (mel)', () => {
    const displayHeight = 200, maxFreq = 16000, sr = 32000, nMels = 128;
    const testFreqs = [500, 1000, 2000, 4000, 8000, 12000];
    for (const freq of testFreqs) {
        const y = frequencyToPixelY(freq, displayHeight, maxFreq, sr, nMels, 'mel');
        const roundTrip = pixelYToFrequency(y, displayHeight, maxFreq, sr, nMels, 'mel');
        // Allow ~5% tolerance due to bin quantization
        const tolerance = freq * 0.15;
        assert.ok(Math.abs(roundTrip - freq) < tolerance,
            `roundtrip for ${freq} Hz: got ${roundTrip.toFixed(0)} Hz (tolerance ${tolerance.toFixed(0)})`);
    }
});

test('pixelYToFrequency and frequencyToPixelY are approximate inverses (linear)', () => {
    const displayHeight = 200, maxFreq = 16000, sr = 32000, nBins = 512;
    const testFreqs = [1000, 4000, 8000, 12000];
    for (const freq of testFreqs) {
        const y = frequencyToPixelY(freq, displayHeight, maxFreq, sr, nBins, 'linear');
        const roundTrip = pixelYToFrequency(y, displayHeight, maxFreq, sr, nBins, 'linear');
        const tolerance = freq * 0.1;
        assert.ok(Math.abs(roundTrip - freq) < tolerance,
            `roundtrip for ${freq} Hz: got ${roundTrip.toFixed(0)} Hz (tolerance ${tolerance.toFixed(0)})`);
    }
});

test('pixelYToFrequency clamps maxFreq to Nyquist', () => {
    const sr = 16000; // Nyquist = 8000
    const freq = pixelYToFrequency(0, 200, 20000, sr, 128, 'mel');
    // maxFreq=20000 but Nyquist=8000, top pixel should not exceed ~8000
    assert.ok(freq <= sr / 2 + 100,
        `freq ${freq} should not exceed Nyquist (${sr / 2})`);
});

// ═══════════════════════════════════════════════════════════════════════
// End-to-end pipeline: computeSpectrogram → buildSpectrogramGrayscale
// ═══════════════════════════════════════════════════════════════════════

test('end-to-end: sine wave produces energy at expected frequency band (mel)', () => {
    const sr = 32000, freq = 4000, duration = 0.5;
    const audio = new Float32Array(sr * duration);
    for (let i = 0; i < audio.length; i++) {
        audio[i] = Math.sin(2 * Math.PI * freq * i / sr);
    }
    const spec = computeSpectrogram({
        channelData: audio, fftSize: 2048, sampleRate: sr, frameRate: 100,
        nMels: 128, pcenGain: 0.8, pcenBias: 0.01, pcenRoot: 4, pcenSmoothing: 0.025,
        scale: 'mel', usePcen: true,
    });
    const stats = updateSpectrogramStats(spec.data);
    const gray = buildSpectrogramGrayscale({
        spectrogramData: spec.data, spectrogramFrames: spec.nFrames,
        spectrogramMels: spec.nMels, sampleRateHz: sr, maxFreq: sr / 2,
        spectrogramAbsLogMin: stats.logMin, spectrogramAbsLogMax: stats.logMax, scale: 'mel',
    });
    assert.ok(gray !== null);
    // The grayscale should have non-zero pixels (signal is present)
    let nonZero = 0;
    for (let i = 0; i < gray.gray.length; i++) {
        if (gray.gray[i] > 0) nonZero++;
    }
    assert.ok(nonZero > 0, 'sine wave should produce visible energy in grayscale');
    // Energy should be concentrated, not spread across all rows
    // Count bright rows (mean > 50) vs dark rows (mean < 10)
    let brightRows = 0, darkRows = 0;
    for (let y = 0; y < gray.height; y++) {
        let rowSum = 0;
        for (let x = 0; x < gray.width; x++) rowSum += gray.gray[y * gray.width + x];
        const rowMean = rowSum / gray.width;
        if (rowMean > 50) brightRows++;
        else if (rowMean < 10) darkRows++;
    }
    assert.ok(brightRows < gray.height / 2,
        `energy should be concentrated, not spread (${brightRows} bright rows of ${gray.height})`);
    assert.ok(darkRows > gray.height / 4,
        `most rows should be dark for a single tone (${darkRows} dark rows of ${gray.height})`);
});

test('end-to-end: silence produces near-zero grayscale', () => {
    const sr = 16000;
    const audio = new Float32Array(sr * 0.5); // 0.5s silence
    const spec = computeSpectrogram({
        channelData: audio, fftSize: 1024, sampleRate: sr, frameRate: 100,
        nMels: 64, pcenGain: 0.8, pcenBias: 0.01, pcenRoot: 4, pcenSmoothing: 0.025,
        scale: 'mel', usePcen: false,
    });
    const { logMin, logMax } = updateSpectrogramStats(spec.data);
    const gray = buildSpectrogramGrayscale({
        spectrogramData: spec.data, spectrogramFrames: spec.nFrames,
        spectrogramMels: spec.nMels, sampleRateHz: sr, maxFreq: sr / 2,
        spectrogramAbsLogMin: logMin, spectrogramAbsLogMax: logMax, scale: 'mel',
    });
    assert.ok(gray !== null);
    // Silence should produce a mostly uniform grayscale image
    let min = 255, max = 0;
    for (let i = 0; i < gray.gray.length; i++) {
        if (gray.gray[i] < min) min = gray.gray[i];
        if (gray.gray[i] > max) max = gray.gray[i];
    }
    assert.ok(max - min < 30, `silence should be near-uniform (range: ${min}-${max})`);
});

test('end-to-end: linear vs mel produce different grayscale for same audio', () => {
    const sr = 32000;
    const audio = new Float32Array(sr * 0.3);
    for (let i = 0; i < audio.length; i++) {
        audio[i] = Math.sin(2 * Math.PI * 2000 * i / sr) + 0.5 * Math.sin(2 * Math.PI * 8000 * i / sr);
    }
    const specMel = computeSpectrogram({
        channelData: audio, fftSize: 2048, sampleRate: sr, frameRate: 100,
        nMels: 128, pcenGain: 0.8, pcenBias: 0.01, pcenRoot: 4, pcenSmoothing: 0.025,
        scale: 'mel', usePcen: false,
    });
    const specLin = computeSpectrogram({
        channelData: audio, fftSize: 2048, sampleRate: sr, frameRate: 100,
        nMels: 128, pcenGain: 0.8, pcenBias: 0.01, pcenRoot: 4, pcenSmoothing: 0.025,
        scale: 'linear',
    });
    const gMel = buildSpectrogramGrayscale({
        spectrogramData: specMel.data, spectrogramFrames: specMel.nFrames,
        spectrogramMels: specMel.nMels, sampleRateHz: sr, maxFreq: sr / 2,
        spectrogramAbsLogMin: -80, spectrogramAbsLogMax: 0, scale: 'mel',
    });
    const gLin = buildSpectrogramGrayscale({
        spectrogramData: specLin.data, spectrogramFrames: specLin.nFrames,
        spectrogramMels: specLin.nMels, sampleRateHz: sr, maxFreq: sr / 2,
        spectrogramAbsLogMin: -80, spectrogramAbsLogMax: 0, scale: 'linear',
    });
    // Different scales should produce different gray images
    let diffCount = 0;
    const minLen = Math.min(gMel.gray.length, gLin.gray.length);
    for (let i = 0; i < minLen; i++) {
        if (gMel.gray[i] !== gLin.gray[i]) diffCount++;
    }
    assert.ok(diffCount > minLen * 0.1,
        `mel and linear should differ substantially (${diffCount}/${minLen} pixels differ)`);
});

// ═══════════════════════════════════════════════════════════════════════
// buildSpectrogramGrayscale — colourScale modes
// ═══════════════════════════════════════════════════════════════════════

test('buildSpectrogramGrayscale colourScale=phase maps [-π, +π] to [0, 255]', () => {
    const nFrames = 10, nBins = 16;
    // Fill with known phase values: −π to +π
    const data = new Float32Array(nFrames * nBins);
    for (let f = 0; f < nFrames; f++) {
        for (let b = 0; b < nBins; b++) {
            data[f * nBins + b] = -Math.PI + (2 * Math.PI * b / (nBins - 1));
        }
    }
    const result = buildSpectrogramGrayscale({
        spectrogramData: data, spectrogramFrames: nFrames, spectrogramMels: nBins,
        sampleRateHz: 32000, maxFreq: 16000,
        spectrogramAbsLogMin: -Math.PI, spectrogramAbsLogMax: Math.PI,
        scale: 'linear', colourScale: 'phase',
    });
    assert.ok(result !== null);
    for (let i = 0; i < result.gray.length; i++) {
        assert.ok(result.gray[i] >= 0 && result.gray[i] <= 255,
            `phase gray[${i}] = ${result.gray[i]} out of range`);
    }
});

test('buildSpectrogramGrayscale colourScale=linear maps raw magnitudes', () => {
    const nFrames = 10, nBins = 8;
    const data = new Float32Array(nFrames * nBins).fill(0.5);
    const result = buildSpectrogramGrayscale({
        spectrogramData: data, spectrogramFrames: nFrames, spectrogramMels: nBins,
        sampleRateHz: 32000, maxFreq: 16000,
        spectrogramAbsLogMin: 0, spectrogramAbsLogMax: 1,
        scale: 'linear', colourScale: 'linear',
    });
    assert.ok(result !== null);
    // Uniform 0.5 with range [0,1] → ~0.5
    const expected = result.gray[0];
    assert.ok(expected > 0.4 && expected < 0.6,
        `uniform 0.5 should map to ~0.5 (got ${expected})`);
});

test('buildSpectrogramGrayscale colourScale=meter applies IEC curve', () => {
    const nFrames = 10, nBins = 8;
    // Full-scale values (max) should map to 255 for both linear and meter
    const dataMax = new Float32Array(nFrames * nBins).fill(1);
    const linearResult = buildSpectrogramGrayscale({
        spectrogramData: dataMax, spectrogramFrames: nFrames, spectrogramMels: nBins,
        sampleRateHz: 32000, maxFreq: 16000,
        spectrogramAbsLogMin: 0, spectrogramAbsLogMax: 1,
        scale: 'linear', colourScale: 'linear',
    });
    const meterResult = buildSpectrogramGrayscale({
        spectrogramData: dataMax, spectrogramFrames: nFrames, spectrogramMels: nBins,
        sampleRateHz: 32000, maxFreq: 16000,
        spectrogramAbsLogMin: 0, spectrogramAbsLogMax: 1,
        scale: 'linear', colourScale: 'meter',
    });
    // At full scale (0 dB), both should be 1
    assert.ok(Math.abs(linearResult.gray[0] - 1) < 1e-6);
    assert.ok(Math.abs(meterResult.gray[0] - 1) < 1e-6);

    // Now test mid-level: meter should be different from linear
    const dataMid = new Float32Array(nFrames * nBins).fill(0.1); // quiet
    const linMid = buildSpectrogramGrayscale({
        spectrogramData: dataMid, spectrogramFrames: nFrames, spectrogramMels: nBins,
        sampleRateHz: 32000, maxFreq: 16000,
        spectrogramAbsLogMin: 0, spectrogramAbsLogMax: 1,
        scale: 'linear', colourScale: 'linear',
    });
    const meterMid = buildSpectrogramGrayscale({
        spectrogramData: dataMid, spectrogramFrames: nFrames, spectrogramMels: nBins,
        sampleRateHz: 32000, maxFreq: 16000,
        spectrogramAbsLogMin: 0, spectrogramAbsLogMax: 1,
        scale: 'linear', colourScale: 'meter',
    });
    // Meter should compress quiet signals (map them differently from linear)
    assert.notEqual(linMid.gray[0], meterMid.gray[0],
        `meter (${meterMid.gray[0]}) should differ from linear (${linMid.gray[0]}) at quiet levels`);
});

test('buildSpectrogramGrayscale colourScale=db and dbSquared produce same output for dB data', () => {
    const nFrames = 10, nBins = 8;
    const data = new Float32Array(nFrames * nBins);
    for (let i = 0; i < data.length; i++) data[i] = -40 + (80 * i / data.length);

    const dbResult = buildSpectrogramGrayscale({
        spectrogramData: data, spectrogramFrames: nFrames, spectrogramMels: nBins,
        sampleRateHz: 32000, maxFreq: 16000,
        spectrogramAbsLogMin: -40, spectrogramAbsLogMax: 40,
        scale: 'linear', colourScale: 'db',
    });
    const db2Result = buildSpectrogramGrayscale({
        spectrogramData: data, spectrogramFrames: nFrames, spectrogramMels: nBins,
        sampleRateHz: 32000, maxFreq: 16000,
        spectrogramAbsLogMin: -40, spectrogramAbsLogMax: 40,
        scale: 'linear', colourScale: 'dbSquared',
    });
    // Both use the same linear range mapping code path
    for (let i = 0; i < dbResult.gray.length; i++) {
        assert.equal(dbResult.gray[i], db2Result.gray[i],
            `db and dbSquared should produce identical grayscale at pixel ${i}`);
    }
});

test('buildSpectrogramGrayscale all colourScales produce values in [0, 255]', () => {
    const nFrames = 20, nBins = 16;
    const data = new Float32Array(nFrames * nBins);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() - 0.5) * 10;

    for (const cs of ['linear', 'meter', 'dbSquared', 'db', 'phase']) {
        const result = buildSpectrogramGrayscale({
            spectrogramData: data, spectrogramFrames: nFrames, spectrogramMels: nBins,
            sampleRateHz: 32000, maxFreq: 16000,
            spectrogramAbsLogMin: -5, spectrogramAbsLogMax: 5,
            scale: 'linear', colourScale: cs,
        });
        assert.ok(result !== null, `${cs} should return a result`);
        for (let i = 0; i < result.gray.length; i++) {
            assert.ok(result.gray[i] >= 0 && result.gray[i] <= 1,
                `${cs}: gray[${i}] = ${result.gray[i]} out of [0,1] range`);
        }
    }
});

// ═══════════════════════════════════════════════════════════════════════
// Float32 Grayscale output format
// ═══════════════════════════════════════════════════════════════════════

test('buildSpectrogramGrayscale returns Float32Array', () => {
    const nFrames = 10, nMels = 8;
    const data = new Float32Array(nFrames * nMels).fill(0);
    const result = buildSpectrogramGrayscale({
        spectrogramData: data, spectrogramFrames: nFrames, spectrogramMels: nMels,
        sampleRateHz: 32000, maxFreq: 16000,
        spectrogramAbsLogMin: -4, spectrogramAbsLogMax: 4,
    });
    assert.ok(result.gray instanceof Float32Array, 'gray should be Float32Array');
});

// ═══════════════════════════════════════════════════════════════════════
// Spectral Subtraction
// ═══════════════════════════════════════════════════════════════════════

test('spectralSubtract returns same-length Float32Array', () => {
    const nFrames = 20, nMels = 8;
    const data = new Float32Array(nFrames * nMels);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 10;
    const result = spectralSubtract(data, nFrames, nMels);
    assert.ok(result instanceof Float32Array);
    assert.equal(result.length, data.length);
});

test('spectralSubtract produces non-negative values', () => {
    const nFrames = 50, nMels = 16;
    const data = new Float32Array(nFrames * nMels);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 10 - 5;
    const result = spectralSubtract(data, nFrames, nMels);
    for (let i = 0; i < result.length; i++) {
        assert.ok(result[i] >= 0, `value at ${i} should be ≥ 0 (got ${result[i]})`);
    }
});

test('spectralSubtract reduces uniform noise to near-zero', () => {
    const nFrames = 100, nMels = 8;
    // Uniform signal: median = 5, so after subtraction everything becomes 0
    const data = new Float32Array(nFrames * nMels).fill(5);
    const result = spectralSubtract(data, nFrames, nMels);
    for (let i = 0; i < result.length; i++) {
        assert.ok(Math.abs(result[i]) < 1e-6, `uniform noise should subtract to ~0 (got ${result[i]})`);
    }
});

test('spectralSubtract preserves signal above noise floor', () => {
    const nFrames = 100, nMels = 4;
    // Noise floor at 2 everywhere, with a spike at frame 50
    const data = new Float32Array(nFrames * nMels).fill(2);
    data[50 * nMels + 0] = 10; // spike in mel bin 0
    const result = spectralSubtract(data, nFrames, nMels);
    // The spike should be preserved (10 - 2 = 8)
    assert.ok(result[50 * nMels + 0] > 5, `spike should be preserved (got ${result[50 * nMels + 0]})`);
    // Noise frames should be near 0
    assert.ok(result[0 * nMels + 0] < 0.1, `noise should be near 0 (got ${result[0 * nMels + 0]})`);
});

// ═══════════════════════════════════════════════════════════════════════
// CLAHE
// ═══════════════════════════════════════════════════════════════════════

test('applyCLAHE keeps values in [0, 1]', () => {
    const w = 32, h = 16;
    const gray = new Float32Array(w * h);
    for (let i = 0; i < gray.length; i++) gray[i] = Math.random();
    applyCLAHE(gray, w, h, 4, 2, 2.5);
    for (let i = 0; i < gray.length; i++) {
        assert.ok(gray[i] >= 0 && gray[i] <= 1,
            `out-of-range at ${i}: ${gray[i]}`);
    }
});

test('applyCLAHE enhances low-contrast image', () => {
    const w = 64, h = 32;
    // Low-contrast: all values in [0.4, 0.6]
    const gray = new Float32Array(w * h);
    for (let i = 0; i < gray.length; i++) gray[i] = 0.4 + 0.2 * (i / gray.length);
    const before = new Float32Array(gray);
    applyCLAHE(gray, w, h, 4, 2, 3.0);
    // After CLAHE, range should be expanded
    let min = 1, max = 0;
    for (let i = 0; i < gray.length; i++) {
        if (gray[i] < min) min = gray[i];
        if (gray[i] > max) max = gray[i];
    }
    const origRange = 0.2;
    const newRange = max - min;
    assert.ok(newRange > origRange + 0.1,
        `CLAHE should expand range: ${origRange.toFixed(3)} → ${newRange.toFixed(3)}`);
});

test('applyCLAHE is idempotent on uniform images', () => {
    const w = 16, h = 8;
    const gray = new Float32Array(w * h).fill(0.5);
    applyCLAHE(gray, w, h, 4, 2, 2.5);
    for (let i = 0; i < gray.length; i++) {
        // Uniform image: CDF maps 0.5 → 0 or 1 depending on implementation
        // but all pixels should have the same value
        assert.ok(Math.abs(gray[i] - gray[0]) < 1e-6,
            `uniform image should remain uniform after CLAHE`);
    }
});

test('buildSpectrogramGrayscale with noiseReduction option', () => {
    const nFrames = 50, nMels = 16;
    const data = new Float32Array(nFrames * nMels).fill(5);
    data[25 * nMels + 4] = 20; // spike

    const withNR = buildSpectrogramGrayscale({
        spectrogramData: data, spectrogramFrames: nFrames, spectrogramMels: nMels,
        sampleRateHz: 32000, maxFreq: 16000,
        spectrogramAbsLogMin: 0, spectrogramAbsLogMax: 25,
        noiseReduction: true,
    });
    const withoutNR = buildSpectrogramGrayscale({
        spectrogramData: data, spectrogramFrames: nFrames, spectrogramMels: nMels,
        sampleRateHz: 32000, maxFreq: 16000,
        spectrogramAbsLogMin: 0, spectrogramAbsLogMax: 25,
        noiseReduction: false,
    });
    // With noise reduction, the uniform noise floor should be suppressed
    // The result should differ from without
    let totalDiff = 0;
    for (let i = 0; i < withNR.gray.length; i++) {
        totalDiff += Math.abs(withNR.gray[i] - withoutNR.gray[i]);
    }
    assert.ok(totalDiff > 0, 'noise reduction should change the output');
});

test('buildSpectrogramGrayscale with CLAHE option', () => {
    const nFrames = 50, nMels = 32;
    const data = new Float32Array(nFrames * nMels);
    for (let i = 0; i < data.length; i++) data[i] = -3 + 0.5 * (i / data.length);

    const withCLAHE = buildSpectrogramGrayscale({
        spectrogramData: data, spectrogramFrames: nFrames, spectrogramMels: nMels,
        sampleRateHz: 32000, maxFreq: 16000,
        spectrogramAbsLogMin: -4, spectrogramAbsLogMax: 4,
        clahe: true,
    });
    const withoutCLAHE = buildSpectrogramGrayscale({
        spectrogramData: data, spectrogramFrames: nFrames, spectrogramMels: nMels,
        sampleRateHz: 32000, maxFreq: 16000,
        spectrogramAbsLogMin: -4, spectrogramAbsLogMax: 4,
        clahe: false,
    });
    let totalDiff = 0;
    for (let i = 0; i < withCLAHE.gray.length; i++) {
        totalDiff += Math.abs(withCLAHE.gray[i] - withoutCLAHE.gray[i]);
    }
    assert.ok(totalDiff > 0, 'CLAHE should change the output');
});
