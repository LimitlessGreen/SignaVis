// ═══════════════════════════════════════════════════════════════════════
// dsp.js - Pure DSP functions (single source of truth)
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

        // If the triangular filter is degenerate (e.g. center == right, or
        // left == center == right), it can end up all-zero.  Fall back to a
        // point filter on the center bin so the band isn't silent (white stripe).
        let filterSum = 0;
        for (let k = 0; k < nFftBins; k++) filterSum += filter[k];
        if (filterSum === 0) {
            filter[center] = 1;
            filterSum = 1;
        }

        // Power-normalise so each triangle sums to 1 (matches SV behaviour)
        for (let k = 0; k < nFftBins; k++) filter[k] /= filterSum;

        filterbank.push(filter);
    }

    return filterbank;
}

/**
 * Build a sparse mel filterbank for fast application.
 * Instead of iterating all nFftBins per filter, stores only
 * the non-zero (startBin, weights[]) ranges.
 */
export function createSparseMelFilterbank(sampleRate, fftSize, nMels, fMin, fMax) {
    const dense = createMelFilterbank(sampleRate, fftSize, nMels, fMin, fMax);
    const sparse = new Array(nMels);
    for (let m = 0; m < nMels; m++) {
        const f = dense[m];
        let start = -1, end = 0;
        for (let k = 0; k < f.length; k++) {
            if (f[k] !== 0) {
                if (start < 0) start = k;
                end = k + 1;
            }
        }
        if (start < 0) start = 0;
        const weights = f.subarray(start, end);
        sparse[m] = { start, weights };
    }
    return sparse;
}

/**
 * Apply sparse mel filterbank — only iterates non-zero ranges.
 */
