// domain/similar/ncc.ts — find repeats of a labelled call by spectrogram correlation
//
// The exemplar's spectrogram patch (its band plus a small margin) slides over the whole
// recording; the score at each offset is the normalised cross-correlation (Pearson r over
// all cells), maximised over a small frequency shift because repeats wander a little.
// Measured on Powdermill (plans/similar-calls-plan.md): better than gating by BirdBox
// boxes, and as good on quiet calls as on loud ones.
//
// Correlation runs blockwise (overlap-save FFT), so memory stays small for long recordings.

/** Band rows of a spectrogram, floor removed (dB above the row's median), row-major. */
export interface BandSpectrogram {
    values: Float32Array;   // rows × frames
    rows: number;
    frames: number;
    /** Frequency (Hz) of row 0 and row spacing; time (s) of frame 0 and frame spacing. */
    f0: number; df: number;
    t0: number; dt: number;
}

export interface Box { start: number; end: number; freqMin: number; freqMax: number }
export interface SimilarHit extends Box {
    score: number;
    /** First frame and row shift of the match (for patches / re-ranking). */
    frame?: number;
    shift?: number;
}

export interface FindOptions {
    /** Frequency shift tolerated, in rows (each way). */
    shift?: number;
    /** Rows added above and below the exemplar's band. */
    margin?: number;
    /** Lowest score kept. */
    minScore?: number;
    /** Most hits returned. */
    max?: number;
    /** Two hits are at least this share of the exemplar's duration apart. */
    minGap?: number;
}

/** In-place radix-2 complex FFT; `inverse` scales by 1/n. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            let t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = (inverse ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let k = 0; k < half; k++) {
                const a = i + k, b = a + half;
                const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
                re[b] = re[a] - xr; im[b] = im[a] - xi;
                re[a] += xr; im[a] += xi;
                const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
            }
        }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

const nextPow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(2, n)));

/**
 * Normalised cross-correlation of rows [r0, r1) × frames [c0, c1) over every frame offset,
 * best over row shifts −shift..shift. Returns score per offset (length frames − width + 1)
 * and the shift that gave it.
 */
export function nccCurve(spec: BandSpectrogram, r0: number, r1: number, c0: number, c1: number, shift = 2): { score: Float32Array; shiftAt: Int8Array } {
    const R = r1 - r0, T = c1 - c0, P = new Float32Array(Math.max(0, R * T));
    for (let r = 0; r < R; r++) for (let t = 0; t < T; t++) P[r * T + t] = spec.values[(r0 + r) * spec.frames + c0 + t];
    return correlate(spec, P, R, T, r0, shift);
}

/**
 * Normalised cross-correlation of patch P (R × T, any scale) placed at rows [r0, r0 + R) of `spec`,
 * over every frame offset, best over row shifts −shift..shift.
 */
