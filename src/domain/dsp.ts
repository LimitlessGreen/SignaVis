// ═══════════════════════════════════════════════════════════════════════
// dsp.ts - frequency-axis helpers and a small FFT
//
// The spectrogram itself is computed by the Rust engine (aw_dsp::v2, via
// WASM or Tauri). What stays here: mel / CQT axis frequencies for the
// coordinate system and the FFT used by spectralFeatures.ts.
// ═══════════════════════════════════════════════════════════════════════

// ─── Mel Scale ──────────────────────────────────────────────────────

export function hzToMel(hz: number): number {
    return 2595 * Math.log10(1 + hz / 700);
}

export function melToHz(mel: number): number {
    return 700 * (Math.pow(10, mel / 2595) - 1);
}

/**
 * Return an array of `nMels` frequencies (Hz) evenly spaced in mel scale
 * from 0 Hz to sampleRate/2.
 */
export function buildMelFrequencies(sampleRate: number, nMels: number): Float32Array {
    const melMin = hzToMel(0);
    const melMax = hzToMel(sampleRate / 2);
    const freqs = new Float32Array(nMels);
    for (let i = 0; i < nMels; i++) {
        const mel = melMin + (i / Math.max(1, nMels - 1)) * (melMax - melMin);
        freqs[i] = melToHz(mel);
    }
    return freqs;
}

// ─── FFT (iterative Cooley-Tukey, in-place) ─────────────────────────

// Precomputed twiddle factor tables, keyed by FFT size.
const _twiddleCache = new Map<number, Record<number, { cos: Float64Array; sin: Float64Array }>>();

function getTwiddleFactors(n: number): Record<number, { cos: Float64Array; sin: Float64Array }> {
    if (_twiddleCache.has(n)) return _twiddleCache.get(n)!;
    const table: Record<number, { cos: Float64Array; sin: Float64Array }> = {};
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

export function iterativeFFT(real: Float32Array, imag: Float32Array): void {
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

// ─── Log-Frequency Axis ─────────────────────────────────────────────

/**
 * Build CQT frequency array (Hz) for each output bin.
 * @param {number} nBins
 * @param {number} [fMin=32.7]
 * @param {number} [binsPerOctave=24]
 * @returns {Float32Array}
 */
export function buildCQTFrequencies(nBins: number, fMin = 32.7, binsPerOctave = 24) {
    const freqs = new Float32Array(nBins);
    for (let k = 0; k < nBins; k++) {
        freqs[k] = fMin * Math.pow(2, k / binsPerOctave);
    }
    return freqs;
}
