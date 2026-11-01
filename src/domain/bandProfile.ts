// Per-frequency activity profile of a recording, straight from the samples.
// Exports: computeBandProfile(channel, sampleRate), activeTopHz(profile), prominentPeakHz(profile, minHz, maxHz)
//
// For every FFT bin: the noise floor (median dB over sampled frames) and the
// level of the loudest events (high percentile). Their difference, the
// prominence, says where something happens above the background — calls,
// songs — independent of the noise colour. Used for the vertical auto zoom
// and for the heterodyne carrier of bat recordings.

import { iterativeFFT } from './dsp.ts';

const FFT_SIZE = 1024;
/** Adjacent FFT bins pooled into one band: steadies the per-band statistics of noise. */
const POOL = 4;
/** Frames spread evenly over the file. */
const EVEN_FRAMES = 1500;
/** Plus the frames with the most high-frequency energy, so sparse short calls are seen. */
const HF_FRAMES = 500;
const MAX_FRAMES_SCANNED = 40000;
const EVENT_PERCENTILE = 0.98;
/** dB above the typical prominence of the file (its noise baseline) that counts as activity. */
export const ACTIVE_ABOVE_BASELINE_DB = 3;
/** Absolute minimum prominence for activity. */
const MIN_ACTIVE_PROMINENCE_DB = 6;
const MAX_BASELINE_DB = 10;

export interface BandProfile {
    sampleRate: number;
    binHz: number;
    /** Median level per band (dB) — the background. */
    /** Width of one band (Hz). */
    floorDb: Float32Array;
    /** Event level per bin (dB, high percentile). */
    eventDb: Float32Array;
    /** eventDb − floorDb, lightly smoothed over neighbouring bins. */
    prominenceDb: Float32Array;
}

export function computeBandProfile(channel: Float32Array, sampleRate: number): BandProfile | null {
    const nBlocks = Math.floor(channel.length / FFT_SIZE);
    if (nBlocks < 8 || !(sampleRate > 0)) return null;

    const picked = new Set<number>();
    const evenStep = Math.max(1, nBlocks / EVEN_FRAMES);
    for (let x = 0; x < nBlocks; x += evenStep) picked.add(Math.floor(x));

    // First-difference energy rises with frequency: a cheap proxy for "has HF content".
    const stride = Math.max(1, Math.ceil(nBlocks / MAX_FRAMES_SCANNED));
    const scored: { block: number; score: number }[] = [];
    for (let b = 0; b < nBlocks; b += stride) {
        const off = b * FFT_SIZE;
        let e = 0;
        for (let i = off + 1; i < off + FFT_SIZE; i++) {
            const d = channel[i] - channel[i - 1];
            e += d * d;
        }
        scored.push({ block: b, score: e });
    }
    scored.sort((a, b) => b.score - a.score);
    for (const s of scored.slice(0, HF_FRAMES)) picked.add(s.block);

    const blocks = [...picked];
    const half = FFT_SIZE / 2 / POOL; // bands
    const nF = blocks.length;
    const db = new Float32Array(nF * half); // band-major
    const re = new Float32Array(FFT_SIZE);
    const im = new Float32Array(FFT_SIZE);
    const win = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
    for (let f = 0; f < nF; f++) {
        const off = blocks[f] * FFT_SIZE;
        for (let i = 0; i < FFT_SIZE; i++) { re[i] = channel[off + i] * win[i]; im[i] = 0; }
        iterativeFFT(re, im);
        for (let k = 0; k < half; k++) {
            let pw = 0;
            for (let j = k * POOL; j < (k + 1) * POOL; j++) pw += re[j] * re[j] + im[j] * im[j];
            db[k * nF + f] = 10 * Math.log10(pw + 1e-20);
        }
    }

    const floorDb = new Float32Array(half);
    const eventDb = new Float32Array(half);
    const raw = new Float32Array(half);
    const iEvent = Math.min(nF - 1, Math.floor(nF * EVENT_PERCENTILE));
    for (let k = 0; k < half; k++) {
        const col = db.subarray(k * nF, (k + 1) * nF).sort();
        floorDb[k] = col[nF >> 1];
        eventDb[k] = col[iEvent];
        raw[k] = eventDb[k] - floorDb[k];
    }
    const prominenceDb = new Float32Array(half);
    for (let k = 0; k < half; k++) {
        const a = raw[Math.max(0, k - 1)], b = raw[k], c = raw[Math.min(half - 1, k + 1)];
        prominenceDb[k] = (a + 2 * b + c) / 4;
    }
    return { sampleRate, binHz: (sampleRate / FFT_SIZE) * POOL, floorDb, eventDb, prominenceDb };
}

/**
 * Highest frequency with activity above the noise floor, or null when there
 * is none (silence, pure noise). Needs a few active bins in a row, so a single
 * tonal whine does not stretch the view.
 */
export function activeTopHz(p: BandProfile): number | null {
    const lowBin = Math.ceil(150 / p.binHz);
    const baseline = prominenceBaseline(p, lowBin);
    // Fluctuating broadband noise (river, rain, wind) everywhere: no telling where activity ends.
    if (baseline >= MAX_BASELINE_DB) return null;
    const thresholdDb = Math.max(MIN_ACTIVE_PROMINENCE_DB, baseline + ACTIVE_ABOVE_BASELINE_DB);
    let run = 0;
    let top = -1;
    for (let k = lowBin; k < p.prominenceDb.length - 1; k++) {
        if (p.prominenceDb[k] >= thresholdDb) {
            run++;
            if (run >= 2) top = k;
        } else {
            run = 0;
        }
    }
    return top >= 0 ? (top + 1) * p.binHz : null;
}

/**
 * Prominence that plain background reaches by itself (25th percentile over the
 * bands): pure noise already shows a few dB between median and high percentile.
 */
function prominenceBaseline(p: BandProfile, fromBin: number): number {
    const v = Array.from(p.prominenceDb.subarray(fromBin)).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length * 0.25)] : 0;
}

/** Frequency where events stand out most from the background in [minHz, maxHz]. */
export function prominentPeakHz(p: BandProfile, minHz: number, maxHz = p.sampleRate / 2): { hz: number; prominenceDb: number } | null {
    const k0 = Math.max(1, Math.ceil(minHz / p.binHz));
    const k1 = Math.min(p.prominenceDb.length - 2, Math.floor(maxHz / p.binHz));
    let best = -1;
    for (let k = k0; k <= k1; k++) if (best < 0 || p.prominenceDb[k] > p.prominenceDb[best]) best = k;
    if (best < 0) return null;
    return { hz: best * p.binHz, prominenceDb: p.prominenceDb[best] };
}

/** Upper edge for the vertical view: the active top plus headroom, on a readable step. */
export function autoViewMaxHz(p: BandProfile): number | null {
    const top = activeTopHz(p);
    const nyquist = p.sampleRate / 2;
    if (top == null) return null;
    const padded = top * 1.12 + 500;
    const step = padded > 40000 ? 10000 : padded > 12000 ? 2000 : 1000;
    const rounded = Math.ceil(padded / step) * step;
    // Not worth zooming for the last few per cent.
    return rounded >= nyquist * 0.85 ? null : rounded;
}
