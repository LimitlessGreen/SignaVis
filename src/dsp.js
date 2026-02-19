// ═══════════════════════════════════════════════════════════════════════
// dsp.js — Pure DSP functions (single source of truth)
//
// Used by both the Web Worker and the main-thread fallback.
// All functions are stateless and operate only on typed arrays.
// ═══════════════════════════════════════════════════════════════════════

// ─── Mel Scale ──────────────────────────────────────────────────────

export function hzToMel(hz) {
    return 2595 * Math.log10(1 + hz / 700);
}

export function melToHz(mel) {
    return 700 * (Math.pow(10, mel / 2595) - 1);
}

/**
 * Return an array of `nMels` frequencies (Hz) evenly spaced in mel scale
 * from 0 Hz to sampleRate/2.
 */
export function buildMelFrequencies(sampleRate, nMels) {
    const melMin = hzToMel(0);
    const melMax = hzToMel(sampleRate / 2);
    const freqs = new Float32Array(nMels);
    for (let i = 0; i < nMels; i++) {
        const mel = melMin + (i / Math.max(1, nMels - 1)) * (melMax - melMin);
        freqs[i] = melToHz(mel);
    }
    return freqs;
}

// ─── Mel Filterbank ─────────────────────────────────────────────────

export function createMelFilterbank(sampleRate, fftSize, nMels, fMin, fMax) {
    const nFftBins = Math.floor(fftSize / 2);
    const melMin = hzToMel(fMin);
    const melMax = hzToMel(fMax);
    const melPoints = [];

    for (let i = 0; i < nMels + 2; i++) {
        melPoints.push(melMin + (i / (nMels + 1)) * (melMax - melMin));
    }

    const hzPoints = melPoints.map(melToHz);
    const binPoints = hzPoints.map((hz) => Math.floor((fftSize + 1) * hz / sampleRate));

    const filterbank = [];
    for (let m = 1; m <= nMels; m++) {
        const filter = new Float32Array(nFftBins);
        const left   = Math.max(0, Math.min(nFftBins - 1, binPoints[m - 1]));
        const center = Math.max(0, Math.min(nFftBins - 1, binPoints[m]));
        const right  = Math.max(0, Math.min(nFftBins - 1, binPoints[m + 1]));

        for (let k = left; k < center; k++) {
            filter[k] = (k - left) / (center - left || 1);
        }
        for (let k = center; k < right; k++) {
            filter[k] = (right - k) / (right - center || 1);
        }

        filterbank.push(filter);
    }

    return filterbank;
}

export function applyMelFilterbank(powerSpectrum, melFilterbank) {
    const melSpectrum = new Float32Array(melFilterbank.length);
    for (let m = 0; m < melFilterbank.length; m++) {
        const filter = melFilterbank[m];
        let sum = 0;
        for (let k = 0; k < filter.length; k++) {
            if (filter[k] !== 0) {
                sum += powerSpectrum[k] * filter[k];
            }
        }
        melSpectrum[m] = sum;
    }
    return melSpectrum;
}

// ─── FFT (iterative Cooley-Tukey, in-place) ─────────────────────────

