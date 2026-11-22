// ═══════════════════════════════════════════════════════════════════════
// snapToCall.ts — "Snap to call": box a call from a single click
//
// The label layer asks a call detector first (SnapBoxSource, BirdBox); this is the
// signal-based answer where the detector has no box, no results or no model
// (ultrasound, offline).
//
// Works on a linear-frequency dB patch around the click: values are taken
// relative to the per-band noise floor (median over the patch), the seed is
// the strongest cell near the click, and an 8-connected region growing with
// a one-cell gap tolerance collects every cell above the threshold. The
// threshold follows the sensitivity: floor + (1 − s) · peak, at least
// MIN_ABOVE_FLOOR_DB. Idea after Spectrolipi's magic wand (which grows on
// raw magnitudes against a local mean).
// ═══════════════════════════════════════════════════════════════════════

/** dB values [frame][bin], bins low → high on a linear axis. */
export interface SnapPatch {
    values: Float32Array;
    frames: number;
    bins: number;
    /** Time (s) of frame 0 (frame centre) and frame spacing (s). */
    t0: number;
    dt: number;
    /** Centre frequency (Hz) of bin 0 and bin spacing (Hz). */
    f0: number;
    df: number;
    /** Patch reaches the start / end of the recording. */
    atStart: boolean;
    atEnd: boolean;
}

export interface SnapBox { start: number; end: number; freqMin: number; freqMax: number }

export type SnapResult =
    | { ok: true; box: SnapBox; peakDb: number; thresholdDb: number; touchesEdge: boolean }
    | { ok: false; reason: 'noise' | 'spread' };

/**
 * Boxes of a call detector (BirdBox) for Snap: the box under a click at confidence `conf`;
 * `weaker`: no box at `conf`, but one below it. Null: no detector results for this recording.
 */
export type SnapBoxSource = (time: number, freq: number, conf: number) => { box: SnapBox | null; weaker: boolean } | null;
/** Start confidence for detector boxes (BirdBox default; see scripts/birdbox/snap-benchmark.mjs). */
export const SNAP_BOX_DEFAULT_CONF = 0.15;

export const SNAP_DEFAULT_SENSITIVITY = 0.75;
/** Seed must stand this far above the band floor. */
export const MIN_PEAK_DB = 10;
/** Threshold never goes below floor + this. */
export const MIN_ABOVE_FLOOR_DB = 3;
/** Seed search radius around the click (cells). */
const SEED_RADIUS_FRAMES = 5, SEED_RADIUS_BINS = 5;
/** Neighbourhood reach: 2 → cells two steps away connect (bridges one-cell gaps). */
const REACH = 2;
/** Region larger than this share of the patch = trace merges with background. */
const MAX_FILL = 0.25;

/** Median per bin over all frames. */
export function bandMedians(p: SnapPatch): Float32Array {
    const out = new Float32Array(p.bins), col = new Float32Array(p.frames);
    for (let b = 0; b < p.bins; b++) {
        for (let f = 0; f < p.frames; f++) col[f] = p.values[f * p.bins + b];
        col.sort();
        const m = p.frames >> 1;
        out[b] = p.frames & 1 ? col[m] : 0.5 * (col[m - 1] + col[m]);
    }
    return out;
}

export function snapToCall(p: SnapPatch, time: number, freq: number,
    sensitivity = SNAP_DEFAULT_SENSITIVITY, floor: Float32Array = bandMedians(p)): SnapResult {
    const { frames, bins, values } = p;
    const snr = (f: number, b: number) => values[f * bins + b] - floor[b];
    const cf = Math.min(frames - 1, Math.max(0, Math.round((time - p.t0) / p.dt)));
    const cb = Math.min(bins - 1, Math.max(0, Math.round((freq - p.f0) / p.df)));

    let peak = -Infinity, sf = cf, sb = cb;
    for (let f = Math.max(0, cf - SEED_RADIUS_FRAMES); f <= Math.min(frames - 1, cf + SEED_RADIUS_FRAMES); f++) {
        for (let b = Math.max(0, cb - SEED_RADIUS_BINS); b <= Math.min(bins - 1, cb + SEED_RADIUS_BINS); b++) {
            const v = snr(f, b);
            if (v > peak) { peak = v; sf = f; sb = b; }
        }
    }
    if (!(peak >= MIN_PEAK_DB)) return { ok: false, reason: 'noise' };

    const s = Math.min(0.99, Math.max(0.01, sensitivity));
    const thr = Math.max(MIN_ABOVE_FLOOR_DB, (1 - s) * peak);
    const limit = Math.floor(frames * bins * MAX_FILL);
    const seen = new Uint8Array(frames * bins);
    const queue = new Int32Array(frames * bins);
    let head = 0, tail = 0, count = 1;
    queue[tail++] = sf * bins + sb; seen[sf * bins + sb] = 1;
    let fMin = sf, fMax = sf, bMin = sb, bMax = sb;
    while (head < tail) {
        const idx = queue[head++], f = (idx / bins) | 0, b = idx - f * bins;
        if (f < fMin) fMin = f; if (f > fMax) fMax = f;
        if (b < bMin) bMin = b; if (b > bMax) bMax = b;
        for (let df = -REACH; df <= REACH; df++) {
            const nf = f + df;
            if (nf < 0 || nf >= frames) continue;
            for (let db = -REACH; db <= REACH; db++) {
                const nb = b + db;
                if (nb < 0 || nb >= bins) continue;
                const n = nf * bins + nb;
                if (seen[n]) continue;
                seen[n] = 1;
                if (snr(nf, nb) < thr) continue;
                if (++count > limit) return { ok: false, reason: 'spread' };
                queue[tail++] = n;
            }
        }
    }

    // Box edges: half a cell beyond the outermost cells.
    const box: SnapBox = {
        start: Math.max(0, p.t0 + (fMin - 0.5) * p.dt),
        end: p.t0 + (fMax + 0.5) * p.dt,
        freqMin: Math.max(0, p.f0 + (bMin - 0.5) * p.df),
        freqMax: p.f0 + (bMax + 0.5) * p.df,
    };
    const touchesEdge = (fMin === 0 && !p.atStart) || (fMax === frames - 1 && !p.atEnd);
    return { ok: true, box, peakDb: peak, thresholdDb: thr, touchesEdge };
}

