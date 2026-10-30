// ═══════════════════════════════════════════════════════════════════════
// snapToCall.ts — "Snap to call": box a call from a single click
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