export function correlate(spec: BandSpectrogram, patch: Float32Array, R: number, T: number, r0: number, shift = 2): { score: Float32Array; shiftAt: Int8Array } {
    const { values: X, frames: N } = spec;
    const r1 = r0 + R, out = Math.max(0, N - T + 1);
    const score = new Float32Array(out).fill(-1), shiftAt = new Int8Array(out);
    if (R <= 0 || T <= 1 || !out) return { score, shiftAt };

    // Zero-mean, unit-norm patch
    const P = Float64Array.from(patch);
    let mean = 0;
    for (const v of P) mean += v;
    mean /= R * T;
    let norm = 0;
    for (let i = 0; i < P.length; i++) { P[i] -= mean; norm += P[i] * P[i]; }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < P.length; i++) P[i] /= norm;
    const n = R * T;

    // Overlap-save: block of L frames yields L − T + 1 offsets
    const L = nextPow2(Math.max(4 * T, 2048)), step = L - T + 1;
    const pRe: Float64Array[] = [], pIm: Float64Array[] = [];
    for (let r = 0; r < R; r++) {
        const re = new Float64Array(L), im = new Float64Array(L);
        re.set(P.subarray(r * T, (r + 1) * T));
        fft(re, im);
        pRe.push(re); pIm.push(im);
    }
    const shifts: number[] = [];
    for (let d = -shift; d <= shift; d++) if (r0 + d >= 0 && r1 + d <= spec.rows) shifts.push(d);
    if (!shifts.length) return { score, shiftAt };
    const accRe = shifts.map(() => new Float64Array(L)), accIm = shifts.map(() => new Float64Array(L));
    const xRe = new Float64Array(L), xIm = new Float64Array(L);
    const lo = r0 + Math.min(...shifts), hi = r1 + Math.max(...shifts);

    // Per shift: sum and sum of squares of each frame over the shifted band rows
    const colSum = shifts.map(() => new Float64Array(N)), colSq = shifts.map(() => new Float64Array(N));
    shifts.forEach((d, k) => {
        for (let r = r0 + d; r < r1 + d; r++) {
            const row = r * N, cs = colSum[k], cq = colSq[k];
            for (let j = 0; j < N; j++) { const v = X[row + j]; cs[j] += v; cq[j] += v * v; }
        }
    });

    for (let s = 0; s < out; s += step) {
        for (const a of accRe) a.fill(0);
        for (const a of accIm) a.fill(0);
        for (let r = lo; r < hi; r++) {
            xRe.fill(0); xIm.fill(0);
            const row = r * N, len = Math.min(L, N - s);
            for (let j = 0; j < len; j++) xRe[j] = X[row + s + j];
            fft(xRe, xIm);
            shifts.forEach((d, k) => {
                const p = r - r0 - d;
                if (p < 0 || p >= R) return;
                const ar = accRe[k], ai = accIm[k], pr = pRe[p], pi = pIm[p];
                // X · conj(P) → correlation
                for (let j = 0; j < L; j++) {
                    ar[j] += xRe[j] * pr[j] + xIm[j] * pi[j];
                    ai[j] += xIm[j] * pr[j] - xRe[j] * pi[j];
                }
            });
        }
        shifts.forEach((d, k) => {
            fft(accRe[k], accIm[k], true);
            const cs = colSum[k], cq = colSq[k];
            // Window sums of the first offset in this block, then slide
            let sum = 0, sq = 0;
            for (let t = 0; t < T; t++) { sum += cs[s + t]; sq += cq[s + t]; }
            for (let j = 0; j < step && s + j < out; j++) {
                if (j) { sum += cs[s + j + T - 1] - cs[s + j - 1]; sq += cq[s + j + T - 1] - cq[s + j - 1]; }
                const v = Math.sqrt(Math.max(sq - sum * sum / n, 1e-9));
                const c = accRe[k][j] / v;
                if (c > score[s + j]) { score[s + j] = c; shiftAt[s + j] = d; }
            }
        });
    }
    return { score, shiftAt };
}

/** Local maxima, best first, at least `gap` frames apart (greedy non-maximum suppression). */
export function pickPeaks(score: Float32Array, gap: number, minScore: number, max: number): number[] {
    const cand: number[] = [];
    for (let i = 0; i < score.length; i++) {
        const v = score[i];
        if (v >= minScore && (i === 0 || v >= score[i - 1]) && (i === score.length - 1 || v > score[i + 1])) cand.push(i);
    }
    cand.sort((a, b) => score[b] - score[a]);
    const kept: number[] = [];
    for (const i of cand) {
        if (kept.length >= max) break;
        if (kept.every((k) => Math.abs(k - i) >= gap)) kept.push(i);
    }
    return kept;
}

const tOverlap = (a: Box, b: Box) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
/** Time IoU of two boxes. */
export function timeIoU(a: Box, b: Box): number {
    const u = Math.max(a.end, b.end) - Math.min(a.start, b.start);
    return u > 0 ? tOverlap(a, b) / u : 0;
}

/** Repeats of `exemplar` in `spec`, best first; the exemplar itself is left out. */
/** Rows and frames of the exemplar's patch in `spec` (band plus margin). */
export function exemplarWindow(spec: BandSpectrogram, exemplar: Box, opts: FindOptions = {}) {
    const { shift = 2, margin = 3 } = opts;
    const row = (hz: number) => Math.round((hz - spec.f0) / spec.df);
    const col = (s: number) => Math.round((s - spec.t0) / spec.dt);
    return {
        r0: Math.max(shift, row(exemplar.freqMin) - margin),
        r1: Math.min(spec.rows - shift, row(exemplar.freqMax) + margin + 1),
        c0: Math.max(0, col(exemplar.start)), c1: Math.min(spec.frames, col(exemplar.end)),
    };
}

