// Min/max per block of samples, built once per channel: a fine level (32) for
// medium zoom, a coarse one (1024, from the fine one) for zoomed-out views of
// long recordings. Drawing and peak levels then touch a fraction of the samples.

export const PEAK_BLOCK_FINE = 32;
export const PEAK_BLOCK = 1024;

export type Peaks = { block: number; min: Float32Array; max: Float32Array };
export type ChannelPeaks = { fine: Peaks; coarse: Peaks };

const cache = new WeakMap<Float32Array, ChannelPeaks>();

/** Reduce blocks [b0, b1) of `factor` values each into outMin/outMax. */
function reduceRange(min: Float32Array, max: Float32Array, factor: number, outMin: Float32Array, outMax: Float32Array, b0: number, b1: number): void {
    for (let b = b0; b < b1; b++) {
        let lo = Infinity, hi = -Infinity;
        const end = Math.min(min.length, (b + 1) * factor);
        for (let i = b * factor; i < end; i++) {
            if (min[i] < lo) lo = min[i];
            if (max[i] > hi) hi = max[i];
        }
        outMin[b] = lo; outMax[b] = hi;
    }
}

function reducePeaks(min: Float32Array, max: Float32Array, factor: number, block: number): Peaks {
    const n = Math.ceil(min.length / factor);
    const outMin = new Float32Array(n);
    const outMax = new Float32Array(n);
    reduceRange(min, max, factor, outMin, outMax, 0, n);
    return { block, min: outMin, max: outMax };
}

export function channelPeaks(data: Float32Array): ChannelPeaks {
    let peaks = cache.get(data);
    if (peaks) return peaks;
    const fine = reducePeaks(data, data, PEAK_BLOCK_FINE, PEAK_BLOCK_FINE);
    const coarse = reducePeaks(fine.min, fine.max, PEAK_BLOCK / PEAK_BLOCK_FINE, PEAK_BLOCK);
    peaks = { fine, coarse };
    cache.set(data, peaks);
    return peaks;
}

/**
 * channelPeaks() built in slices of `sliceBlocks` fine blocks, yielding to the event loop in
 * between (a 3 h recording takes seconds to scan). Fills the cache, so later synchronous
 * channelPeaks()/envelopeMinMax() calls are free.
 */
export async function channelPeaksAsync(data: Float32Array, sliceBlocks = 1 << 16): Promise<ChannelPeaks> {
    const cached = cache.get(data);
    if (cached) return cached;
    const n = Math.ceil(data.length / PEAK_BLOCK_FINE);
    const min = new Float32Array(n), max = new Float32Array(n);
    for (let b = 0; b < n; b += sliceBlocks) {
        reduceRange(data, data, PEAK_BLOCK_FINE, min, max, b, Math.min(n, b + sliceBlocks));
        await new Promise<void>((r) => setTimeout(r, 0));
        // A synchronous caller may have built it meanwhile.
        const done = cache.get(data);
        if (done) return done;
    }
    const fine = { block: PEAK_BLOCK_FINE, min, max };
    const peaks = { fine, coarse: reducePeaks(min, max, PEAK_BLOCK / PEAK_BLOCK_FINE, PEAK_BLOCK) };
    cache.set(data, peaks);
    return peaks;
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

/** Largest |sample| (at least 1e-6), like computeAmplitudePeak. */
export function envelopePeakAbs(data: Float32Array): number {
    const [lo, hi] = envelopeMinMax(data, 0, data.length);
    const peak = Math.max(Number.isFinite(lo) ? -lo : 0, Number.isFinite(hi) ? hi : 0, 0);
    return Math.max(1e-6, peak);
}
