// ═══════════════════════════════════════════════════════════════════════
// spectralFeatures.ts — per-frame spectral centroid, cepstral F0,
//                       and spectral ridge tracking
//
// All derived from raw audio (channelData) via FFT, independent of the
// mel filterbank and valid for any scale setting.
//
// Centroid : weighted mean frequency of the magnitude spectrum per frame.
// F0       : fundamental frequency via real cepstrum (log-spectrum IFFT).
//            Returns 0 for unvoiced / below-threshold frames.
// Ridges   : continuous frequency tracks formed by linking local spectral
//            maxima across adjacent frames (Raven-style contour lines).
// ═══════════════════════════════════════════════════════════════════════

import { iterativeFFT } from './dsp.ts';

// ─── Hann window cache ──────────────────────────────────────────────
const _hannCache = new Map<number, Float32Array>();
function hannWindow(n: number): Float32Array {
    if (_hannCache.has(n)) return _hannCache.get(n)!;
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    _hannCache.set(n, w);
    return w;
}

// ─── Per-frame helpers ──────────────────────────────────────────────

function frameCentroid(
    channelData: Float32Array,
    offset: number,
    windowSize: number,
    fftSize: number,
    hann: Float32Array,
    freqPerBin: number,     // sampleRate / fftSize
): number {
    const real = new Float32Array(fftSize);
    const imag = new Float32Array(fftSize);
    const copy = Math.min(windowSize, fftSize, channelData.length - offset);
    for (let i = 0; i < copy; i++) real[i] = (channelData[offset + i] || 0) * hann[i];

    iterativeFFT(real, imag);

    let sumMag = 0, sumWeighted = 0;
    const nBins = fftSize / 2;
    for (let k = 1; k < nBins; k++) {
        const mag = Math.sqrt(real[k] * real[k] + imag[k] * imag[k]);
        sumMag       += mag;
        sumWeighted  += mag * k * freqPerBin;
    }
    return sumMag > 1e-10 ? sumWeighted / sumMag : 0;
}

// Cepstral F0 via real cepstrum: IFFT(log|FFT(frame)|).
// Returns Hz or 0 for unvoiced frames.
function frameCepstralF0(
    channelData: Float32Array,
    offset: number,
    windowSize: number,
    fftSize: number,
    hann: Float32Array,
    sampleRate: number,
    minF0: number,
    maxF0: number,
): number {
    const real = new Float32Array(fftSize);
    const imag = new Float32Array(fftSize);
    const copy = Math.min(windowSize, fftSize, channelData.length - offset);
    for (let i = 0; i < copy; i++) real[i] = (channelData[offset + i] || 0) * hann[i];

    iterativeFFT(real, imag);

    // Log magnitude spectrum → symmetric (even) real sequence for IFFT.
    const nBins = fftSize / 2;
    const logSpec = new Float32Array(fftSize);
    for (let k = 0; k < nBins; k++) {
        const mag = Math.sqrt(real[k] * real[k] + imag[k] * imag[k]);
        logSpec[k] = Math.log(mag + 1e-10);
    }
    // Mirror (for k = 1 .. nBins-1) so the sequence is even.
    for (let k = 1; k < nBins; k++) logSpec[fftSize - k] = logSpec[k];

    // FFT of the real even sequence = N * real cepstrum.
    const cimag = new Float32Array(fftSize);
    iterativeFFT(logSpec, cimag);

    // Search for peak in the quefrency band [sampleRate/maxF0, sampleRate/minF0].
    const minQ = Math.max(1, Math.ceil(sampleRate / maxF0));
    const maxQ = Math.min(nBins - 1, Math.floor(sampleRate / minF0));

    let peakVal = -Infinity, peakQ = -1;
    for (let q = minQ; q <= maxQ; q++) {
        const v = logSpec[q]; // logSpec reused, now holds real cepstrum * fftSize
        if (v > peakVal) { peakVal = v; peakQ = q; }
    }

    // Empirical voicing threshold (relative to q=0 which is the log-energy).
    const threshold = logSpec[0] * 0.05;
    if (peakQ < 0 || peakVal < threshold) return 0;
    return sampleRate / peakQ;
}

// ─── Public API ─────────────────────────────────────────────────────