export function findSimilar(spec: BandSpectrogram, exemplar: Box, opts: FindOptions = {}): SimilarHit[] {
    const { shift = 2, minScore = 0.2, max = 200, minGap = 0.6 } = opts;
    const { r0, r1, c0, c1 } = exemplarWindow(spec, exemplar, opts);
    if (r1 - r0 < 1 || c1 - c0 < 2) return [];
    const { score, shiftAt } = nccCurve(spec, r0, r1, c0, c1, shift);
    const T = c1 - c0, dur = T * spec.dt;
    // Hits overlapping the exemplar itself don't count against the max
    const peaks = pickPeaks(score, Math.max(1, Math.round(minGap * T)), minScore, max + 3);
    const hits: SimilarHit[] = [];
    for (const i of peaks) {
        const start = spec.t0 + i * spec.dt, df = shiftAt[i] * spec.df;
        const hit = { start, end: start + dur, freqMin: Math.max(0, exemplar.freqMin + df), freqMax: exemplar.freqMax + df,
            score: score[i], frame: i, shift: shiftAt[i] };
        if (timeIoU(hit, exemplar) >= 0.3) continue;
        hits.push(hit);
        if (hits.length >= max) break;
    }
    return hits;
}

// ── Re-ranking with the user's decisions ──────────────────────────
// Each accepted suggestion becomes another exemplar, each rejected one a counter-example:
//   rank = max(similarity to exemplar and accepted) − λ · max(0, similarity to rejected)
// Similarity of two hits = Pearson r of their patches, best over ±1 row / ±2 frames.
// Simulated review on Powdermill (scripts/similar/rerank-sim.py, 87 exemplars): calls found
// in the first 20 reviewed 10.1 → 11.3 (λ = 1), first 10: 6.4 → 7.2.

const PAD_ROWS = 1, PAD_FRAMES = 2;

/** Pearson r of `core` (R × T) against every placement inside `area` ((R+2a) × (T+2b)); best. */
function bestPearson(area: Float32Array, aRows: number, aCols: number, core: Float32Array, R: number, T: number): number {
    let best = -1;
    for (let dr = 0; dr + R <= aRows; dr++) {
        for (let dc = 0; dc + T <= aCols; dc++) {
            let sx = 0, sxx = 0, sxy = 0;
            for (let r = 0; r < R; r++) {
                const a = (dr + r) * aCols + dc, k = r * T;
                for (let t = 0; t < T; t++) { const x = area[a + t]; sx += x; sxx += x * x; sxy += x * core[k + t]; }
            }
            const n = R * T, v = sxx - sx * sx / n;
            if (v > 1e-9) { const c = sxy / Math.sqrt(v); if (c > best) best = c; }
        }
    }
    return best;
}

export class Reranker {
    private readonly R: number;
    private readonly T: number;
    private readonly areas = new Map<number, Float32Array>();
    private readonly cores = new Map<number, Float32Array>();
    private readonly pos: Float64Array;
    private readonly neg: Float64Array;
    private readonly open: Set<number>;

    constructor(private readonly spec: BandSpectrogram, private readonly win: { r0: number; r1: number; c0: number; c1: number },
        private readonly hits: SimilarHit[], private readonly lambda = 1) {
        this.R = win.r1 - win.r0; this.T = win.c1 - win.c0;
        this.hits = hits.slice();   // move() replaces entries; the caller's list stays as found
        this.pos = Float64Array.from(hits, (h) => h.score);
        this.neg = new Float64Array(hits.length).fill(-Infinity);
        this.open = new Set(hits.map((_, i) => i));
    }

