export function computeAmplitudePeak(channelData: any): number;
export function updateSpectrogramStats(spectrogramData: any): {
    logMin: number;
    logMax: number;
};
/**
 * Computes tighter logMin/logMax from the PCEN data using percentiles,
 * cutting away noise-floor and rare hot-spots for better visual contrast.
 * @param {Float32Array} spectrogramData  - flat PCEN output (nFrames × nMels)
 * @param {number} [loPercentile=2]       - lower percentile (black point)
 * @param {number} [hiPercentile=98]      - upper percentile (white point)
 */
export function autoContrastStats(spectrogramData: Float32Array, loPercentile?: number, hiPercentile?: number): {
    logMin: number;
    logMax: number;
};
/**
 * Detects the effective upper frequency boundary by finding the highest
 * mel-bin that carries meaningful energy above the noise floor.
 * Returns a frequency in Hz suitable as maxFreq.
 * @param {Float32Array} spectrogramData
 * @param {number} nFrames
 * @param {number} nMels
 * @param {number} sampleRate
 * @param {number} [energyThreshold=0.08] – fraction of peak-bin energy
 */
export function detectMaxFrequency(spectrogramData: Float32Array, nFrames: number, nMels: number, sampleRate: number, energyThreshold?: number): number;
/**
 * Stage 1 — Expensive, done ONCE per audio / fftSize / maxFreq change.
 * Converts PCEN data → 8-bit grayscale image (Uint8Array) using the
 * absolute log-range.  Frame-averaging and mel→y mapping happens here.
 */
export function buildSpectrogramGrayscale({ spectrogramData, spectrogramFrames, spectrogramMels, sampleRateHz, maxFreq, spectrogramAbsLogMin, spectrogramAbsLogMax, spectrogramMode, }: {
    spectrogramData: any;
    spectrogramFrames: any;
    spectrogramMels: any;
    sampleRateHz: any;
    maxFreq: any;
    spectrogramAbsLogMin: any;
    spectrogramAbsLogMax: any;
    spectrogramMode: any;
}): {
    gray: Uint8Array<ArrayBuffer>;
    width: number;
    height: number;
};
/**
 * Stage 2 — Cheap JS fallback, called on every floor/ceil/colorScheme change.
 * Builds a 256-entry RGBA look-up table, then paints the grayscale map.
 */
export function colorizeSpectrogram(grayInfo: any, floor01: any, ceil01: any, colorScheme: any): HTMLCanvasElement;
/** Legacy wrapper — builds both stages in one call. */
export function buildSpectrogramBaseImage({ spectrogramData, spectrogramFrames, spectrogramMels, sampleRateHz, maxFreq, currentColorScheme, normalizeViews, spectrogramLogMin, spectrogramLogMax, }: {
    spectrogramData: any;
    spectrogramFrames: any;
    spectrogramMels: any;
    sampleRateHz: any;
    maxFreq: any;
    currentColorScheme: any;
    normalizeViews: any;
    spectrogramLogMin: any;
    spectrogramLogMax: any;
}): HTMLCanvasElement;
export function renderSpectrogram({ duration, spectrogramCanvas, pixelsPerSecond, canvasHeight, baseCanvas, sampleRate, frameRate, spectrogramFrames, }: {
    duration: any;
    spectrogramCanvas: any;
    pixelsPerSecond: any;
    canvasHeight: any;
    baseCanvas: any;
    sampleRate: any;
    frameRate: any;
    spectrogramFrames: any;
}): void;
export function sha256ArrayBuffer(arrayBuffer: any): Promise<string>;
export function buildSpectrogramCacheKey({ fileHash, fftSize, sampleRate, frameRate, nMels, pcenGain, pcenBias, pcenRoot, pcenSmoothing, spectrogramMode, }: {
    fileHash: any;
    fftSize: any;
    sampleRate: any;
    frameRate: any;
    nMels: any;
    pcenGain: any;
    pcenBias: any;
    pcenRoot: any;
    pcenSmoothing: any;
    spectrogramMode: any;
}): string;
export function getSpectrogramCacheEntry(cacheKey: any): Promise<any>;
export function putSpectrogramCacheEntry(entry: any): Promise<boolean>;
export function createSpectrogramProcessor(): {
    compute: (channelData: any, options: any) => Promise<any>;
    computeProgressive: (channelData: any, options: any) => AsyncGenerator<{
        chunk: number;
        totalChunks: number;
        percent: number;
        result: any;
    }, void, unknown>;
    dispose: () => void;
};
export class GpuColorizer {
    _canvas: HTMLCanvasElement;
    _gl: WebGL2RenderingContext;
    _maxTex: any;
    _prog: WebGLProgram;
    _uFloor: WebGLUniformLocation;
    _uRcpRange: WebGLUniformLocation;
    _uGray: WebGLUniformLocation;
    _uLut: WebGLUniformLocation;
    _vao: WebGLVertexArrayObject;
    _grayTex: WebGLTexture;
    _lutTex: WebGLTexture;
    _w: number;
    _h: number;
    _lutScheme: any;
    /** @private */ private _sh;
    get ok(): boolean;
    get canvas(): HTMLCanvasElement;
    /** Upload 8-bit grayscale map as a RED channel texture. Returns success. */
    uploadGrayscale(gray: any, width: any, height: any): boolean;
    /** Build 256-entry RGBA color look-up texture from a color scheme. */
    uploadColorLut(scheme: any): void;
    /** Render colorized spectrogram. floor01/ceil01 ∈ [0,1]. ~0.1 ms. */
    render(floor01: any, ceil01: any): void;
    dispose(): void;
}
