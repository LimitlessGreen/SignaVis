import { pumpSamples } from '../shared/pumpSamples.ts';
// Min/max and sum of squares per block of samples, built once per channel: a fine
// level (32) for medium zoom, a coarse one (1024, from the fine one) for zoomed-out
// views of long recordings. Drawing, RMS and peak levels then touch a fraction of
// the samples.

export const PEAK_BLOCK_FINE = 32;
export const PEAK_BLOCK = 1024;

/** `sq`: sum of squared samples per block (NaN samples skipped), for RMS. */
export type Peaks = { block: number; min: Float32Array; max: Float32Array; sq: Float32Array };
export type ChannelPeaks = { fine: Peaks; coarse: Peaks };

const cache = new WeakMap<Float32Array, ChannelPeaks>();

/** Reduce blocks [b0, b1) of `factor` values each into outMin/outMax/outSq (sums `sq`). */
function reduceRange(min: Float32Array, max: Float32Array, sq: Float32Array, factor: number, outMin: Float32Array, outMax: Float32Array, outSq: Float32Array, b0: number, b1: number): void {
    for (let b = b0; b < b1; b++) {
        let lo = Infinity, hi = -Infinity, acc = 0;
        const end = Math.min(min.length, (b + 1) * factor);
        for (let i = b * factor; i < end; i++) {
            if (min[i] < lo) lo = min[i];
            if (max[i] > hi) hi = max[i];
            acc += sq[i];
        }
        outMin[b] = lo; outMax[b] = hi; outSq[b] = acc;
    }
}

/**
 * Fine (PEAK_BLOCK_FINE) min/max/sum of squares of `piece`, which starts at a sample offset that
 * is a multiple of PEAK_BLOCK_FINE, into outMin/outMax/outSq starting at block b0. Shared with
 * the peaks worker.
 */
export function reduceFineInto(piece: Float32Array, outMin: Float32Array, outMax: Float32Array, outSq: Float32Array, b0: number): void {
    const n = Math.ceil(piece.length / PEAK_BLOCK_FINE);
    for (let b = 0; b < n; b++) {
        let lo = Infinity, hi = -Infinity, acc = 0;
        const end = Math.min(piece.length, (b + 1) * PEAK_BLOCK_FINE);
        for (let i = b * PEAK_BLOCK_FINE; i < end; i++) {
            const v = piece[i];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
            if (v === v) acc += v * v;
        }
        outMin[b0 + b] = lo; outMax[b0 + b] = hi; outSq[b0 + b] = acc;
    }
}

function finePeaks(data: Float32Array, b0: number, b1: number, out: Peaks): void {
    const s0 = b0 * PEAK_BLOCK_FINE;
    const s1 = Math.min(data.length, b1 * PEAK_BLOCK_FINE);
    if (s1 > s0) reduceFineInto(data.subarray(s0, s1), out.min, out.max, out.sq, b0);
}

function coarseFrom(fine: Peaks): Peaks {
    const factor = PEAK_BLOCK / PEAK_BLOCK_FINE;
    const n = Math.ceil(fine.min.length / factor);
    const out = { block: PEAK_BLOCK, min: new Float32Array(n), max: new Float32Array(n), sq: new Float32Array(n) };
    reduceRange(fine.min, fine.max, fine.sq, factor, out.min, out.max, out.sq, 0, n);
    return out;
}

export function channelPeaks(data: Float32Array): ChannelPeaks {
    let peaks = cache.get(data);
    if (peaks) return peaks;
    const nFine = Math.ceil(data.length / PEAK_BLOCK_FINE);
    const fine = { block: PEAK_BLOCK_FINE, min: new Float32Array(nFine), max: new Float32Array(nFine), sq: new Float32Array(nFine) };
    finePeaks(data, 0, nFine, fine);
    const coarse = coarseFrom(fine);
    peaks = { fine, coarse };
    cache.set(data, peaks);
    return peaks;
}

/**
 * channelPeaks() built in slices of `sliceBlocks` fine blocks, yielding to the event loop in
 * between (a 3 h recording takes seconds to scan). Fills the cache, so later synchronous
 * channelPeaks()/envelopeMinMax() calls are free.
 */