export function iterativeFFT(real, imag) {
    const n = real.length;

    // Bit-reversal permutation
    let j = 0;
    for (let i = 1; i < n; i++) {
        let bit = n >> 1;
        while (j & bit) {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;

        if (i < j) {
            let tmp = real[i]; real[i] = real[j]; real[j] = tmp;
            tmp = imag[i]; imag[i] = imag[j]; imag[j] = tmp;
        }
    }

    // Butterfly stages
    for (let len = 2; len <= n; len <<= 1) {
        const halfLen = len >> 1;
        const angleStep = -2 * Math.PI / len;

        for (let i = 0; i < n; i += len) {
            for (let k = 0; k < halfLen; k++) {
                const angle = angleStep * k;
                const cos = Math.cos(angle);
                const sin = Math.sin(angle);

                const evenIndex = i + k;
                const oddIndex  = evenIndex + halfLen;

                const tr = cos * real[oddIndex] - sin * imag[oddIndex];
                const ti = sin * real[oddIndex] + cos * imag[oddIndex];

                real[oddIndex] = real[evenIndex] - tr;
                imag[oddIndex] = imag[evenIndex] - ti;
                real[evenIndex] += tr;
                imag[evenIndex] += ti;
            }
        }
    }
}

// ─── Power Spectrum ─────────────────────────────────────────────────

/**
 * Compute the magnitude spectrum of a windowed (Hann) frame via FFT.
 * Returns a Float32Array of length fftSize/2.
 */
export function fftMagnitudeSpectrum(audio, offset, winLength, fftSize) {
    const real = new Float32Array(fftSize);
    const imag = new Float32Array(fftSize);

    const maxCopy = Math.min(winLength, fftSize);
    for (let i = 0; i < maxCopy; i++) {
        const sample = audio[offset + i] || 0;
        const window = 0.5 * (1 - Math.cos(2 * Math.PI * i / Math.max(1, winLength - 1)));
        real[i] = sample * window;
    }

    iterativeFFT(real, imag);

    const out = new Float32Array(fftSize / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
    }
    return out;
}

// ─── Spectrogram Computation ────────────────────────────────────────

/**
 * Compute a full spectrogram from raw audio samples.
 *
 * @param {Object} params
 * @param {ArrayBuffer|Float32Array} params.channelData — mono audio samples
 * @param {number} params.fftSize
 * @param {number} params.sampleRate
 * @param {number} params.frameRate      — frames per second
 * @param {number} params.nMels          — mel bins (Perch mode)
 * @param {number} params.pcenGain
 * @param {number} params.pcenBias
 * @param {number} params.pcenRoot
 * @param {number} params.pcenSmoothing
 * @param {string} [params.spectrogramMode='perch'] — 'perch' or 'classic'
 *
 * @returns {{ data: Float32Array, nFrames: number, nMels: number }}
 */
export function computeSpectrogram(params) {
    const {
        channelData, fftSize, sampleRate, frameRate,
        nMels, pcenGain, pcenBias, pcenRoot, pcenSmoothing,
        spectrogramMode,
    } = params;

    const audio = channelData instanceof Float32Array
        ? channelData
        : new Float32Array(channelData);

    const hopSize    = Math.max(1, Math.floor(sampleRate / frameRate));
    const winLength  = 4 * hopSize;
    const numFrames  = Math.max(1, Math.floor((audio.length - winLength) / hopSize) + 1);

    const nBins      = Math.floor(fftSize / 2);
    const useLinear  = spectrogramMode === 'classic';
    const melFB      = useLinear ? null : createMelFilterbank(sampleRate, fftSize, nMels, 0, sampleRate / 2);
    const outBins    = useLinear ? nBins : nMels;
    const output     = new Float32Array(numFrames * outBins);

    if (useLinear) {
        // ── Classic / Xeno-Canto style: linear power spectrum → dB ──
        for (let frameIdx = 0; frameIdx < numFrames; frameIdx++) {
            const offset = frameIdx * hopSize;
            const mag    = fftMagnitudeSpectrum(audio, offset, winLength, fftSize);
            const base   = frameIdx * nBins;
            for (let k = 0; k < nBins; k++) {
                const power = mag[k] * mag[k];
                output[base + k] = 10 * Math.log10(Math.max(1e-10, power));
            }
        }
    } else {
        // ── Perch mode: magnitude → mel → PCEN ──
        const smooth    = new Float32Array(nMels);
        const pcenPower = 1.0 / pcenRoot;
        for (let frameIdx = 0; frameIdx < numFrames; frameIdx++) {
            const offset = frameIdx * hopSize;
            const mag    = fftMagnitudeSpectrum(audio, offset, winLength, fftSize);
            const mel    = applyMelFilterbank(mag, melFB);
            const base   = frameIdx * nMels;
            for (let m = 0; m < nMels; m++) {
                const e     = mel[m];
                smooth[m]   = (1 - pcenSmoothing) * smooth[m] + pcenSmoothing * e;
                const denom = Math.pow(1e-12 + smooth[m], pcenGain);
                const norm  = e / denom;
                output[base + m] = Math.pow(norm + pcenBias, pcenPower) - Math.pow(pcenBias, pcenPower);
            }
        }
    }

    return { data: output, nFrames: numFrames, nMels: outBins };
}