export function applySparseMelFilterbank(powerSpectrum, sparseFilterbank) {
    const nMels = sparseFilterbank.length;
    const melSpectrum = new Float32Array(nMels);
    for (let m = 0; m < nMels; m++) {
        const { start, weights } = sparseFilterbank[m];
        let sum = 0;
        for (let k = 0; k < weights.length; k++) {
            sum += powerSpectrum[start + k] * weights[k];
        }
        melSpectrum[m] = sum;
    }
    return melSpectrum;
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

// Precomputed twiddle factor tables, keyed by FFT size.
const _twiddleCache = new Map();

function getTwiddleFactors(n) {
    if (_twiddleCache.has(n)) return _twiddleCache.get(n);
    const table = {};
    for (let len = 2; len <= n; len <<= 1) {
        const halfLen = len >> 1;
        const angleStep = -2 * Math.PI / len;
        const cos = new Float64Array(halfLen);
        const sin = new Float64Array(halfLen);
        for (let k = 0; k < halfLen; k++) {
            const angle = angleStep * k;
            cos[k] = Math.cos(angle);
            sin[k] = Math.sin(angle);
        }
        table[len] = { cos, sin };
    }
    _twiddleCache.set(n, table);
    return table;
}

export function iterativeFFT(real, imag) {
    const n = real.length;
    const twiddle = getTwiddleFactors(n);

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

    // Butterfly stages with precomputed twiddle factors
    for (let len = 2; len <= n; len <<= 1) {
        const halfLen = len >> 1;
        const { cos, sin } = twiddle[len];

        for (let i = 0; i < n; i += len) {
            for (let k = 0; k < halfLen; k++) {
                const evenIndex = i + k;
                const oddIndex  = evenIndex + halfLen;

                const tr = cos[k] * real[oddIndex] - sin[k] * imag[oddIndex];
                const ti = sin[k] * real[oddIndex] + cos[k] * imag[oddIndex];

                real[oddIndex] = real[evenIndex] - tr;
                imag[oddIndex] = imag[evenIndex] - ti;
                real[evenIndex] += tr;
                imag[evenIndex] += ti;
            }
        }
    }
}

// ─── Window Functions ───────────────────────────────────────────────

/** @param {number} i @param {number} N */
function hannWindow(i, N) {
    return 0.5 * (1 - Math.cos(2 * Math.PI * i / Math.max(1, N - 1)));
}
/** @param {number} i @param {number} N */
function hammingWindow(i, N) {
    return 0.54 - 0.46 * Math.cos(2 * Math.PI * i / Math.max(1, N - 1));
}
/** @param {number} i @param {number} N */
function blackmanWindow(i, N) {
    const a0 = 0.42, a1 = 0.5, a2 = 0.08;
    return a0 - a1 * Math.cos(2 * Math.PI * i / Math.max(1, N - 1))
              + a2 * Math.cos(4 * Math.PI * i / Math.max(1, N - 1));
}
/** Blackman-Harris 4-term — excellent sidelobe suppression (−92 dB). */
function blackmanHarrisWindow(i, N) {
    const a0 = 0.35875, a1 = 0.48829, a2 = 0.14128, a3 = 0.01168;
    const t = 2 * Math.PI * i / Math.max(1, N - 1);
    return a0 - a1 * Math.cos(t) + a2 * Math.cos(2 * t) - a3 * Math.cos(3 * t);
}
/** Flat-top — near-unity amplitude accuracy at the cost of wider main lobe. */
function flatTopWindow(i, N) {
    const a0 = 0.21557895, a1 = 0.41663158, a2 = 0.277263158;
    const a3 = 0.083578947, a4 = 0.006947368;
    const t = 2 * Math.PI * i / Math.max(1, N - 1);
    return a0 - a1 * Math.cos(t) + a2 * Math.cos(2 * t)
              - a3 * Math.cos(3 * t) + a4 * Math.cos(4 * t);
}
/**
 * Kaiser window — adjustable via β parameter.
 * Higher β → narrower main lobe, lower sidelobes.
 * β≈5: similar to Hamming, β≈8.6: similar to Blackman-Harris.
 * Uses rational Bessel I₀ approximation (no factorial overflow).
 */
function kaiserWindow(i, N, beta = 6) {
    const M = Math.max(1, N - 1);
    const alpha = M / 2;
    const arg = beta * Math.sqrt(1 - ((i - alpha) / alpha) ** 2);
    return _besselI0(arg) / _besselI0(beta);
}
/** Modified Bessel function I₀(x) — polynomial approximation (Abramowitz & Stegun). */
function _besselI0(x) {
    const ax = Math.abs(x);
    if (ax < 3.75) {
        const t = (ax / 3.75) ** 2;
        return 1 + t * (3.5156229 + t * (3.0899424 + t * (1.2067492
            + t * (0.2659732 + t * (0.0360768 + t * 0.0045813)))));
    }
    const t = 3.75 / ax;
    return (Math.exp(ax) / Math.sqrt(ax)) * (0.39894228 + t * (0.01328592
        + t * (0.00225319 + t * (-0.00157565 + t * (0.00916281 + t * (-0.02057706
        + t * (0.02635537 + t * (-0.01647633 + t * 0.00392377))))))));
}

/** @type {Record<string, (i: number, N: number) => number>} */
const WINDOW_FUNCTIONS = {
    hann: hannWindow,
    hamming: hammingWindow,
    blackman: blackmanWindow,
    blackmanHarris: blackmanHarrisWindow,
    flatTop: flatTopWindow,
    kaiser: kaiserWindow,
};

/** Available window function keys (for UI enumeration). */
export const WINDOW_FUNCTION_KEYS = Object.keys(WINDOW_FUNCTIONS);

// ─── Power Spectrum ─────────────────────────────────────────────────

/**
 * Compute the magnitude spectrum of a windowed frame via FFT.
 * Returns a Float32Array of length fftSize/2.
 * @param {Float32Array} audio
 * @param {number} offset
 * @param {number} winLength
 * @param {number} fftSize
 * @param {string} [windowFunction='hann'] - 'hann' | 'hamming' | 'blackman'
 */
export function fftMagnitudeSpectrum(audio, offset, winLength, fftSize, windowFunction = 'hann') {
    const real = new Float32Array(fftSize);
    const imag = new Float32Array(fftSize);

    const wfn = WINDOW_FUNCTIONS[windowFunction] || hannWindow;
    const maxCopy = Math.min(winLength, fftSize);
    for (let i = 0; i < maxCopy; i++) {
        const sample = audio[offset + i] || 0;
        real[i] = sample * wfn(i, winLength);
    }

    iterativeFFT(real, imag);

    const out = new Float32Array(fftSize / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
    }
    return out;
}

/**
 * Compute magnitude + phase spectrum from a windowed frame via FFT.
 * Returns { magnitude: Float32Array, phase: Float32Array } each of length fftSize/2.
 */
export function fftMagnitudePhaseSpectrum(audio, offset, winLength, fftSize, windowFunction = 'hann') {
    const real = new Float32Array(fftSize);
    const imag = new Float32Array(fftSize);

    const wfn = WINDOW_FUNCTIONS[windowFunction] || hannWindow;
    const maxCopy = Math.min(winLength, fftSize);
    for (let i = 0; i < maxCopy; i++) {
        const sample = audio[offset + i] || 0;
        real[i] = sample * wfn(i, winLength);
    }

    iterativeFFT(real, imag);

    const nBins = fftSize / 2;
    const magnitude = new Float32Array(nBins);
    const phase = new Float32Array(nBins);
    for (let i = 0; i < nBins; i++) {
        magnitude[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
        phase[i] = Math.atan2(imag[i], real[i]);
    }
    return { magnitude, phase };
}

// ─── IEC 60268-18 Meter Scale ───────────────────────────────────────
// Attempt faithful port of SV's AudioLevel / ColourScale meter mapping.

/**
 * IEC 60268-18 fader law: map dB → meter deflection percentage.
 * Used by the "Meter" colour scale to produce perceptually-even brightness.
 */
export function iecDbToFader(db) {
    if (db < -70) return 0;
    if (db < -60) return (db + 70) * 0.25;
    if (db < -50) return (db + 60) * 0.5 + 2.5;
    if (db < -40) return (db + 50) * 0.75 + 7.5;
    if (db < -30) return (db + 40) * 1.5 + 15;
    if (db < -20) return (db + 30) * 2.0 + 30;
    return (db + 20) * 2.5 + 50;
}

/**
 * Maximum meter deflection for 0dB (used to normalise the meter range).
 * @constant {number}
 */
const IEC_MAX_PERCENT = iecDbToFader(0);  // 100

// ─── Spectrogram Computation ────────────────────────────────────────

/**
 * Compute a full spectrogram from raw audio samples.
 *
 * @param {Object} params
 * @param {ArrayBuffer|Float32Array} params.channelData - mono audio samples
 * @param {number} params.fftSize
 * @param {number} params.sampleRate
 * @param {number} params.frameRate      - frames per second
 * @param {number} params.nMels          - number of mel bins (mel scale)
 * @param {number} params.pcenGain
 * @param {number} params.pcenBias
 * @param {number} params.pcenRoot
 * @param {number} params.pcenSmoothing
 * @param {boolean} [params.usePcen=true] - apply PCEN normalisation (false → dB even in mel mode)
 * @param {string} [params.scale='mel'] - 'mel' or 'linear'
 * @param {string} [params.colourScale='dbSquared'] - 'linear'|'meter'|'dbSquared'|'db'|'phase'
 * @param {Float32Array} [params.initialSmooth] - carry-over PCEN smooth state from previous chunk
 * @param {number} [params.windowSize] - window length in samples (0 or omit = auto: 4×hopSize)
 * @param {number} [params.hopSize] - hop size in samples (0 or omit = auto: sampleRate/frameRate)
 * @param {string} [params.windowFunction='hann'] - 'hann' | 'hamming' | 'blackman'
 *
 * @returns {{ data: Float32Array, nFrames: number, nMels: number, hopSize: number, winLength: number, smoothState?: Float32Array }}
 */
export function computeSpectrogram(params) {
    const {
        channelData, fftSize, sampleRate, frameRate,
        nMels, pcenGain, pcenBias, pcenRoot, pcenSmoothing,
        usePcen = true,
        scale = 'mel', initialSmooth,
        colourScale = 'dbSquared',
        windowSize: userWindowSize, hopSize: userHopSize,
        windowFunction = 'hann',
    } = params;

    const audio = channelData instanceof Float32Array
        ? channelData
        : new Float32Array(channelData);

    const autoHop    = Math.max(1, Math.floor(sampleRate / frameRate));
    const hopSize    = (userHopSize && userHopSize > 0) ? userHopSize : autoHop;
    const winLength  = (userWindowSize && userWindowSize > 0) ? userWindowSize : 4 * hopSize;
    const numFrames  = Math.max(1, Math.floor((audio.length - winLength) / hopSize) + 1);

    const nBins      = Math.floor(fftSize / 2);
    const useLinear  = scale === 'linear';
    const useCQT     = scale === 'cqt';
    const isPhase    = colourScale === 'phase';
    const outBins    = useLinear ? nBins : nMels;
    const output     = new Float32Array(numFrames * outBins);

    // ── Precompute window function (once, not per frame) ──
    const wfn = WINDOW_FUNCTIONS[windowFunction] || hannWindow;
    const maxCopy = Math.min(winLength, fftSize);
    const windowLUT = new Float32Array(maxCopy);
    for (let i = 0; i < maxCopy; i++) windowLUT[i] = wfn(i, winLength);

    // ── Reusable FFT buffers (avoid per-frame allocation) ──
    const real = new Float32Array(fftSize);
    const imag = new Float32Array(fftSize);

    // ── Sparse filterbank: CQT or Mel (skip zero-weight bins) ──
    const sparseFB = useLinear ? null
        : useCQT ? createCQTFilterbank(sampleRate, fftSize, nMels)
        : createSparseMelFilterbank(sampleRate, fftSize, nMels, 0, sampleRate / 2);
    // Keep dense filterbank only for phase (needs sin/cos weighting)
    const denseFB  = isPhase && !useLinear ? createMelFilterbank(sampleRate, fftSize, nMels, 0, sampleRate / 2) : null;

    // ── Reusable power buffer for mel paths ──
    const powerBuf = (!useLinear && !isPhase) ? new Float32Array(nBins) : null;

    /** Apply windowed frame into reusable buffers and run FFT in-place. */
    function runFFT(offset) {
        real.fill(0);
        imag.fill(0);
        for (let i = 0; i < maxCopy; i++) {
            real[i] = (audio[offset + i] || 0) * windowLUT[i];
        }
        iterativeFFT(real, imag);
    }

    let smooth = null;

    if (isPhase) {
        for (let frameIdx = 0; frameIdx < numFrames; frameIdx++) {
            runFFT(frameIdx * hopSize);
            const base = frameIdx * outBins;
            if (useLinear) {
                for (let k = 0; k < nBins; k++) output[base + k] = Math.atan2(imag[k], real[k]);
            } else {
                for (let m = 0; m < nMels; m++) {
                    const f = denseFB[m];
                    let sumSin = 0, sumCos = 0;
                    for (let k = 0; k < f.length; k++) {
                        if (f[k] > 0) {
                            const ph = Math.atan2(imag[k], real[k]);
                            sumSin += f[k] * Math.sin(ph);
                            sumCos += f[k] * Math.cos(ph);
                        }
                    }
                    output[base + m] = Math.atan2(sumSin, sumCos);
                }
            }
        }
    } else if (useLinear) {
        const wantRaw = colourScale === 'linear' || colourScale === 'meter';
        for (let frameIdx = 0; frameIdx < numFrames; frameIdx++) {
            runFFT(frameIdx * hopSize);
            const base = frameIdx * nBins;
            if (wantRaw) {
                for (let k = 0; k < nBins; k++) {
                    output[base + k] = Math.sqrt(real[k] * real[k] + imag[k] * imag[k]);
                }
            } else {
                for (let k = 0; k < nBins; k++) {
                    // 20·log₁₀(mag) = 10·log₁₀(mag²) — compute from power directly
                    const p = real[k] * real[k] + imag[k] * imag[k];
                    output[base + k] = 10 * Math.log10(Math.max(1e-20, p));
                }
            }
        }
    } else if (!usePcen) {
        const wantRaw = colourScale === 'linear' || colourScale === 'meter';
        for (let frameIdx = 0; frameIdx < numFrames; frameIdx++) {
            runFFT(frameIdx * hopSize);
            // Compute power spectrum directly (skip sqrt + re-squaring)
            for (let k = 0; k < nBins; k++) {
                powerBuf[k] = real[k] * real[k] + imag[k] * imag[k];
            }
            const base = frameIdx * nMels;
            // Apply sparse mel filterbank on power
            for (let m = 0; m < nMels; m++) {
                const { start, weights } = sparseFB[m];
                let sum = 0;
                for (let k = 0; k < weights.length; k++) {
                    sum += powerBuf[start + k] * weights[k];
                }
                if (wantRaw) {
                    output[base + m] = Math.sqrt(Math.max(0, sum));
                } else {
                    output[base + m] = 10 * Math.log10(Math.max(1e-10, sum));
                }
            }
        }
    } else {
        // ── Mel + PCEN ──
        smooth = new Float32Array(nMels);
        if (initialSmooth && initialSmooth.length === nMels) {
            smooth.set(initialSmooth);
        }
        const pcenPower = 1.0 / pcenRoot;
        const pcenBiasOffset = Math.pow(pcenBias, pcenPower);
        for (let frameIdx = 0; frameIdx < numFrames; frameIdx++) {
            runFFT(frameIdx * hopSize);
            for (let k = 0; k < nBins; k++) {
                powerBuf[k] = real[k] * real[k] + imag[k] * imag[k];
            }
            const base = frameIdx * nMels;
            for (let m = 0; m < nMels; m++) {
                const { start, weights } = sparseFB[m];
                let e = 0;
                for (let k = 0; k < weights.length; k++) {
                    e += powerBuf[start + k] * weights[k];
                }
                smooth[m]   = (1 - pcenSmoothing) * smooth[m] + pcenSmoothing * e;
                const denom = Math.pow(1e-10 + smooth[m], pcenGain);
                const norm  = e / denom;
                output[base + m] = Math.pow(norm + pcenBias, pcenPower) - pcenBiasOffset;
            }
        }
    }

    const result = { data: output, nFrames: numFrames, nMels: outBins, hopSize, winLength, colourScale };
    if (smooth) {
        result.smoothState = smooth;
    }
    return result;
}

// ─── Constant-Q Filterbank ──────────────────────────────────────────

/**
 * Build a CQT (Constant-Q) filterbank that maps STFT bins to
 * log-spaced frequency bins with constant Q factor.
 * Returns a sparse filterbank compatible with applySparseMelFilterbank.
 *
 * @param {number} sampleRate
 * @param {number} fftSize
 * @param {number} nBinsOut        - desired number of output bins
 * @param {number} [fMin=32.7]     - lowest frequency (Hz), default C1
 * @param {number} [binsPerOctave=24]
 */
export function createCQTFilterbank(sampleRate, fftSize, nBinsOut, fMin = 32.7, binsPerOctave = 24) {
    const nFftBins = Math.floor(fftSize / 2);
    const nyquist = sampleRate / 2;
    const Q = 1 / (Math.pow(2, 1 / binsPerOctave) - 1);
    const sparse = new Array(nBinsOut);

    for (let k = 0; k < nBinsOut; k++) {
        const fCenter = fMin * Math.pow(2, k / binsPerOctave);
        if (fCenter >= nyquist) {
            // Above Nyquist — point filter on last bin
            sparse[k] = { start: nFftBins - 1, weights: new Float32Array([1]) };
            continue;
        }
        const bw = fCenter / Q;               // bandwidth
        const fLo = Math.max(0, fCenter - bw / 2);
        const fHi = Math.min(nyquist, fCenter + bw / 2);
        const binLo = Math.max(0, Math.floor(fLo * fftSize / sampleRate));
        const binHi = Math.min(nFftBins - 1, Math.ceil(fHi * fftSize / sampleRate));

        const len = binHi - binLo + 1;
        const weights = new Float32Array(len);
        let sum = 0;
        for (let b = 0; b < len; b++) {
            const fBin = (binLo + b) * sampleRate / fftSize;
            // Triangular weighting around center frequency
            const dist = Math.abs(fBin - fCenter) / (bw / 2 + 1e-12);
            weights[b] = Math.max(0, 1 - dist);
            sum += weights[b];
        }
        // Normalise
        if (sum > 0) for (let b = 0; b < len; b++) weights[b] /= sum;
        else if (len > 0) weights[0] = 1;

        sparse[k] = { start: binLo, weights };
    }
    return sparse;
}

/**
 * Build CQT frequency array (Hz) for each output bin.
 * @param {number} nBins
 * @param {number} [fMin=32.7]
 * @param {number} [binsPerOctave=24]
 * @returns {Float32Array}
 */
export function buildCQTFrequencies(nBins, fMin = 32.7, binsPerOctave = 24) {
    const freqs = new Float32Array(nBins);
    for (let k = 0; k < nBins; k++) {
        freqs[k] = fMin * Math.pow(2, k / binsPerOctave);
    }
    return freqs;
}

// ─── Reassigned Spectrogram ─────────────────────────────────────────

/**
 * Compute a reassigned spectrogram for sharper time-frequency localization.
 * Uses three parallel STFTs with:
 *   1. h(n) — standard window
 *   2. (n - N/2) · h(n) — time-ramped window (for time correction)
 *   3. h'(n) — derivative window (for frequency correction)
 *
 * The corrected coordinates allow energy to be placed at its "true"
 * center of gravity in time-frequency space.
 *
 * @param {Object} params  - Same as computeSpectrogram plus:
 * @param {ArrayBuffer|Float32Array} params.channelData
 * @param {number} params.fftSize
 * @param {number} params.sampleRate
 * @param {number} params.frameRate
 * @param {number} params.nMels
 * @param {string} [params.scale='mel']
 * @param {string} [params.colourScale='dbSquared']
 * @param {number} [params.windowSize]
 * @param {number} [params.hopSize]
 * @param {string} [params.windowFunction='hann']
 * @returns {{ data: Float32Array, nFrames: number, nMels: number, hopSize: number, winLength: number, colourScale: string }}
 */
export function computeReassignedSpectrogram(params) {
    const {
        channelData, fftSize, sampleRate, frameRate,
        nMels, scale = 'mel',
        colourScale = 'dbSquared',
        windowSize: userWindowSize, hopSize: userHopSize,
        windowFunction = 'hann',
    } = params;

    const audio = channelData instanceof Float32Array
        ? channelData
        : new Float32Array(channelData);

    const autoHop   = Math.max(1, Math.floor(sampleRate / frameRate));
    const hopSize   = (userHopSize && userHopSize > 0) ? userHopSize : autoHop;
    const winLength = (userWindowSize && userWindowSize > 0) ? userWindowSize : 4 * hopSize;
    const numFrames = Math.max(1, Math.floor((audio.length - winLength) / hopSize) + 1);
    const nBins     = Math.floor(fftSize / 2);
    const useLinear = scale === 'linear';
    const useCQT    = scale === 'cqt';
    const outBins   = useLinear ? nBins : nMels;
    const output    = new Float32Array(numFrames * outBins);

    // ── Build three windows ──
    const wfn    = WINDOW_FUNCTIONS[windowFunction] || hannWindow;
    const maxCopy = Math.min(winLength, fftSize);
    const winH   = new Float32Array(maxCopy);  // standard
    const winTH  = new Float32Array(maxCopy);  // time-ramped: (n - N/2) · h(n)
    const winDH  = new Float32Array(maxCopy);  // derivative: h'(n) via finite differences
    for (let i = 0; i < maxCopy; i++) winH[i] = wfn(i, winLength);
    for (let i = 0; i < maxCopy; i++) winTH[i] = (i - winLength / 2) * winH[i];
    // Derivative via central finite differences
    for (let i = 1; i < maxCopy - 1; i++) winDH[i] = 0.5 * (winH[i + 1] - winH[i - 1]);
    winDH[0] = winH[1] - winH[0];
    if (maxCopy > 1) winDH[maxCopy - 1] = winH[maxCopy - 1] - winH[maxCopy - 2];

    // ── Reusable FFT buffers (3 pairs) ──
    const realH = new Float32Array(fftSize), imagH = new Float32Array(fftSize);
    const realTH = new Float32Array(fftSize), imagTH = new Float32Array(fftSize);
    const realDH = new Float32Array(fftSize), imagDH = new Float32Array(fftSize);

    // ── Sparse filterbank for mel/CQT ──
    const sparseFB = useLinear ? null
        : useCQT ? createCQTFilterbank(sampleRate, fftSize, nMels)
        : createSparseMelFilterbank(sampleRate, fftSize, nMels, 0, sampleRate / 2);

    // ── Accumulation grid: energy placed at reassigned coordinates ──
    // We accumulate into (numFrames × outBins) and let overlapping
    // contributions average naturally.
    const counts = new Float32Array(numFrames * outBins);

    for (let frameIdx = 0; frameIdx < numFrames; frameIdx++) {
        const offset = frameIdx * hopSize;

        // Fill and run 3 FFTs
        realH.fill(0); imagH.fill(0);
        realTH.fill(0); imagTH.fill(0);
        realDH.fill(0); imagDH.fill(0);
        for (let i = 0; i < maxCopy; i++) {
            const s = audio[offset + i] || 0;
            realH[i]  = s * winH[i];
            realTH[i] = s * winTH[i];
            realDH[i] = s * winDH[i];
        }
        iterativeFFT(realH, imagH);
        iterativeFFT(realTH, imagTH);
        iterativeFFT(realDH, imagDH);

        if (useLinear) {
            // Reassign each STFT bin
            for (let k = 0; k < nBins; k++) {
                const magSq = realH[k] * realH[k] + imagH[k] * imagH[k];
                if (magSq < 1e-30) continue;

                // Time correction: Δt = Re(X_th / X_h) in samples
                const dtSamples = (realTH[k] * realH[k] + imagTH[k] * imagH[k]) / magSq;
                // Frequency correction: Δω = -Im(X_dh / X_h)
                const dOmega = -(imagDH[k] * realH[k] - realDH[k] * imagH[k]) / magSq;
                const correctedBin = k + dOmega * fftSize / (2 * Math.PI);
                const correctedFrame = frameIdx + dtSamples / hopSize;

                const cBin   = Math.max(0, Math.min(nBins - 1, Math.round(correctedBin)));
                const cFrame = Math.max(0, Math.min(numFrames - 1, Math.round(correctedFrame)));
                const idx = cFrame * nBins + cBin;

                const value = colourScale === 'linear' || colourScale === 'meter'
                    ? Math.sqrt(magSq)
                    : 10 * Math.log10(Math.max(1e-20, magSq));

                output[idx] += value;
                counts[idx] += 1;
            }
        } else {
            // Mel-reassigned: compute per-bin, determine which mel filter it lands in
            for (let k = 0; k < nBins; k++) {
                const magSq = realH[k] * realH[k] + imagH[k] * imagH[k];
                if (magSq < 1e-30) continue;

                const dtSamples = (realTH[k] * realH[k] + imagTH[k] * imagH[k]) / magSq;
                const dOmega = -(imagDH[k] * realH[k] - realDH[k] * imagH[k]) / magSq;
                const correctedBin = k + dOmega * fftSize / (2 * Math.PI);
                const correctedFrame = frameIdx + dtSamples / hopSize;

                const cFrame = Math.max(0, Math.min(numFrames - 1, Math.round(correctedFrame)));
                const cBinInt = Math.max(0, Math.min(nBins - 1, Math.round(correctedBin)));

                // Find which mel bin this corrected FFT bin lands in (weighted)
                for (let m = 0; m < nMels; m++) {
                    const { start, weights } = sparseFB[m];
                    if (cBinInt < start || cBinInt >= start + weights.length) continue;
                    const w = weights[cBinInt - start];
                    if (w <= 0) continue;

                    const value = colourScale === 'linear' || colourScale === 'meter'
                        ? Math.sqrt(magSq) * w
                        : 10 * Math.log10(Math.max(1e-20, magSq)) * w;

                    const idx = cFrame * nMels + m;
                    output[idx] += value;
                    counts[idx] += w;
                }
            }
        }
    }

    // Average accumulated values
    for (let i = 0; i < output.length; i++) {
        if (counts[i] > 0) output[i] /= counts[i];
    }

    return { data: output, nFrames: numFrames, nMels: outBins, hopSize, winLength, colourScale };
}
