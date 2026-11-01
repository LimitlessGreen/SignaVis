// Recognises ultrasonic (bat) recordings so playback can offer time expansion.
// Exports: parseGuano(arrayBuffer), analyzeUltrasound(channel, sampleRate, guano)

import { iterativeFFT } from './dsp.ts';
import { prominentPeakHz, type BandProfile } from './bandProfile.ts';

/** Lower edge of "ultrasonic" for detection purposes. */
export const ULTRASONIC_HZ = 18000;

const FFT_SIZE = 1024;
const BLOCKS_ANALYSED = 32;
const MAX_BLOCKS_SCANNED = 20000;
const MIN_ULTRASONIC_FRACTION = 0.3;
/** Below this the band above 18 kHz is too narrow for slowing down to help. */
const MIN_SAMPLE_RATE = 64000;

export interface UltrasoundInfo {
    isUltrasonic: boolean;
    /** What the verdict rests on. */
    source: 'guano' | 'spectrum' | 'none';
    /** Frequency above ULTRASONIC_HZ where the calls stand out most (heterodyne carrier). */
    peakHz: number | null;
    /** Share of spectral energy above ULTRASONIC_HZ in those blocks (0–1). */
    ultrasonicFraction: number;
    /** Time-expansion factor the file was already stored with (GUANO `TE`), 1 if none. */
    storedExpansion: number;
    /** Slowdown to offer, 1 when nothing should be suggested. */
    suggestedExpansion: number;
    /** "Make Model" from GUANO, if any. */
    device: string | null;
    guano: Record<string, string> | null;
}

/**
 * Reads the GUANO metadata chunk (`guan`) that bat detectors write into WAV files.
 * @returns key/value pairs, or null when the file has no GUANO chunk
 */
export function parseGuano(buf: ArrayBuffer): Record<string, string> | null {
    if (buf.byteLength < 12) return null;
    const view = new DataView(buf);
    if (view.getUint32(0) !== 0x52494646 || view.getUint32(8) !== 0x57415645) return null;

    let pos = 12;
    while (pos + 8 <= buf.byteLength) {
        const id = view.getUint32(pos);
        const size = view.getUint32(pos + 4, true);
        const body = pos + 8;
        if (id === 0x6775616E) { // 'guan'
            const end = Math.min(body + size, buf.byteLength);
            const text = new TextDecoder('utf-8').decode(new Uint8Array(buf, body, end - body));
            const out: Record<string, string> = {};
            for (const line of text.split(/\r?\n/)) {
                const i = line.indexOf(':');
                if (i <= 0) continue;
                const key = line.slice(0, i).trim();
                const value = line.slice(i + 1).trim().replace(/\0+$/, '');
                if (key) out[key] = value;
            }
            return out;
        }
        pos = body + size + (size & 1); // chunks are word-aligned
    }
    return null;
}

/**
 * Decides whether a recording carries ultrasound worth slowing down.
 * Looks at the blocks with the most high-frequency energy, so sparse calls
 * in a long, mostly quiet file are still found.
 */
export function analyzeUltrasound(
    channel: Float32Array,
    sampleRate: number,
    guano: Record<string, string> | null = null,
    profile: BandProfile | null = null,
): UltrasoundInfo {
    const storedExpansion = Math.max(1, parseFloat(guano?.['TE'] ?? '') || 1);
    const device = guano ? [guano['Make'], guano['Model']].filter(Boolean).join(' ') || null : null;
    const hf = sampleRate >= MIN_SAMPLE_RATE
        ? highFrequencySpectrum(channel, sampleRate)
        : { peakHz: null, fraction: 0 };
    const fraction = hf.fraction;
    // The band profile compares events with the background per frequency, so the
    // pink noise tilt does not pull the peak down to the bottom of the band.
    const prominent = profile && sampleRate >= MIN_SAMPLE_RATE ? prominentPeakHz(profile, ULTRASONIC_HZ) : null;
    const peakHz = prominent && prominent.prominenceDb >= 6 ? prominent.hz : hf.peakHz;

    const fromSpectrum = fraction >= MIN_ULTRASONIC_FRACTION && peakHz != null;
    // GUANO is written by bat detectors; with a full-spectrum sample rate that is enough.
    const fromGuano = guano != null && sampleRate >= 96000;
    const isUltrasonic = fromSpectrum || fromGuano;

    let suggestedExpansion = 1;
    if (isUltrasonic && storedExpansion === 1) {
        suggestedExpansion = peakHz != null && peakHz > 70000 ? 16 : 10;
    }

    return {
        isUltrasonic,
        source: fromSpectrum ? 'spectrum' : fromGuano ? 'guano' : 'none',
        peakHz,
        ultrasonicFraction: fraction,
        storedExpansion,
        suggestedExpansion,
        device,
        guano,
    };
}

function highFrequencySpectrum(channel: Float32Array, sampleRate: number) {
    const nBlocks = Math.floor(channel.length / FFT_SIZE);
    if (nBlocks === 0) return { peakHz: null, fraction: 0 };

    // First-difference energy rises with frequency: a cheap proxy for "has HF content".
    const stride = Math.max(1, Math.ceil(nBlocks / MAX_BLOCKS_SCANNED));
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

    const half = FFT_SIZE / 2;
    const power = new Float64Array(half);
    const re = new Float32Array(FFT_SIZE);
    const im = new Float32Array(FFT_SIZE);
    for (const { block } of scored.slice(0, BLOCKS_ANALYSED)) {
        const off = block * FFT_SIZE;
        for (let i = 0; i < FFT_SIZE; i++) {
            const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
            re[i] = channel[off + i] * w;
            im[i] = 0;
        }
        iterativeFFT(re, im);
        for (let k = 0; k < half; k++) power[k] += re[k] * re[k] + im[k] * im[k];
    }

    const binHz = sampleRate / FFT_SIZE;
    const lowBin = Math.ceil(200 / binHz); // ignore DC and wind rumble
    const usBin = Math.ceil(ULTRASONIC_HZ / binHz);
    let total = 0;
    let ultrasonic = 0;
    let peakBin = -1;
    for (let k = lowBin; k < half; k++) {
        total += power[k];
        if (k >= usBin) {
            ultrasonic += power[k];
            if (peakBin < 0 || power[k] > power[peakBin]) peakBin = k;
        }
    }
    return {
        peakHz: peakBin >= 0 ? peakBin * binHz : null,
        fraction: total > 0 ? ultrasonic / total : 0,
    };
}