/** Lowest frequency a full-band fit seeds at: below it wind and handling noise win. */
export const FIT_MIN_FREQ = 300;
/** Noise floor for a fit: a low percentile per band (calls may fill more than half of a window). */
export const FIT_FLOOR_PERCENTILE = 0.2;
/** Dynamic range of a fit: cells further below the patch maximum count as floor (lossy codecs leave bands near digital silence). */
export const FIT_RANGE_DB = 70;
/** Seed neighbourhood (± frames, ± bins): a call is an area, a click or spike one cell. */
const FIT_NEIGH_FRAMES = 4, FIT_NEIGH_BINS = 2;

/** Per-band percentile of the patch values. */
export function bandPercentile(p: SnapPatch, q: number): Float32Array {
    const out = new Float32Array(p.bins), col = new Float32Array(p.frames);
    const k = Math.min(p.frames - 1, Math.max(0, Math.round(q * (p.frames - 1))));
    for (let b = 0; b < p.bins; b++) {
        for (let f = 0; f < p.frames; f++) col[f] = p.values[f * p.bins + b];
        col.sort();
        out[b] = col[k];
    }
    return out;
}

/**
 * Box the strongest call inside a time window (a label without frequency bounds, e.g. BirdNET's
 * 3 s): seed where the energy above the noise floor, summed over a small neighbourhood, is
 * largest in the window; grow as snapToCall does; keep the box inside the window.
 */
export function fitToCall(src: SnapPatch, window: { start: number; end: number },
    sensitivity = SNAP_DEFAULT_SENSITIVITY): SnapResult {
    // Clip to FIT_RANGE_DB below the maximum: near-silent bands (MP3 above ~16 kHz) would make
    // any residue look far above their floor
    let max = -Infinity;
    for (let i = 0; i < src.values.length; i++) if (src.values[i] > max) max = src.values[i];
    const lo = max - FIT_RANGE_DB, clipped = new Float32Array(src.values.length);
    for (let i = 0; i < clipped.length; i++) clipped[i] = Math.max(lo, src.values[i]);
    const p: SnapPatch = { ...src, values: clipped };
    const floor = bandPercentile(p, FIT_FLOOR_PERCENTILE);
    // Only the window's frames: seed search and growth cannot leave it
    const fFrom = Math.max(0, Math.ceil((window.start - p.t0) / p.dt));
    const fTo = Math.min(p.frames - 1, Math.floor((window.end - p.t0) / p.dt));
    if (fTo - fFrom < 2) return { ok: false, reason: 'noise' };
    const { bins } = p, frames = fTo - fFrom + 1;
    const values = p.values.subarray(fFrom * bins, (fTo + 1) * bins);
    const win: SnapPatch = { ...p, values, frames, t0: p.t0 + fFrom * p.dt, atStart: true, atEnd: true };
    const bFrom = Math.max(0, Math.ceil((FIT_MIN_FREQ - p.f0) / p.df));
    if (bFrom >= bins) return { ok: false, reason: 'noise' };
    // Summed-area table of the positive SNR (frames + 1) × (bins + 1)
    const W = bins + 1, sat = new Float64Array((frames + 1) * W);
    for (let f = 0; f < frames; f++) {
        let row = 0;
        for (let b = 0; b < bins; b++) {
            row += Math.max(0, values[f * bins + b] - floor[b]);
            sat[(f + 1) * W + b + 1] = sat[f * W + b + 1] + row;
        }
    }
    const area = (f0: number, f1: number, b0: number, b1: number) =>
        sat[(f1 + 1) * W + b1 + 1] - sat[f0 * W + b1 + 1] - sat[(f1 + 1) * W + b0] + sat[f0 * W + b0];
    // Seed: the largest neighbourhood energy among cells that are themselves a clear peak
    let best = -1, sf = -1, sb = -1;
    for (let f = 0; f < frames; f++) {
        const f0 = Math.max(0, f - FIT_NEIGH_FRAMES), f1 = Math.min(frames - 1, f + FIT_NEIGH_FRAMES);
        for (let b = bFrom; b < bins; b++) {
            if (!(values[f * bins + b] - floor[b] >= MIN_PEAK_DB)) continue;
            const v = area(f0, f1, Math.max(0, b - FIT_NEIGH_BINS), Math.min(bins - 1, b + FIT_NEIGH_BINS));
            if (v > best) { best = v; sf = f; sb = b; }
        }
    }
    if (sf < 0) return { ok: false, reason: 'noise' };
    const r = snapToCall(win, win.t0 + sf * p.dt, p.f0 + sb * p.df, sensitivity, floor);
    if (!r.ok) return r;
    // Box edges lie half a cell beyond the outer cells: trim to the window, never extend
    const start = Math.max(r.box.start, window.start), end = Math.min(r.box.end, window.end);
    if (!(end > start)) return { ok: false, reason: 'noise' };
    return { ...r, box: { ...r.box, start, end } };
}
