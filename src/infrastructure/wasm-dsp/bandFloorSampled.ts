import { bandFloor } from './pkg/aw_dsp_wasm.js';

/** Frames aw_dsp::v2::display_stats samples for the band floor. */
const BAND_FLOOR_FRAMES = 4000;

/**
 * bandFloor on the frames it actually reads, so only those are copied into
 * WebAssembly memory (which never shrinks) instead of the whole spectrogram.
 */
export function bandFloorSampled(values: Float32Array, bins: number): Float32Array {
    const frames = Math.floor(values.length / bins);
    const stride = Math.max(1, Math.floor(frames / BAND_FLOOR_FRAMES));
    if (stride === 1) return bandFloor(values, bins);
    const n = Math.ceil(frames / stride);
    const picked = new Float32Array(n * bins);
    for (let i = 0; i < n; i++) picked.set(values.subarray(i * stride * bins, (i * stride + 1) * bins), i * bins);
    return bandFloor(picked, bins);
}
