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
export interface SimilarHit extends Box { score: number }

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
    const { values: X, frames: N } = spec;
    const R = r1 - r0, T = c1 - c0, out = Math.max(0, N - T + 1);
    const score = new Float32Array(out).fill(-1), shiftAt = new Int8Array(out);
    if (R <= 0 || T <= 1 || !out) return { score, shiftAt };

    // Zero-mean, unit-norm patch
    const P = new Float64Array(R * T);
    let mean = 0;
    for (let r = 0; r < R; r++) for (let t = 0; t < T; t++) mean += P[r * T + t] = X[(r0 + r) * N + c0 + t];
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
export function findSimilar(spec: BandSpectrogram, exemplar: Box, opts: FindOptions = {}): SimilarHit[] {
    const { shift = 2, margin = 3, minScore = 0.2, max = 200, minGap = 0.6 } = opts;
    const row = (hz: number) => Math.round((hz - spec.f0) / spec.df);
    const col = (s: number) => Math.round((s - spec.t0) / spec.dt);
    const r0 = Math.max(shift, row(exemplar.freqMin) - margin);
    const r1 = Math.min(spec.rows - shift, row(exemplar.freqMax) + margin + 1);
    const c0 = Math.max(0, col(exemplar.start)), c1 = Math.min(spec.frames, col(exemplar.end));
    if (r1 - r0 < 1 || c1 - c0 < 2) return [];
    const { score, shiftAt } = nccCurve(spec, r0, r1, c0, c1, shift);
    const T = c1 - c0, dur = T * spec.dt;
    // Hits overlapping the exemplar itself don't count against the max
    const peaks = pickPeaks(score, Math.max(1, Math.round(minGap * T)), minScore, max + 3);
    const hits: SimilarHit[] = [];
    for (const i of peaks) {
        const start = spec.t0 + i * spec.dt, df = shiftAt[i] * spec.df;
        const hit = { start, end: start + dur, freqMin: Math.max(0, exemplar.freqMin + df), freqMax: exemplar.freqMax + df, score: score[i] };
        if (timeIoU(hit, exemplar) >= 0.3) continue;
        hits.push(hit);
        if (hits.length >= max) break;
    }
    return hits;
}