export async function channelPeaksAsync(
    data: Float32Array,
    sliceBlocks = 1 << 16,
    createWorker: (() => Worker) | null = defaultPeaksWorker,
): Promise<ChannelPeaks> {
    const cached = cache.get(data);
    if (cached) return cached;
    let fine: Peaks | null = null;
    if (createWorker && data.length >= WORKER_MIN_SAMPLES) {
        try {
            fine = await finePeaksInWorker(data, createWorker);
        } catch (err) {
            console.warn('[waveformEnvelope] peaks worker failed, building on the main thread', err);
        }
    }
    if (!fine) {
        const n = Math.ceil(data.length / PEAK_BLOCK_FINE);
        const out = { block: PEAK_BLOCK_FINE, min: new Float32Array(n), max: new Float32Array(n), sq: new Float32Array(n) };
        for (let b = 0; b < n; b += sliceBlocks) {
            finePeaks(data, b, Math.min(n, b + sliceBlocks), out);
            await new Promise<void>((r) => setTimeout(r, 0));
            // A synchronous caller may have built it meanwhile.
            const done = cache.get(data);
            if (done) return done;
        }
        fine = out;
    }
    // The coarse level reads all fine blocks (16M on 3 h): also in slices.
    const factor = PEAK_BLOCK / PEAK_BLOCK_FINE;
    const nCoarse = Math.ceil(fine.min.length / factor);
    const cMin = new Float32Array(nCoarse), cMax = new Float32Array(nCoarse), cSq = new Float32Array(nCoarse);
    const coarseSlice = Math.max(1, Math.floor(sliceBlocks / factor) * 32);
    for (let b = 0; b < nCoarse; b += coarseSlice) {
        if (b > 0) {
            await new Promise<void>((r) => setTimeout(r, 0));
            const done = cache.get(data);
            if (done) return done;
        }
        reduceRange(fine.min, fine.max, fine.sq, factor, cMin, cMax, cSq, b, Math.min(nCoarse, b + coarseSlice));
    }
    const done = cache.get(data);
    if (done) return done;
    const peaks = { fine, coarse: { block: PEAK_BLOCK, min: cMin, max: cMax, sq: cSq } };
    cache.set(data, peaks);
    return peaks;
}

/** Below this many samples the main thread builds the pyramid itself (a worker costs more). */
const WORKER_MIN_SAMPLES = 1 << 23;
/** Samples per piece sent to the worker (16 MB, a multiple of PEAK_BLOCK_FINE). */
const WORKER_PIECE = 1 << 22;

let workerCtor: (new () => Worker) | null | undefined;
function defaultPeaksWorker(): Worker {
    if (!workerCtor) throw new Error('peaks worker not loaded');
    return new workerCtor();
}
/** Load the inline worker once (Vite `?worker&inline`); without it the main thread is used. */
export async function loadPeaksWorker(): Promise<boolean> {
    if (workerCtor === undefined) {
        try { workerCtor = (await import('../infrastructure/waveformPeaks.worker.ts?worker&inline')).default; }
        catch { workerCtor = null; }
    }
    return !!workerCtor;
}

/** Fine level built in a worker; the main thread only copies pieces (see pumpSamples). */
async function finePeaksInWorker(data: Float32Array, createWorker: () => Worker): Promise<Peaks> {
    if (createWorker === defaultPeaksWorker && !(await loadPeaksWorker())) throw new Error('no worker');
    const worker = createWorker();
    const waiting: Array<{ resolve: (v: any) => void; reject: (e: Error) => void }> = [];
    worker.onmessage = (e: MessageEvent) => {
        const w = waiting.shift();
        if (e.data?.type === 'error') w?.reject(new Error(e.data.message)); else w?.resolve(e.data);
    };
    worker.onerror = (e) => { while (waiting.length) waiting.shift()!.reject(new Error(e.message || 'worker error')); };
    const ask = (msg: any, transfer: Transferable[] = []) => new Promise<any>((resolve, reject) => {
        waiting.push({ resolve, reject });
        worker.postMessage(msg, transfer);
    });
    try {
        await ask({ type: 'start', length: data.length });
        await pumpSamples(data, WORKER_PIECE, async (piece, offset) =>
            (await ask({ type: 'piece', data: piece.buffer, length: piece.length, offset }, [piece.buffer])).data);
        const r = await ask({ type: 'finish' });
        return { block: PEAK_BLOCK_FINE, min: r.min, max: r.max, sq: r.sq };
    } finally {
        worker.terminate();
    }
}