    /** Hit i's patch with ±PAD margins (rows clamped to the spectrogram, frames to the recording). */
    private area(i: number): Float32Array {
        let a = this.areas.get(i);
        if (a) return a;
        const { spec, R, T } = this, h = this.hits[i];
        const rows = R + 2 * PAD_ROWS, cols = T + 2 * PAD_FRAMES;
        a = new Float32Array(rows * cols);
        const r0 = this.win.r0 + (h.shift ?? 0) - PAD_ROWS, c0 = (h.frame ?? 0) - PAD_FRAMES;
        for (let r = 0; r < rows; r++) {
            const rr = Math.min(spec.rows - 1, Math.max(0, r0 + r));
            for (let c = 0; c < cols; c++) a[r * cols + c] = spec.values[rr * spec.frames + Math.min(spec.frames - 1, Math.max(0, c0 + c))];
        }
        this.areas.set(i, a);
        return a;
    }

    /** Hit i's patch without margins, zero mean, unit norm. */
    private core(i: number): Float32Array {
        let k = this.cores.get(i);
        if (k) return k;
        const { R, T } = this, cols = T + 2 * PAD_FRAMES, a = this.area(i);
        k = new Float32Array(R * T);
        let m = 0;
        for (let r = 0; r < R; r++) for (let t = 0; t < T; t++) m += k[r * T + t] = a[(r + PAD_ROWS) * cols + t + PAD_FRAMES];
        m /= R * T;
        let nn = 0;
        for (let j = 0; j < k.length; j++) { k[j] -= m; nn += k[j] * k[j]; }
        nn = Math.sqrt(nn) || 1;
        for (let j = 0; j < k.length; j++) k[j] /= nn;
        this.cores.set(i, k);
        return k;
    }

    private move(i: number, { dt, df }: { dt: number; df: number }) {
        const h = this.hits[i], spec = this.spec;
        const frames = Number.isFinite(dt) ? Math.round(dt / spec.dt) : 0, rows = Number.isFinite(df) ? Math.round(df / spec.df) : 0;
        if (!frames && !rows) return;
        this.hits[i] = {
            ...h,
            frame: Math.max(0, Math.min(spec.frames - this.T, (h.frame ?? 0) + frames)),
            shift: Math.max(-this.win.r0, Math.min(spec.rows - this.win.r1, (h.shift ?? 0) + rows)),
        };
        this.areas.delete(i);
        this.cores.delete(i);
    }

    similarity(i: number, j: number): number {
        return bestPearson(this.area(j), this.R + 2 * PAD_ROWS, this.T + 2 * PAD_FRAMES, this.core(i), this.R, this.T);
    }

    /**
     * Record a decision on hit i; returns the rank of every hit (decided ones: −Infinity).
     * `moved`: the user corrected the box before deciding; its centre moved by `dt` seconds and
     * `df` Hz, so hit i's patch is taken from there (the patch keeps the exemplar's size).
     */
    decide(i: number, accepted: boolean, moved?: { dt: number; df: number }): Float64Array {
        if (moved && this.open.has(i)) this.move(i, moved);
        if (this.open.delete(i)) {
            for (const j of this.open) {
                const v = this.similarity(i, j);
                if (accepted) { if (v > this.pos[j]) this.pos[j] = v; } else if (v > this.neg[j]) this.neg[j] = v;
            }
        }
        return this.ranks();
    }

    ranks(): Float64Array {
        const out = new Float64Array(this.hits.length).fill(-Infinity);
        for (const j of this.open) out[j] = this.pos[j] - this.lambda * Math.max(0, this.neg[j]);
        return out;
    }
}

export interface SearchState { hits: SimilarHit[]; reranker: Reranker }

/** findSimilar plus a Reranker over its hits. */
/** findSimilar (exemplar in this recording) or findWithTemplate (from another) plus a Reranker over the hits. */
export function createSearch(spec: BandSpectrogram, exemplar: Box | { template: CallTemplate }, opts: FindOptions & { lambda?: number } = {}): SearchState {
    if ('template' in exemplar) {
        const { hits, win } = findWithTemplate(spec, exemplar.template, opts);
        return { hits, reranker: new Reranker(spec, win, hits, opts.lambda ?? 1) };
    }
    const hits = findSimilar(spec, exemplar, opts);
    return { hits, reranker: new Reranker(spec, exemplarWindow(spec, exemplar, opts), hits, opts.lambda ?? 1) };
}