export interface SpectralFeatures {
    centroid: Float32Array; // Hz per frame
    f0:       Float32Array; // Hz per frame (0 = unvoiced)
}

/**
 * Compute per-frame spectral centroid and cepstral F0 from raw audio.
 *
 * @param channelData  Raw PCM samples (mono)
 * @param sampleRate   Sample rate in Hz
 * @param hopSize      Frame hop in samples (same as used for the spectrogram)
 * @param windowSize   Analysis window length in samples
 * @param nFrames      Number of spectrogram frames to match
 * @param minF0        Minimum expected F0 in Hz (default 50)
 * @param maxF0        Maximum expected F0 in Hz (default 1200)
 */
export function computeSpectralFeatures(
    channelData: Float32Array,
    sampleRate: number,
    hopSize: number,
    windowSize: number,
    nFrames: number,
    minF0 = 50,
    maxF0 = 1200,
): SpectralFeatures {
    // Use the smallest power-of-two >= windowSize for FFT.
    let fftSize = 1;
    while (fftSize < windowSize) fftSize <<= 1;

    const hann       = hannWindow(windowSize);
    const freqPerBin = sampleRate / fftSize;
    const centroid   = new Float32Array(nFrames);
    const f0         = new Float32Array(nFrames);

    for (let frame = 0; frame < nFrames; frame++) {
        const offset = frame * hopSize;
        if (offset + windowSize > channelData.length) break;

        centroid[frame] = frameCentroid(channelData, offset, windowSize, fftSize, hann, freqPerBin);
        f0[frame]       = frameCepstralF0(channelData, offset, windowSize, fftSize, hann, sampleRate, minF0, maxF0);
    }

    return { centroid, f0 };
}

// ─── Spectral Ridge Detection ────────────────────────────────────────

/**
 * A ridge is a continuous frequency track: a local spectral maximum that
 * persists across multiple consecutive frames.  Each entry in the arrays
 * corresponds to one frame where the ridge was active.
 *
 * `strength` is normalised to [0, 1] relative to the strongest ridge in
 * the recording.
 */
export interface Ridge {
    frames:   Uint32Array;   // frame indices (monotonically increasing)
    freqHz:   Float32Array;  // instantaneous frequency in Hz
    strength: Float32Array;  // relative magnitude [0, 1]
}

// Internal bookkeeping during ridge building
interface ActiveRidge {
    frames:    number[];
    freqHz:    number[];
    strength:  number[];
    lastFrame: number;
}

// Extract the top-N local magnitude maxima from one FFT frame.
function extractPeaks(
    mag: Float32Array,
    nBins: number,
    freqPerBin: number,
    topN: number,
    noiseFloor: number,   // ignore peaks below this absolute magnitude
): Array<{ freqHz: number; strength: number }> {
    const peaks: Array<{ freqHz: number; strength: number }> = [];
    for (let k = 1; k < nBins - 1; k++) {
        if (mag[k] > mag[k - 1] && mag[k] > mag[k + 1] && mag[k] > noiseFloor) {
            // Parabolic interpolation for sub-bin frequency accuracy
            const denom = mag[k - 1] - 2 * mag[k] + mag[k + 1];
            const delta  = denom !== 0 ? 0.5 * (mag[k - 1] - mag[k + 1]) / denom : 0;
            peaks.push({ freqHz: (k + delta) * freqPerBin, strength: mag[k] });
        }
    }
    peaks.sort((a, b) => b.strength - a.strength);
    return peaks.slice(0, topN);
}

/**
 * Compute spectral ridges from raw audio.
 *
 * @param channelData       Mono PCM samples
 * @param sampleRate        Sample rate in Hz
 * @param hopSize           Frame hop in samples (same as spectrogram)
 * @param windowSize        Analysis window in samples
 * @param nFrames           Number of frames to analyse
 * @param minLengthFrames   Minimum ridge length; shorter ridges are discarded (default 8)
 * @param maxFreqJumpHz     Maximum Hz between consecutive ridge points (default 200)
 * @param maxGapFrames      Maximum silent frames before a ridge is closed (default 2)
 * @param maxPeaksPerFrame  How many local maxima to track per frame (default 20)
 */