/**
 * Max |sample| in `n` bins, from the coarse level (bins hold whole coarse blocks; trailing bins
 * past the end are 0). For overview peaks where exact bin edges do not matter.
 */
export function maxAbsPeaks(data: Float32Array, n: number): Float32Array {
    const { coarse } = channelPeaks(data);
    const per = Math.max(1, Math.ceil(coarse.min.length / n));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        let m = 0;
        const end = Math.min(coarse.min.length, (i + 1) * per);
        for (let j = i * per; j < end; j++) {
            const v = Math.max(-coarse.min[j], coarse.max[j]);
            if (v > m) m = v;
        }
        out[i] = m;
    }
    return out;
}

/** [min, max] of data[start, end), NaN ignored; [Infinity, -Infinity] if empty. */
export function envelopeMinMax(data: Float32Array, start: number, end: number): [number, number] {
    let lo = Infinity, hi = -Infinity;
    const take = (min: Float32Array, max: Float32Array, a: number, b: number) => {
        for (let i = a; i < b; i++) {
            if (min[i] < lo) lo = min[i];
            if (max[i] > hi) hi = max[i];
        }
    };
    // Samples to the fine boundaries, fine blocks to the coarse boundaries, coarse blocks between.
    const f0 = Math.ceil(start / PEAK_BLOCK_FINE), f1 = Math.floor(end / PEAK_BLOCK_FINE);
    if (f1 - f0 < 2) { take(data, data, start, end); return [lo, hi]; }
    const { fine, coarse } = channelPeaks(data);
    const r = PEAK_BLOCK / PEAK_BLOCK_FINE;
    const c0 = Math.ceil(f0 / r), c1 = Math.floor(f1 / r);
    take(data, data, start, f0 * PEAK_BLOCK_FINE);
    if (c1 > c0) {
        take(fine.min, fine.max, f0, c0 * r);
        take(coarse.min, coarse.max, c0, c1);
        take(fine.min, fine.max, c1 * r, f1);
    } else {
        take(fine.min, fine.max, f0, f1);
    }
    take(data, data, f1 * PEAK_BLOCK_FINE, end);
    return [lo, hi];
}

/**
 * Min, max and RMS of data[start, end) from the same levels as envelopeMinMax (NaN ignored in
 * min/max, counted as 0 in the RMS). Empty range: lo = Infinity, hi = -Infinity, rms = 0.
 */
export function envelopeStats(data: Float32Array, start: number, end: number): { lo: number; hi: number; rms: number } {
    let lo = Infinity, hi = -Infinity, acc = 0;
    const samples = (a: number, b: number) => {
        for (let i = a; i < b; i++) {
            const v = data[i];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
            if (v === v) acc += v * v;
        }
    };
    const blocks = (p: Peaks, a: number, b: number) => {
        for (let i = a; i < b; i++) {
            if (p.min[i] < lo) lo = p.min[i];
            if (p.max[i] > hi) hi = p.max[i];
            acc += p.sq[i];
        }
    };
    const n = Math.max(0, end - start);
    const f0 = Math.ceil(start / PEAK_BLOCK_FINE), f1 = Math.floor(end / PEAK_BLOCK_FINE);
    if (f1 - f0 < 2) {
        samples(start, end);
    } else {
        const { fine, coarse } = channelPeaks(data);
        const r = PEAK_BLOCK / PEAK_BLOCK_FINE;
        const c0 = Math.ceil(f0 / r), c1 = Math.floor(f1 / r);
        samples(start, f0 * PEAK_BLOCK_FINE);
        if (c1 > c0) {
            blocks(fine, f0, c0 * r);
            blocks(coarse, c0, c1);
            blocks(fine, c1 * r, f1);
        } else {
            blocks(fine, f0, f1);
        }
        samples(f1 * PEAK_BLOCK_FINE, end);
    }
    return { lo, hi, rms: n > 0 ? Math.sqrt(Math.max(0, acc) / n) : 0 };
}

/** Largest |sample| (at least 1e-6), like computeAmplitudePeak. */
export function envelopePeakAbs(data: Float32Array): number {
    const [lo, hi] = envelopeMinMax(data, 0, data.length);
    const peak = Math.max(Number.isFinite(lo) ? -lo : 0, Number.isFinite(hi) ? hi : 0, 0);
    return Math.max(1e-6, peak);
}