// ── Templates: search another recording with a label's patch ───────
// The exemplar's patch (its band plus margin, dB above the floor) travels with its geometry; a target
// recording with another sample rate or STFT grid gets it resampled onto its own rows and frames.

export interface CallTemplate {
    values: Float32Array;   // rows × frames
    rows: number;
    frames: number;
    /** Frequency (Hz) of row 0 and row spacing, frame spacing (s). */
    f0: number; df: number; dt: number;
    /** The exemplar's box band (Hz), for the hit boxes. */
    freqMin: number; freqMax: number;
}

/** The exemplar's patch as a template (same window as findSimilar uses). */
export function templateFrom(spec: BandSpectrogram, exemplar: Box, opts: FindOptions = {}): CallTemplate | null {
    const { r0, r1, c0, c1 } = exemplarWindow(spec, exemplar, opts);
    const rows = r1 - r0, frames = c1 - c0;
    if (rows < 1 || frames < 2) return null;
    const values = new Float32Array(rows * frames);
    for (let r = 0; r < rows; r++) for (let t = 0; t < frames; t++) values[r * frames + t] = spec.values[(r0 + r) * spec.frames + c0 + t];
    return { values, rows, frames, f0: spec.f0 + r0 * spec.df, df: spec.df, dt: spec.dt, freqMin: exemplar.freqMin, freqMax: exemplar.freqMax };
}

/** `t` on the grid of `spec` (bilinear), with the row of `spec` its first row lands on. */
export function fitTemplate(t: CallTemplate, spec: BandSpectrogram): { patch: Float32Array; R: number; T: number; r0: number } {
    const r0 = Math.round((t.f0 - spec.f0) / spec.df);
    const R = Math.max(1, Math.round(((t.rows - 1) * t.df) / spec.df) + 1);
    const T = Math.max(2, Math.round(((t.frames - 1) * t.dt) / spec.dt) + 1);
    if (R === t.rows && T === t.frames) return { patch: t.values, R, T, r0 };
    const patch = new Float32Array(R * T);
    const at = (r: number, c: number) => t.values[Math.min(t.rows - 1, r) * t.frames + Math.min(t.frames - 1, c)];
    for (let i = 0; i < R; i++) {
        const y = R > 1 ? (i * (t.rows - 1)) / (R - 1) : 0, y0 = Math.floor(y), fy = y - y0;
        for (let j = 0; j < T; j++) {
            const x = T > 1 ? (j * (t.frames - 1)) / (T - 1) : 0, x0 = Math.floor(x), fx = x - x0;
            patch[i * T + j] = (1 - fy) * ((1 - fx) * at(y0, x0) + fx * at(y0, x0 + 1)) + fy * ((1 - fx) * at(y0 + 1, x0) + fx * at(y0 + 1, x0 + 1));
        }
    }
    return { patch, R, T, r0 };
}

/** Repeats of a template (from this or another recording) in `spec`, best first. */
export function findWithTemplate(spec: BandSpectrogram, t: CallTemplate, opts: FindOptions = {}): { hits: SimilarHit[]; win: { r0: number; r1: number; c0: number; c1: number } } {
    const { shift = 2, minScore = 0.2, max = 200, minGap = 0.6 } = opts;
    const fit = fitTemplate(t, spec);
    const r0 = fit.r0, win = { r0, r1: r0 + fit.R, c0: 0, c1: fit.T };
    // correlate() tries only the shifts that fit; return early only when none does
    if (r0 + shift < 0 || r0 - shift + fit.R > spec.rows || fit.R > spec.rows) return { hits: [], win };
    const { score, shiftAt } = correlate(spec, fit.patch, fit.R, fit.T, r0, shift);
    const dur = fit.T * spec.dt;
    const hits = pickPeaks(score, Math.max(1, Math.round(minGap * fit.T)), minScore, max).map((i) => {
        const start = spec.t0 + i * spec.dt, df = shiftAt[i] * spec.df;
        return { start, end: start + dur, freqMin: Math.max(0, t.freqMin + df), freqMax: t.freqMax + df, score: score[i], frame: i, shift: shiftAt[i] };
    });
    return { hits, win };
}
