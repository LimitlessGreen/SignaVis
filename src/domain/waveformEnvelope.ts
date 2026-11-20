// Min/max per block of samples, computed once per channel, so drawing the
// waveform of a long recording does not scan every sample on every draw.

const BLOCK = 256;

interface Envelope { min: Float32Array; max: Float32Array }

const cache = new WeakMap<Float32Array, Envelope>();

function envelope(data: Float32Array): Envelope {
    let env = cache.get(data);
    if (env) return env;
    const n = Math.ceil(data.length / BLOCK);
    const min = new Float32Array(n).fill(Infinity), max = new Float32Array(n).fill(-Infinity);
    for (let b = 0; b < n; b++) {
        let lo = Infinity, hi = -Infinity;
        for (let i = b * BLOCK, e = Math.min(data.length, i + BLOCK); i < e; i++) {
            const v = data[i];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
        }
        min[b] = lo; max[b] = hi;
    }
    env = { min, max };
    cache.set(data, env);
    return env;
}

/** [min, max] of data[start, end), NaN ignored; [Infinity, -Infinity] if empty. */
export function envelopeMinMax(data: Float32Array, start: number, end: number): [number, number] {
    let lo = Infinity, hi = -Infinity;
    const scan = (a: number, b: number) => {
        for (let i = a; i < b; i++) {
            const v = data[i];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
        }
    };
    const b0 = Math.ceil(start / BLOCK), b1 = Math.floor(end / BLOCK);
    if (b1 - b0 < 2) { scan(start, end); return [lo, hi]; }
    const env = envelope(data);
    scan(start, b0 * BLOCK);
    for (let b = b0; b < b1; b++) {
        if (env.min[b] < lo) lo = env.min[b];
        if (env.max[b] > hi) hi = env.max[b];
    }
    scan(b1 * BLOCK, end);
    return [lo, hi];
}

/** Largest |sample| (at least 1e-6), like computeAmplitudePeak. */
export function envelopePeakAbs(data: Float32Array): number {
    const [lo, hi] = envelopeMinMax(data, 0, data.length);
    const peak = Math.max(Number.isFinite(lo) ? -lo : 0, Number.isFinite(hi) ? hi : 0, 0);
    return Math.max(1e-6, peak);
}
