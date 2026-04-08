// ═══════════════════════════════════════════════════════════════════════
// spectrolipiEngine.js — Spectrolipi-style spectrogram processor
//
// Implements the same compute() interface as createSpectrogramProcessor()
// but uses spectrolipi's simpler DSP approach:
//   • Custom inline FFT (Cooley–Tukey, no precomputed twiddles)
//   • Hann window only
//   • Linear frequency bins only (no mel filterbank)
//   • dB output (no PCEN)
//   • Main-thread execution (no Web Worker)
//
// This enables A/B comparison of spectrogram engines during development.
// ═══════════════════════════════════════════════════════════════════════

// ─── FFT (spectrolipi style) ────────────────────────────────────────

function hannWindow(N) {
    const w = new Float32Array(N);
    for (let n = 0; n < N; n++) {
        w[n] = 0.5 * (1 - Math.cos(2 * Math.PI * n / (N - 1)));
    }
    return w;
}

function reverseBits(x, bits) {
    let y = 0;
    for (let i = 0; i < bits; i++) {
        y = (y << 1) | (x & 1);
        x >>>= 1;
    }
    return y;
}

function fft(real, imag) {
    const n = real.length;
    const levels = Math.log2(n) | 0;
    if ((1 << levels) !== n) throw new Error('FFT size must be power of two');

    for (let i = 0; i < n; i++) {
        const j = reverseBits(i, levels);
        if (j > i) {
            const tr = real[i], ti = imag[i];
            real[i] = real[j]; imag[i] = imag[j];
            real[j] = tr; imag[j] = ti;
        }
    }

    for (let size = 2; size <= n; size <<= 1) {
        const half = size >>> 1;
        const theta = -2 * Math.PI / size;
        const wpr = Math.cos(theta), wpi = Math.sin(theta);
        for (let i = 0; i < n; i += size) {
            let wr = 1, wi = 0;
            for (let j = 0; j < half; j++) {
                const k = i + j, l = k + half;
                const tr = wr * real[l] - wi * imag[l];
                const ti = wr * imag[l] + wi * real[l];
                real[l] = real[k] - tr;
                imag[l] = imag[k] - ti;
                real[k] += tr;
                imag[k] += ti;
                const tmp = wr;
                wr = tmp * wpr - wi * wpi;
                wi = tmp * wpi + wi * wpr;
            }
        }
    }
}

// ─── Compute ────────────────────────────────────────────────────────

function computeSpectrolipi(channelData, options) {
    const {
        fftSize,
        sampleRate,
        frameRate,
        hopSize: userHopSize,
        windowSize: userWindowSize,
    } = options;

    const audio = channelData instanceof Float32Array
        ? channelData
        : new Float32Array(channelData);

    const N = fftSize;
    if ((N & (N - 1)) !== 0) throw new Error('FFT size must be power of two');

    // Spectrolipi uses hop = fftSize / 2 by default.
    // Respect user overrides, fall back to fftSize/2, then frameRate-based.
    const hop = (userHopSize && userHopSize > 0)
        ? userHopSize
        : Math.max(1, Math.floor(N / 2));

    const winLength = (userWindowSize && userWindowSize > 0) ? userWindowSize : N;
    const numFrames = Math.max(1, Math.floor((audio.length - winLength) / hop) + 1);
    const bins = N / 2;

    const window = hannWindow(winLength);
    const output = new Float32Array(numFrames * bins);
    const re = new Float32Array(N);
    const im = new Float32Array(N);

    for (let fIdx = 0; fIdx < numFrames; fIdx++) {
        const off = fIdx * hop;

        // Apply window and zero-pad if winLength < fftSize
        for (let n = 0; n < N; n++) {
            if (n < winLength) {
                const s = (off + n < audio.length) ? audio[off + n] : 0;
                re[n] = s * window[n];
            } else {
                re[n] = 0;
            }
            im[n] = 0;
        }

        fft(re, im);

        // Magnitude → power → dB (same as spectrolipi)
        for (let b = 0; b < bins; b++) {
            const r = re[b], i = im[b];
            const mag = Math.sqrt(r * r + i * i) / N;
            output[fIdx * bins + b] = 20 * Math.log10(mag + 1e-12);
        }
    }

    return {
        data: output,
        nFrames: numFrames,
        nMels: bins,      // linear bins, not mel — but interface uses nMels
        hopSize: hop,
        winLength,
    };
}

// ─── Public Factory ─────────────────────────────────────────────────

export function createSpectrolipiProcessor() {
    return {
        compute(channelData, options) {
            // Force linear scale — spectrolipi has no mel support
            return Promise.resolve(computeSpectrolipi(channelData, {
                ...options,
                scale: 'linear',
            }));
        },
        async *computeProgressive(channelData, options) {
            // Single-shot — no chunking support for spectrolipi
            const result = computeSpectrolipi(channelData, {
                ...options,
                scale: 'linear',
            });
            yield { chunk: 0, totalChunks: 1, percent: 100, result };
        },
        dispose() {
            // No worker to terminate
        },
    };
}