export function computeRidges(
    channelData: Float32Array,
    sampleRate: number,
    hopSize: number,
    windowSize: number,
    nFrames: number,
    minLengthFrames = 8,
    maxFreqJumpHz   = 200,
    maxGapFrames    = 2,
    maxPeaksPerFrame = 20,
): Ridge[] {
    // FFT size: smallest power-of-two >= windowSize
    let fftSize = 1;
    while (fftSize < windowSize) fftSize <<= 1;

    const nBins      = fftSize / 2;
    const freqPerBin = sampleRate / fftSize;
    const hann       = hannWindow(windowSize);

    // ── Pass 1: collect per-frame peaks ─────────────────────────────
    const framePeaks: Array<Array<{ freqHz: number; strength: number }>> = [];

    // Running median estimate for noise floor (per-bin rolling max, simplified).
    let globalMax = 0;
    const tempMag = new Float32Array(nBins);
    // First pass to find global max for noise threshold
    for (let frame = 0; frame < Math.min(nFrames, 200); frame++) {
        const off = frame * hopSize;
        if (off + windowSize > channelData.length) break;
        const real = new Float32Array(fftSize);
        const imag = new Float32Array(fftSize);
        for (let i = 0; i < windowSize; i++) real[i] = (channelData[off + i] || 0) * hann[i];
        iterativeFFT(real, imag);
        for (let k = 0; k < nBins; k++) {
            const m = Math.sqrt(real[k] * real[k] + imag[k] * imag[k]);
            if (m > globalMax) globalMax = m;
        }
    }
    const noiseFloor = globalMax * 0.02; // 2 % of global peak

    for (let frame = 0; frame < nFrames; frame++) {
        const off = frame * hopSize;
        if (off + windowSize > channelData.length) { framePeaks.push([]); continue; }

        const real = new Float32Array(fftSize);
        const imag = new Float32Array(fftSize);
        for (let i = 0; i < windowSize; i++) real[i] = (channelData[off + i] || 0) * hann[i];
        iterativeFFT(real, imag);
        for (let k = 0; k < nBins; k++) tempMag[k] = Math.sqrt(real[k] * real[k] + imag[k] * imag[k]);

        framePeaks.push(extractPeaks(tempMag, nBins, freqPerBin, maxPeaksPerFrame, noiseFloor));
    }

    // ── Pass 2: greedy ridge linking ─────────────────────────────────
    const active: ActiveRidge[]  = [];
    const finished: ActiveRidge[] = [];

    for (let frame = 0; frame < nFrames; frame++) {
        // Close ridges that exceeded the gap limit
        for (let i = active.length - 1; i >= 0; i--) {
            if (frame - active[i].lastFrame > maxGapFrames) {
                finished.push(active.splice(i, 1)[0]);
            }
        }

        const peaks = framePeaks[frame];
        const matched = new Set<number>();

        // Greedy nearest-neighbour matching (peaks sorted by strength → most prominent first)
        for (const peak of peaks) {
            let bestIdx = -1, bestDist = maxFreqJumpHz;
            for (let i = 0; i < active.length; i++) {
                if (matched.has(i)) continue;
                const lastFreq = active[i].freqHz[active[i].freqHz.length - 1];
                const dist = Math.abs(peak.freqHz - lastFreq);
                if (dist < bestDist) { bestDist = dist; bestIdx = i; }
            }

            if (bestIdx >= 0) {
                matched.add(bestIdx);
                active[bestIdx].frames.push(frame);
                active[bestIdx].freqHz.push(peak.freqHz);
                active[bestIdx].strength.push(peak.strength);
                active[bestIdx].lastFrame = frame;
            } else {
                active.push({
                    frames:    [frame],
                    freqHz:    [peak.freqHz],
                    strength:  [peak.strength],
                    lastFrame: frame,
                });
            }
        }
    }
    finished.push(...active);

    // ── Pass 3: filter, normalise, convert ───────────────────────────
    const long = finished.filter(r => r.frames.length >= minLengthFrames);
    if (long.length === 0) return [];

    let maxStrength = 1e-10;
    for (const r of long) for (const s of r.strength) if (s > maxStrength) maxStrength = s;

    return long.map(r => ({
        frames:   new Uint32Array(r.frames),
        freqHz:   new Float32Array(r.freqHz),
        strength: new Float32Array(r.strength.map(s => s / maxStrength)),
    }));
}
