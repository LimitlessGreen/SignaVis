// domain/similar/cluster.ts — group a recording's calls for the overview (label whole groups)
//
// Each call box becomes a fixed-size patch (its band and duration resampled to ROWS × COLS,
// zero mean, unit norm). Distance between two calls:
//   1 − Pearson r of the patches + W_DUR · |Δ log duration| + W_FREQ · |Δ log centre frequency|
// Average-linkage clustering (nearest-neighbour chain, O(n²)), cut at `cut`.
// Measured on Powdermill (scripts/similar/cluster-sim.py CLIP=0, plans/similar-calls-plan.md): at cut 1.0,
// labelling whole groups and fixing strays costs 0.43 of labelling each BirdBox box (0.27 with
// perfect boxes), groups 84 % pure; at cut 0.8: 0.58, 95 % pure.

export const ROWS = 16, COLS = 24;
export const W_DUR = 0.3, W_FREQ = 1.0;
export const DEFAULT_CUT = 1.0;

export interface CallPatch {
    /** dB above the floor, rows × cols, row-major (row 0 = lowest frequency). */
    values: Float32Array;
    rows: number;
    cols: number;
    duration: number;       // s
    centreHz: number;
}

export interface CallFeature { v: Float32Array; logDur: number; logFreq: number }

/**
 * Bilinear resample to ROWS × COLS, then zero mean and unit norm. Cells below the floor count as 0 dB,
 * so background noise weighs less (Powdermill: same effort at the default cut, purer at finer cuts).
 */
export function callFeature(p: CallPatch): CallFeature {
    const v = new Float32Array(ROWS * COLS);
    const sample = (r: number, c: number) => Math.max(0, p.values[Math.min(p.rows - 1, r) * p.cols + Math.min(p.cols - 1, c)]);
    for (let i = 0; i < ROWS; i++) {
        const y = p.rows > 1 ? (i * (p.rows - 1)) / (ROWS - 1) : 0, y0 = Math.floor(y), fy = y - y0;
        for (let j = 0; j < COLS; j++) {
            const x = p.cols > 1 ? (j * (p.cols - 1)) / (COLS - 1) : 0, x0 = Math.floor(x), fx = x - x0;
            v[i * COLS + j] = (1 - fy) * ((1 - fx) * sample(y0, x0) + fx * sample(y0, x0 + 1))
                + fy * ((1 - fx) * sample(y0 + 1, x0) + fx * sample(y0 + 1, x0 + 1));
        }
    }
    let m = 0;
    for (const x of v) m += x;
    m /= v.length;
    let n = 0;
    for (let i = 0; i < v.length; i++) { v[i] -= m; n += v[i] * v[i]; }
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= n;
    return { v, logDur: Math.log(Math.max(1e-3, p.duration)), logFreq: Math.log(Math.max(50, p.centreHz)) };
}

export function pearson(a: CallFeature, b: CallFeature): number {
    let s = 0;
    for (let i = 0; i < a.v.length; i++) s += a.v[i] * b.v[i];
    return s;
}

export function callDistance(a: CallFeature, b: CallFeature): number {
    return Math.max(0, 1 - pearson(a, b) + W_DUR * Math.abs(a.logDur - b.logDur) + W_FREQ * Math.abs(a.logFreq - b.logFreq));
}

/**
 * Average-linkage clustering of n items with distance d(i, j), cut at `cut` (like scipy fcluster 'distance').
 * Returns a cluster index per item. Nearest-neighbour chain builds the full dendrogram in O(n²);
 * average linkage has no inversions, so applying exactly the merges at height ≤ cut gives the cut.
 */
export function averageLinkage(n: number, d: (i: number, j: number) => number, cut: number): Int32Array {
    const D = new Float64Array(n * n);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) D[i * n + j] = D[j * n + i] = d(i, j);
    const size = new Int32Array(n).fill(1);
    const active = new Uint8Array(n).fill(1);
    const merges: [number, number, number][] = [];
    const chain: number[] = [];
    for (let left = n; left > 1;) {
        if (!chain.length) { let i = 0; while (!active[i]) i++; chain.push(i); }
        const a = chain[chain.length - 1];
        const prev = chain.length > 1 ? chain[chain.length - 2] : -1;
        let b = -1, best = Infinity;
        for (let j = 0; j < n; j++) {
            if (!active[j] || j === a) continue;
            const v = D[a * n + j];
            if (v < best || (v === best && j === prev)) { best = v; b = j; }
        }
        if (b !== prev) { chain.push(b); continue; }
        chain.pop(); chain.pop();
        merges.push([a, b, best]);
        // Merge b into a (Lance–Williams, average linkage)
        for (let k = 0; k < n; k++) {
            if (!active[k] || k === a || k === b) continue;
            D[a * n + k] = D[k * n + a] = (size[a] * D[a * n + k] + size[b] * D[b * n + k]) / (size[a] + size[b]);
        }
        size[a] += size[b];
        active[b] = 0;
        left--;
    }
    const parent = Int32Array.from({ length: n }, (_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (const [a, b, h] of merges) if (h <= cut) parent[find(b)] = find(a);
    const out = new Int32Array(n), ids = new Map<number, number>();
    for (let i = 0; i < n; i++) {
        const r = find(i);
        if (!ids.has(r)) ids.set(r, ids.size);
        out[i] = ids.get(r)!;
    }
    return out;
}

export interface CallGroup {
    /** Indices into the input, medoid first, then by similarity to it. */
    members: number[];
    /** Pearson r of each member's patch with the medoid's (same order). */
    scores: number[];
}

/** Groups of at least `minSize` calls, largest first. */
export function groupCalls(features: CallFeature[], { cut = DEFAULT_CUT, minSize = 2 } = {}): CallGroup[] {
    const lab = averageLinkage(features.length, (i, j) => callDistance(features[i], features[j]), cut);
    const byLab = new Map<number, number[]>();
    lab.forEach((l, i) => { if (!byLab.has(l)) byLab.set(l, []); byLab.get(l)!.push(i); });
    const groups: CallGroup[] = [];
    for (const idx of byLab.values()) {
        if (idx.length < minSize) continue;
        // Medoid: smallest summed distance to the others
        let med = idx[0], bestSum = Infinity;
        for (const i of idx) {
            let s = 0;
            for (const j of idx) if (i !== j) s += callDistance(features[i], features[j]);
            if (s < bestSum) { bestSum = s; med = i; }
        }
        const rest = idx.filter((i) => i !== med).map((i) => [i, pearson(features[med], features[i])] as const)
            .sort((x, y) => y[1] - x[1]);
        groups.push({ members: [med, ...rest.map((r) => r[0])], scores: [1, ...rest.map((r) => r[1])] });
    }
    return groups.sort((a, b) => b.members.length - a.members.length);
}
