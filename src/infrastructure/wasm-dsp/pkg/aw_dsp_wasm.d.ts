/* tslint:disable */
/* eslint-disable */

export class WasmPyramidBuilderV2 {
    free(): void;
    [Symbol.dispose](): void;
    finish(): string;
    nLevels(): number;
    constructor(params_json: string, n_samples: number);
    pushBlock(block: Float32Array): void;
    takeLevel(level: number): Uint8Array;
}

export class WasmStft {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Centre frequency (Hz) per output row, low → high.
     */
    binFrequencies(): Float64Array;
    /**
     * [lo, hi) frames to compute for output frames [f0, f0 + n).
     */
    blockFrameRange(f0: number, n: number, total: number): Float64Array;
    /**
     * Finalized values for frames [f0, f0 + n), independent of other blocks.
     */
    blockValues(samples: Float32Array, first: number, f0: number, n: number, total: number): Float32Array;
    nFrames(n_samples: number): number;
    constructor(params_json: string);
    outBins(): number;
    /**
     * [start, len] samples for frames [lo, lo + n); start may be negative.
     */
    sampleRange(lo: number, n: number): Float64Array;
}

/**
 * Per-band noise floor (median per row) of row-major [frame][bin] values.
 */
export function bandFloor(values: Float32Array, bins: number): Float32Array;

/**
 * CLAHE in place on a [0, 1] image (see aw_dsp::display::clahe).
 */
export function clahe(gray: Float32Array, width: number, height: number, tiles_x: number, tiles_y: number, clip_limit: number): void;

export function decodeF16(bytes: Uint8Array): Float32Array;

/**
 * Integer decimation from `sample_rate` to `detectorOutputRate`.
 */
export function detectorDecimation(sample_rate: number): number;

/**
 * Sample rate of the heterodyne / frequency-division output (≈ 48 kHz).
 */
export function detectorOutputRate(sample_rate: number): number;

/**
 * Background level for frequencyDivision (see aw_dsp::detector::division_noise_level).
 */
export function divisionNoiseLevel(samples: Float32Array, sample_rate: number, highpass_hz: number): number;

/**
 * Frequency-division detector output (see aw_dsp::detector::frequency_division).
 */
export function frequencyDivision(samples: Float32Array, sample_rate: number, divisor: number, highpass_hz: number, noise_level: number, keep_envelope: boolean): Float32Array;

/**
 * Heterodyne detector output (see aw_dsp::detector::heterodyne).
 */
export function heterodyne(samples: Float32Array, sample_rate: number, first_sample: number, carrier_hz: number, bandwidth_hz: number): Float32Array;

/**
 * Convert interleaved PCM bytes to mono f32, channel 0 only
 * (matches AudioBuffer.getChannelData(0) in the JS path).
 */
export function wavChannel0(bytes: Uint8Array, channels: number, bits: number, float: boolean): Float32Array;

/**
 * Parse a WAV header from the first bytes of a file (64 KiB is plenty).
 * Returns JSON { sampleRate, channels, bitsPerSample, float, dataOffset, nSamples }.
 */
export function wavInfo(head: Uint8Array): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmpyramidbuilderv2_free: (a: number, b: number) => void;
    readonly __wbg_wasmstft_free: (a: number, b: number) => void;
    readonly bandFloor: (a: number, b: number, c: number) => [number, number];
    readonly clahe: (a: number, b: number, c: any, d: number, e: number, f: number, g: number, h: number) => void;
    readonly decodeF16: (a: number, b: number) => [number, number];
    readonly detectorDecimation: (a: number) => number;
    readonly detectorOutputRate: (a: number) => number;
    readonly divisionNoiseLevel: (a: number, b: number, c: number, d: number) => number;
    readonly frequencyDivision: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly heterodyne: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly wasmpyramidbuilderv2_finish: (a: number) => [number, number, number, number];
    readonly wasmpyramidbuilderv2_nLevels: (a: number) => number;
    readonly wasmpyramidbuilderv2_new: (a: number, b: number, c: number) => [number, number, number];
    readonly wasmpyramidbuilderv2_pushBlock: (a: number, b: number, c: number) => [number, number];
    readonly wasmpyramidbuilderv2_takeLevel: (a: number, b: number) => [number, number];
    readonly wasmstft_binFrequencies: (a: number) => [number, number];
    readonly wasmstft_blockFrameRange: (a: number, b: number, c: number, d: number) => [number, number];
    readonly wasmstft_blockValues: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly wasmstft_nFrames: (a: number, b: number) => number;
    readonly wasmstft_new: (a: number, b: number) => [number, number, number];
    readonly wasmstft_outBins: (a: number) => number;
    readonly wasmstft_sampleRange: (a: number, b: number, c: number) => [number, number];
    readonly wavChannel0: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly wavInfo: (a: number, b: number) => [number, number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
