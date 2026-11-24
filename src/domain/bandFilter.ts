// ═══════════════════════════════════════════════════════════════════════
// bandFilter.ts — the waveform of one frequency band
//
// Bird calls often sit well above wind and traffic rumble: in the plain
// waveform they vanish in the noise, band-limited to what the spectrogram
// shows they stand out. 4th-order Butterworth high- and low-pass (two
// biquads each, RBJ cookbook), run forward only (display, not analysis).
//
// No filtered copy of the file is kept (3 h at 48 kHz would be 2 GB): the
// whole file streams through the filter into the min/max/RMS pyramid once
// per band, and zoomed-in views filter just the visible samples, starting
// a little earlier so the filter has settled.
// Loaded lazily (only when the waveform band is switched on).
// ═══════════════════════════════════════════════════════════════════════

import { PEAK_BLOCK_FINE, reduceFineInto, coarseFrom, type ChannelPeaks, type Peaks } from './waveformEnvelope.ts';

export interface Band { lo: number; hi: number }

type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };

/** Q of the two sections of a 4th-order Butterworth filter. */
const BUTTER4_Q = [0.5411961001461969, 1.3065629648763764];

/** Below this a high-pass is left out; at or above `NYQ_FRAC`·sr a low-pass. */
const MIN_HP_HZ = 1;
const NYQ_FRAC = 0.49;

function biquad(kind: 'hp' | 'lp', sr: number, f: number, q: number): Biquad {
    const w = 2 * Math.PI * f / sr;
    const cos = Math.cos(w), alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    const b1 = kind === 'lp' ? (1 - cos) : -(1 + cos);
    const b0 = kind === 'lp' ? (1 - cos) / 2 : (1 + cos) / 2;
    return { b0: b0 / a0, b1: b1 / a0, b2: b0 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
}

/** The band actually filtered for this sample rate (edges outside the signal dropped), or null for none. */
export function effectiveBand(band: Band | null | undefined, sr: number): Band | null {
    if (!band || !(sr > 0)) return null;
    const lo = band.lo >= MIN_HP_HZ ? band.lo : 0;
    const hi = band.hi > 0 && band.hi < NYQ_FRAC * sr ? band.hi : 0;
    if (!lo && !hi) return null;
    if (lo && hi && hi <= lo) return null;
    return { lo, hi };
}

export function designBand(band: Band, sr: number): Biquad[] {
    const out: Biquad[] = [];
    if (band.lo) for (const q of BUTTER4_Q) out.push(biquad('hp', sr, band.lo, q));
    if (band.hi) for (const q of BUTTER4_Q) out.push(biquad('lp', sr, band.hi, q));
    return out;
}

/** Biquad cascade with state (transposed direct form II, in doubles). */
export class BandFilter {
    #c: Biquad[];
    #z: Float64Array;
    constructor(band: Band, sr: number) {
        this.#c = designBand(band, sr);
        this.#z = new Float64Array(this.#c.length * 2);
    }
    /** Filters `src` into `dst` (may be the same array); NaN samples count as 0. */
    process(src: Float32Array, dst: Float32Array): void {
        const c = this.#c, z = this.#z, n = src.length;
        for (let i = 0; i < n; i++) {
            let x = src[i];
            if (x !== x) x = 0;
            for (let k = 0; k < c.length; k++) {
                const s = c[k];
                const y = s.b0 * x + z[2 * k];
                z[2 * k] = s.b1 * x - s.a1 * y + z[2 * k + 1];
                z[2 * k + 1] = s.b2 * x - s.a2 * y;
                x = y;
            }
            dst[i] = x;
        }
    }
}

/** Samples run through the filter before a range so it has settled (~10 periods of the lower edge, ≤ 1 s). */
export function warmupSamples(band: Band, sr: number): number {
    const f = band.lo || band.hi;
    return Math.min(Math.ceil(sr), Math.ceil(10 * sr / Math.max(f, 10)));
}

/** data[start, end) band-filtered (filter started `warmupSamples` earlier). */
export function filterRange(data: Float32Array, sr: number, band: Band, start: number, end: number): Float32Array {
    start = Math.max(0, start); end = Math.min(data.length, end);
    const out = new Float32Array(Math.max(0, end - start));
    if (!out.length) return out;
    const from = Math.max(0, start - warmupSamples(band, sr));
    const f = new BandFilter(band, sr);
    if (from < start) f.process(data.subarray(from, start), new Float32Array(start - from));
    f.process(data.subarray(start, end), out);
    return out;
}

export function bandKey(band: Band): string {
    return `${Math.round(band.lo)}-${Math.round(band.hi)}`;
}

const cache = new WeakMap<Float32Array, Map<string, ChannelPeaks>>();
/** Bands kept per channel (a frequency zoom back and forth reuses them). */
const CACHE_BANDS = 3;

export function cachedBandPeaks(data: Float32Array, band: Band): ChannelPeaks | null {
    return cache.get(data)?.get(bandKey(band)) ?? null;
}

/**
 * Min/max/RMS pyramid of the band-filtered signal, built in slices of `sliceSamples` with a
 * yield in between; `isCancelled()` stops it (returns null). Cached per channel array and band.
 */
export async function bandPeaksAsync(
    data: Float32Array, sr: number, band: Band,
    { sliceSamples = 1 << 20, isCancelled = () => false }: { sliceSamples?: number; isCancelled?: () => boolean } = {},
): Promise<ChannelPeaks | null> {
    const hit = cachedBandPeaks(data, band);
    if (hit) return hit;
    const slice = Math.max(PEAK_BLOCK_FINE, Math.floor(sliceSamples / PEAK_BLOCK_FINE) * PEAK_BLOCK_FINE);
    const nFine = Math.ceil(data.length / PEAK_BLOCK_FINE);
    const fine: Peaks = { block: PEAK_BLOCK_FINE, min: new Float32Array(nFine), max: new Float32Array(nFine), sq: new Float32Array(nFine) };
    const f = new BandFilter(band, sr);
    const buf = new Float32Array(slice);
    for (let s = 0; s < data.length; s += slice) {
        if (s > 0) {
            await new Promise<void>((r) => setTimeout(r, 0));
            if (isCancelled()) return null;
        }
        const piece = buf.subarray(0, Math.min(slice, data.length - s));
        f.process(data.subarray(s, s + piece.length), piece);
        reduceFineInto(piece, fine.min, fine.max, fine.sq, s / PEAK_BLOCK_FINE);
    }
    const peaks = { fine, coarse: coarseFrom(fine) };
    let m = cache.get(data);
    if (!m) { m = new Map(); cache.set(data, m); }
    m.set(bandKey(band), peaks);
    while (m.size > CACHE_BANDS) m.delete(m.keys().next().value!);
    return peaks;
}

/** Largest |value| in a pyramid (at least 1e-6). */
export function peaksAbsMax(p: ChannelPeaks): number {
    let m = 0;
    const { min, max } = p.coarse;
    for (let i = 0; i < min.length; i++) {
        if (-min[i] > m) m = -min[i];
        if (max[i] > m) m = max[i];
    }
    return Math.max(1e-6, m);
}
