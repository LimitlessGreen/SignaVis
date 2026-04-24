// ═══════════════════════════════════════════════════════════════════════
// spectrogram.js - Spectrogram computation, coloring, and rendering
// ═══════════════════════════════════════════════════════════════════════

import { MAX_BASE_SPECTROGRAM_WIDTH } from '../shared/constants.ts';
import { clamp, getTimeGridSteps } from '../shared/utils.ts';
import { buildMelFrequencies, computeSpectrogram, iecDbToFader } from './dsp.ts';
import { CoordinateSystem, computeMaxBin } from './coordinateSystem.ts';

// Worker constructor - loaded lazily via Vite's ?worker&inline.
// Dynamic import so Node.js tests (no Vite) don't crash on this module.
let _WorkerCtor = null;
let _workerCtorResolved = false;
async function getWorkerCtor() {
    if (_workerCtorResolved) return _WorkerCtor;
    _workerCtorResolved = true;
    try {
        const mod = await import('../infrastructure/spectrogram.worker.js?worker&inline');
        _WorkerCtor = mod.default;
    } catch {
        _WorkerCtor = null;
    }
    return _WorkerCtor;
}

// ─── Signal Utilities ───────────────────────────────────────────────

export function computeAmplitudePeak(channelData: unknown) {
    let peak = 0;
    for (let i = 0; i < channelData.length; i++) {
        const abs = Math.abs(channelData[i]);
        if (abs > peak) peak = abs;
    }
    return Math.max(1e-6, peak);
}

// ─── Color Maps (private) ───────────────────────────────────────────

const COLOR_MAPS = {
    inferno: [
        [0, 0, 4],
        [31, 12, 72],
        [85, 15, 109],
        [136, 34, 106],
        [186, 54, 85],
        [227, 89, 51],
        [249, 140, 10],
        [252, 201, 40],
        [252, 255, 164],
    ],
    // Keep this table in sync with `web-demo/src/spectrogram.ts` (VIRIDIS_COLORS).
    viridis: [
          [68, 1, 84], [68, 2, 86], [69, 4, 87], [69, 5, 89], [70, 7, 90],
          [70, 8, 92], [70, 10, 93], [70, 11, 94], [71, 13, 96], [71, 14, 97],
          [71, 16, 99], [71, 17, 100], [71, 19, 101], [72, 20, 103], [72, 22, 104],
          [72, 23, 105], [72, 24, 106], [72, 26, 108], [72, 27, 109], [72, 28, 110],
          [72, 29, 111], [72, 31, 112], [72, 32, 113], [72, 33, 115], [72, 35, 116],
          [72, 36, 117], [72, 37, 118], [72, 38, 119], [72, 40, 120], [72, 41, 121],
          [71, 42, 122], [71, 44, 122], [71, 45, 123], [71, 46, 124], [71, 47, 125],
          [70, 48, 126], [70, 50, 126], [70, 51, 127], [69, 52, 128], [69, 53, 129],
          [69, 55, 129], [68, 56, 130], [68, 57, 131], [68, 58, 131], [67, 60, 132],
          [67, 61, 132], [66, 62, 133], [66, 63, 133], [66, 64, 134], [65, 66, 134],
          [65, 67, 135], [64, 68, 135], [64, 69, 136], [63, 71, 136], [63, 72, 137],
          [62, 73, 137], [62, 74, 137], [62, 76, 138], [61, 77, 138], [61, 78, 138],
          [60, 79, 139], [60, 80, 139], [59, 82, 139], [59, 83, 140], [58, 84, 140],
          [58, 85, 140], [57, 86, 141], [57, 88, 141], [56, 89, 141], [56, 90, 141],
          [55, 91, 142], [55, 92, 142], [54, 94, 142], [54, 95, 142], [53, 96, 142],
          [53, 97, 143], [52, 98, 143], [52, 99, 143], [51, 101, 143], [51, 102, 143],
          [50, 103, 144], [50, 104, 144], [49, 105, 144], [49, 106, 144], [49, 108, 144],
          [48, 109, 144], [48, 110, 144], [47, 111, 145], [47, 112, 145], [46, 113, 145],
          [46, 114, 145], [45, 116, 145], [45, 117, 145], [44, 118, 145], [44, 119, 145],
          [44, 120, 146], [43, 121, 146], [43, 122, 146], [42, 123, 146], [42, 125, 146],
          [42, 126, 146], [41, 127, 146], [41, 128, 146], [40, 129, 146], [40, 130, 146],
          [40, 131, 146], [39, 132, 146], [39, 133, 146], [38, 134, 146], [38, 136, 146],
          [38, 137, 146], [37, 138, 146], [37, 139, 146], [36, 140, 146], [36, 141, 146],
          [36, 142, 146], [35, 143, 146], [35, 144, 146], [35, 145, 146], [34, 146, 146],
          [34, 147, 146], [33, 148, 146], [33, 149, 146], [33, 150, 146], [32, 151, 145],
          [32, 152, 145], [32, 153, 145], [31, 154, 145], [31, 155, 145], [31, 156, 145],
          [30, 157, 144], [30, 158, 144], [30, 159, 144], [30, 160, 144], [29, 161, 143],
          [29, 162, 143], [29, 163, 143], [29, 164, 142], [28, 165, 142], [28, 166, 142],
          [28, 167, 141], [28, 168, 141], [28, 169, 141], [27, 170, 140], [27, 171, 140],
          [27, 172, 139], [27, 173, 139], [27, 174, 138], [27, 175, 138], [27, 176, 137],
          [27, 177, 137], [27, 178, 136], [27, 179, 136], [27, 180, 135], [27, 181, 135],
          [27, 182, 134], [27, 183, 133], [28, 184, 133], [28, 185, 132], [28, 186, 131],
          [29, 187, 131], [29, 188, 130], [29, 189, 129], [30, 190, 129], [30, 190, 128],
          [31, 191, 127], [31, 192, 126], [32, 193, 126], [33, 194, 125], [33, 195, 124],
          [34, 196, 123], [35, 197, 123], [36, 198, 122], [37, 198, 121], [37, 199, 120],
          [38, 200, 119], [39, 201, 118], [40, 202, 118], [41, 203, 117], [42, 203, 116],
          [44, 204, 115], [45, 205, 114], [46, 206, 113], [47, 207, 112], [49, 207, 111],
          [50, 208, 110], [51, 209, 109], [53, 210, 108], [54, 210, 107], [56, 211, 106],
          [57, 212, 105], [59, 213, 104], [60, 213, 103], [62, 214, 102], [64, 215, 101],
          [65, 215, 100], [67, 216, 98], [69, 217, 97], [70, 217, 96], [72, 218, 95],
          [74, 219, 94], [76, 219, 93], [78, 220, 91], [80, 221, 90], [82, 221, 89],
          [83, 222, 88], [85, 222, 86], [87, 223, 85], [89, 224, 84], [91, 224, 83],
          [94, 225, 81], [96, 225, 80], [98, 226, 79], [100, 226, 77], [102, 227, 76],
          [104, 227, 75], [106, 228, 73], [109, 228, 72], [111, 229, 71], [113, 229, 69],
          [115, 230, 68], [118, 230, 66], [120, 231, 65], [122, 231, 64], [125, 232, 62],
          [127, 232, 61], [129, 232, 59], [132, 233, 58], [134, 233, 56], [137, 234, 55],
          [139, 234, 53], [141, 235, 52], [144, 235, 50], [146, 235, 49], [149, 236, 47],
          [151, 236, 46], [154, 236, 45], [156, 237, 43], [159, 237, 42], [161, 237, 40],
          [163, 238, 39], [166, 238, 38], [168, 238, 36], [171, 239, 35], [173, 239, 34],
          [176, 239, 32], [178, 239, 31], [181, 240, 30], [183, 240, 29], [186, 240, 28],
          [188, 240, 27], [191, 241, 26], [193, 241, 25], [195, 241, 24], [198, 241, 23],
          [200, 241, 23], [203, 241, 22], [205, 242, 22], [207, 242, 21], [210, 242, 21],
          [212, 242, 21], [214, 242, 21], [217, 242, 20], [219, 242, 20], [221, 243, 20],
          [224, 243, 21], [226, 243, 21], [228, 243, 21], [230, 243, 22], [232, 243, 22],
          [235, 243, 23], [237, 244, 24], [239, 244, 25], [241, 244, 26], [243, 244, 27],
          [245, 244, 28], [247, 244, 30], [249, 244, 31], [251, 245, 33], [253, 245, 35],
    ],
    magma: [
        [0, 0, 4],
        [28, 16, 68],
        [79, 18, 123],
        [129, 37, 129],
        [181, 54, 122],
        [229, 80, 100],
        [251, 135, 97],
        [254, 194, 135],
        [252, 253, 191],
    ],
    plasma: [
        [13, 8, 135],
        [75, 3, 161],
        [125, 3, 168],
        [168, 34, 150],
        [203, 70, 121],
        [229, 107, 93],
        [248, 148, 65],
        [253, 195, 40],
        [240, 249, 33],
    ],
    // Xeno-Canto inspired warm-body palette:
    // black → deep brown → warm red → orange → yellow → white
    xenocanto: [
        [0, 0, 0],
        [30, 10, 5],
        [65, 20, 10],
        [110, 35, 15],
        [160, 55, 15],
        [200, 85, 20],
        [230, 130, 30],
        [245, 180, 60],
        [255, 220, 110],
        [255, 245, 180],
        [255, 255, 255],
    ],
};

// ─── Color Utilities (private) ──────────────────────────────────────

function sampleColorMap(stops: unknown, t: unknown) {
    if (!stops || stops.length === 0) return { r: 0, g: 0, b: 0 };
    if (stops.length === 1) return { r: stops[0][0], g: stops[0][1], b: stops[0][2] };

    const pos = clamp(t, 0, 1) * (stops.length - 1);
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = stops[idx];
    const b = stops[Math.min(stops.length - 1, idx + 1)];
    return {
        r: Math.round(a[0] + (b[0] - a[0]) * frac),
        g: Math.round(a[1] + (b[1] - a[1]) * frac),
        b: Math.round(a[2] + (b[2] - a[2]) * frac),
    };
}

function getSpectrogramColor(value: unknown, colorScheme: unknown) {
    const x = clamp(value, 0, 1);
    if (colorScheme === 'grayscale') {
        const v = Math.round((1 - x) * 255);
        return { r: v, g: v, b: v };
    }
    if (colorScheme === 'viridis') {
        const palette = COLOR_MAPS.viridis;
        const idx = Math.min(palette.length - 1, Math.floor(x * (palette.length - 1)));
        const color = palette[idx];
        return { r: color[0], g: color[1], b: color[2] };
    }
    if (colorScheme === 'fire') {
        const r = Math.round(255 * Math.pow(x, 0.7));
        const g = Math.round(255 * clamp((x - 0.15) / 0.85, 0, 1));
        const b = Math.round(255 * clamp((x - 0.45) / 0.55, 0, 1));
        return { r, g, b };
    }
    return sampleColorMap(COLOR_MAPS[colorScheme] || COLOR_MAPS.inferno, x);
}

// ─── GPU-accelerated Colorizer (WebGL2) ─────────────────────────────

const _VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
    v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
    gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const _FS = `#version 300 es
precision mediump float;
uniform sampler2D u_gray;
uniform sampler2D u_lut;
uniform float u_floor;
uniform float u_rcpRange;
in vec2 v_uv;
out vec4 fragColor;
void main() {
    float g = texture(u_gray, v_uv).r;
    float t = clamp((g - u_floor) * u_rcpRange, 0.0, 1.0);
    fragColor = texture(u_lut, vec2(t, 0.5));
}`;

export class GpuColorizer {
    constructor() {
        this._canvas = document.createElement('canvas');
        const gl = this._canvas.getContext('webgl2', {
            premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false,
        });
        if (!gl) { this._gl = null; return; }
        this._gl = gl;
        this._maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);

        const vs = this._sh(gl.VERTEX_SHADER, _VS);
        const fs = this._sh(gl.FRAGMENT_SHADER, _FS);
        if (!vs || !fs) { this._gl = null; return; }

        const p = gl.createProgram();
        gl.attachShader(p, vs); gl.attachShader(p, fs);
        gl.linkProgram(p);
        gl.deleteShader(vs); gl.deleteShader(fs);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { this._gl = null; return; }
        /** @type {WebGLProgram | null} */
        this._prog = p;

        /** @type {WebGLUniformLocation | null} */
        this._uFloor    = gl.getUniformLocation(p, 'u_floor');
        /** @type {WebGLUniformLocation | null} */
        this._uRcpRange = gl.getUniformLocation(p, 'u_rcpRange');
        /** @type {WebGLUniformLocation | null} */
        this._uGray     = gl.getUniformLocation(p, 'u_gray');
        /** @type {WebGLUniformLocation | null} */
        this._uLut      = gl.getUniformLocation(p, 'u_lut');

        // Fullscreen quad VAO
        /** @type {WebGLVertexArrayObject | null} */
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(p, 'a_pos');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        this._vao = vao;

        /** @type {WebGLTexture | null} */
        this._grayTex = gl.createTexture();
        /** @type {WebGLTexture | null} */
        this._lutTex  = gl.createTexture();
        /** @type {number} */
        this._w = 0;
        /** @type {number} */
        this._h = 0;
        this._lutScheme = null;
    }

    /** @private */ _sh(type: unknown, src: unknown) {
        const gl = this._gl;
        if (!gl) return null;
        const s = gl.createShader(type);
        if (!s) return null;
        gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { gl.deleteShader(s); return null; }
        return s;
    }

    get ok()     { return !!this._gl; }
    get canvas() { return this._canvas; }

    /** Upload Float32 grayscale map (values 0-1) as a R32F texture. Returns success. */
    uploadGrayscale(gray: unknown, width: unknown, height: unknown) {
        const gl = this._gl;
        if (!gl || width > this._maxTex || height > this._maxTex) return false;
        this._w = width;  this._h = height;
        this._canvas.width = width; this._canvas.height = height;

        gl.bindTexture(gl.TEXTURE_2D, this._grayTex);
        // Float32Array → R32F (full precision, no 8-bit quantisation)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0, gl.RED, gl.FLOAT, gray);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return true;
    }

    /** Build 256-entry RGBA color look-up texture from a color scheme. */
    uploadColorLut(scheme: unknown) {
        if (scheme === this._lutScheme) return;
        const gl = this._gl;  if (!gl) return;
        this._lutScheme = scheme;

        const d = new Uint8Array(256 * 4);
        for (let i = 0; i < 256; i++) {
            const c = getSpectrogramColor(i / 255, scheme);
            const o = i * 4;
            d[o] = c.r; d[o+1] = c.g; d[o+2] = c.b; d[o+3] = 255;
        }
        gl.bindTexture(gl.TEXTURE_2D, this._lutTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, d);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    /** Render colorized spectrogram. floor01/ceil01 ∈ [0,1]. ~0.1 ms. */
    render(floor01: unknown, ceil01: unknown) {
        const gl = this._gl;
        if (!gl || !this._w || !this._prog || !this._vao) return;
        gl.viewport(0, 0, this._w, this._h);
        gl.useProgram(this._prog);
        gl.bindVertexArray(this._vao);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this._grayTex);
        gl.uniform1i(this._uGray, 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this._lutTex);
        gl.uniform1i(this._uLut, 1);

        gl.uniform1f(this._uFloor, floor01);
        gl.uniform1f(this._uRcpRange, 1 / Math.max(1e-4, ceil01 - floor01));
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    dispose() {
        const gl = this._gl; if (!gl) return;
        if (this._grayTex) gl.deleteTexture(this._grayTex);
        if (this._lutTex) gl.deleteTexture(this._lutTex);
        if (this._prog) gl.deleteProgram(this._prog);
        if (this._vao) gl.deleteVertexArray(this._vao);
        this._gl = null;
    }
}

// ─── Spectrogram Stats ──────────────────────────────────────────────

export function updateSpectrogramStats(spectrogramData: unknown) {
    if (!spectrogramData || spectrogramData.length === 0) {
        return { logMin: 0, logMax: 1 };
    }

    let minLog = Number.POSITIVE_INFINITY;
    let maxLog = Number.NEGATIVE_INFINITY;
    const stride = Math.max(1, Math.floor(spectrogramData.length / 120000));
    for (let i = 0; i < spectrogramData.length; i += stride) {
        const mapped = spectrogramData[i] || 0;
        if (mapped < minLog) minLog = mapped;
        if (mapped > maxLog) maxLog = mapped;
    }

    if (!Number.isFinite(minLog) || !Number.isFinite(maxLog) || maxLog - minLog < 1e-6) {
        return { logMin: 0, logMax: 1 };
    }

    return { logMin: minLog, logMax: maxLog };
}

// ─── Auto-Contrast (percentile-based) ───────────────────────────────

/**
 * Computes tighter logMin/logMax from the PCEN data using percentiles,
 * cutting away noise-floor and rare hot-spots for better visual contrast.
 * @param {Float32Array} spectrogramData  - flat PCEN output (nFrames × nMels)
 * @param {number} [loPercentile=2]       - lower percentile (black point)
 * @param {number} [hiPercentile=98]      - upper percentile (white point)
 */
export function autoContrastStats(spectrogramData: unknown, loPercentile = 2, hiPercentile = 98) {
    if (!spectrogramData || spectrogramData.length === 0) return { logMin: 0, logMax: 1 };

    // Sub-sample for speed - max ~200k values
    const stride = Math.max(1, Math.floor(spectrogramData.length / 200000));
    const mapped = [];
    for (let i = 0; i < spectrogramData.length; i += stride) {
        mapped.push(spectrogramData[i] || 0);
    }
    mapped.sort((a, b) => a - b);

    const loIdx = Math.floor(mapped.length * loPercentile / 100);
    const hiIdx = Math.min(mapped.length - 1, Math.floor(mapped.length * hiPercentile / 100));
    const logMin = mapped[loIdx];
    const logMax = mapped[hiIdx];

    if (!Number.isFinite(logMin) || !Number.isFinite(logMax) || logMax - logMin < 1e-6) {
        return { logMin: 0, logMax: 1 };
    }
    return { logMin, logMax };
}

// ─── Auto-Frequency Detection ───────────────────────────────────────

/**
 * Detects the effective upper frequency boundary by finding the highest
 * bin that carries meaningful energy above the noise floor.
 * Returns a frequency in Hz suitable as maxFreq.
 * @param {Float32Array} spectrogramData
 * @param {number} nFrames
 * @param {number} nMels
 * @param {number} sampleRate
 * @param {string} [scale='mel'] - 'mel' or 'linear'
 * @param {number} [energyThreshold=0.08] - fraction of peak-bin energy
 */
export function detectMaxFrequency(spectrogramData: unknown, nFrames: unknown, nMels: unknown, sampleRate: unknown, scale = 'mel', energyThreshold = 0.08) {
    if (!spectrogramData || nFrames <= 0 || nMels <= 0) return sampleRate / 2;

    // Accumulate mean energy per bin
    const binEnergy = new Float64Array(nMels);
    const stride = Math.max(1, Math.floor(nFrames / 2000)); // subsample frames
    let sampledFrames = 0;
    for (let f = 0; f < nFrames; f += stride) {
        const base = f * nMels;
        for (let m = 0; m < nMels; m++) {
            binEnergy[m] += spectrogramData[base + m] || 0;
        }
        sampledFrames++;
    }
    for (let m = 0; m < nMels; m++) binEnergy[m] /= sampledFrames;

    // Find peak energy value
    let peakEnergy = -Infinity;
    for (let m = 0; m < nMels; m++) {
        if (binEnergy[m] > peakEnergy) peakEnergy = binEnergy[m];
    }
    if (!isFinite(peakEnergy)) return sampleRate / 2;
    // For positive data (PCEN/linear): zero-check + multiplicative fraction
    // For negative data (dB scale):    dB offset below peak
    if (peakEnergy >= 0 && peakEnergy < 1e-12) return sampleRate / 2;

    const threshold = peakEnergy < 0
        ? peakEnergy + 10 * Math.log10(Math.max(1e-10, energyThreshold))
        : peakEnergy * energyThreshold;

    // Collect all active bins and use the 95th percentile as the upper bound.
    // This is more robust than a single top-down scan which can be thrown off
    // by isolated noise in a single high bin.
    const activeBins = [];
    for (let m = 0; m < nMels; m++) {
        if (binEnergy[m] > threshold) activeBins.push(m);
    }
    if (activeBins.length === 0) return sampleRate / 2;

    const p95Idx = Math.min(activeBins.length - 1,
        Math.ceil(activeBins.length * 0.95) - 1);
    const upperBin = activeBins[p95Idx];

    // Map bin to Hz
    let detectedHz;
    if (scale === 'linear') {
        const binHz = (sampleRate / 2) / nMels;
        detectedHz = Math.min(nMels - 1, upperBin) * binHz;
    } else {
        const melFreqs = buildMelFrequencies(sampleRate, nMels);
        detectedHz = melFreqs[Math.min(nMels - 1, upperBin)] || sampleRate / 2;
    }
    const withMargin = detectedHz * 1.1;

    // Snap to nearest standard step
    const steps = [2000, 3000, 4000, 5000, 6000, 8000, 10000, 12000, 16000, 20000, 22050];
    const nyquist = sampleRate / 2;
    let best = nyquist;
    for (const s of steps) {
        if (s >= withMargin && s <= nyquist) { best = s; break; }
    }
    return best;
}

// ─── Pixel → Frequency mapping ──────────────────────────────────────

/**
 * Converts a display-space Y pixel to a frequency in Hz.
 * Mirrors the bin mapping used by buildSpectrogramGrayscale so the
 * crosshair readout matches the rendered image exactly.
 * @param {number} displayY       - Y pixel in the rendered canvas (0 = top)
 * @param {number} displayHeight  - Total rendered canvas height (e.g. 200)
 * @param {number} maxFreq        - Currently selected max frequency (Hz)
 * @param {number} sampleRateHz   - Audio sample rate
 * @param {number} spectrogramMels - Number of mel/linear bins
 * @param {string} scale - 'mel' or 'linear'
 * @returns {number} Frequency in Hz
 */
export function pixelYToFrequency(displayY: unknown, displayHeight: unknown, maxFreq: unknown, sampleRateHz: unknown, spectrogramMels: unknown, scale: unknown) {
    if (displayHeight <= 1 || spectrogramMels <= 0) return 0;
    const cs = new CoordinateSystem({
        canvasHeight: displayHeight, maxFreq, sampleRate: sampleRateHz,
        spectrogramMels, scale,
    });
    return cs.pixelYToFrequency(displayY);
}

/**
 * Inverse of pixelYToFrequency: maps a frequency (Hz) → display pixel Y.
 */
export function frequencyToPixelY(freq: unknown, displayHeight: unknown, maxFreq: unknown, sampleRateHz: unknown, spectrogramMels: unknown, scale: unknown) {
    if (displayHeight <= 1 || spectrogramMels <= 0) return 0;
    const cs = new CoordinateSystem({
        canvasHeight: displayHeight, maxFreq, sampleRate: sampleRateHz,
        spectrogramMels, scale,
    });
    return cs.frequencyToPixelY(freq);
}

// ─── Time Grid (private helper) ─────────────────────────────────────

// scrollLeft: how many px the canvas-wrapper is scrolled (viewport offset).
// Grid lines are drawn in viewport coords (x = absoluteX - scrollLeft).
function drawTimeGrid({ ctx, width, height, duration, pixelsPerSecond, scrollLeft = 0 }) {
    if (width <= 0) return;
    const css = getComputedStyle(document.documentElement);
    const majorColor = css.getPropertyValue('--color-text-secondary').trim() || '#cbd5e1';
    const { majorStep, minorStep } = getTimeGridSteps(pixelsPerSecond);

    ctx.save();
    ctx.font = '11px monospace';
    ctx.textBaseline = 'top';

    for (let t = 0; t <= duration; t += minorStep) {
        const absX = Math.round(t * pixelsPerSecond);
        const x = absX - scrollLeft + 0.5;
        if (x < 0 || x > width) continue;
        const isMajor = Math.abs((t / majorStep) - Math.round(t / majorStep)) < 0.0001;
        ctx.strokeStyle = isMajor ? 'rgba(148,163,184,0.35)' : 'rgba(148,163,184,0.18)';
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
        if (isMajor) {
            ctx.fillStyle = majorColor;
            ctx.fillText(`${t.toFixed(1)}s`, x + 3, 4);
        }
    }
    ctx.restore();
}

// ─── Base Image Builder (2-stage pipeline) ──────────────────────────

/**
 * Stage 1 - Expensive, done ONCE per audio / fftSize / maxFreq change.
 * Converts spectrogram data → 8-bit grayscale image (Uint8Array).
 * Frame-averaging and mel→y mapping happens here.
 * The `colourScale` parameter controls how raw values map to pixel brightness:
 *   - 'dbSquared' / 'db' / PCEN: linear range mapping (existing behavior)
 *   - 'linear': proportional magnitude mapping
 *   - 'meter': IEC 60268-18 perceptual meter curve
 *   - 'phase': −π…+π → 0…255
 */
export function buildSpectrogramGrayscale({
    spectrogramData, spectrogramFrames, spectrogramMels,
    sampleRateHz, maxFreq,
    spectrogramAbsLogMin, spectrogramAbsLogMax,
    scale = 'mel',
    colourScale = 'dbSquared',
    noiseReduction = false,
    clahe = false,
}) {
    if (!spectrogramData || spectrogramFrames <= 0 || spectrogramMels <= 0) return null;

    const width  = clamp(spectrogramFrames, 1, MAX_BASE_SPECTROGRAM_WIDTH);
    const height = spectrogramMels;
    const framesPerPixel = spectrogramFrames / width;
    const isLinear = scale === 'linear';

    const boundedMaxFreq = Math.min(maxFreq, sampleRateHz / 2);

    const melFreqs = isLinear ? null : buildMelFrequencies(sampleRateHz, spectrogramMels);
    const maxBin = computeMaxBin({
        isLinear,
        nyquist: sampleRateHz / 2,
        spectrogramMels,
        boundedMaxFreq,
        melFreqs,
    });

    // Y-axis: bilinear interpolation between mel bins (avoids staircase artifacts)
    const yBinLo   = new Int16Array(height);
    const yBinHi   = new Int16Array(height);
    const yBinFrac = new Float32Array(height);
    for (let y = 0; y < height; y++) {
        const fracBin = (height - 1 - y) / (height - 1) * maxBin;
        const lo = clamp(Math.floor(fracBin), 0, maxBin);
        const hi = Math.min(maxBin, lo + 1);
        yBinLo[y]   = lo;
        yBinHi[y]   = hi;
        yBinFrac[y] = fracBin - lo;
    }

    // ── Spectral subtraction (median noise floor estimation) ──
    // For each mel bin, estimate the noise floor as the median value
    // across all frames, then subtract it.
    let cleanData = spectrogramData;
    if (noiseReduction && colourScale !== 'phase') {
        cleanData = spectralSubtract(spectrogramData, spectrogramFrames, spectrogramMels);
    }

    const dataRange = Math.max(1e-6, spectrogramAbsLogMax - spectrogramAbsLogMin);
    // ── Float32 grayscale (0.0 – 1.0) for full precision ──
    const gray = new Float32Array(width * height);

    // Precompute IEC meter mapping factor
    const IEC_MAX = colourScale === 'meter' ? iecDbToFader(0) : 0;

    for (let x = 0; x < width; x++) {
        const frameStart = Math.round(x * framesPerPixel);
        const frameEnd   = Math.max(frameStart + 1, Math.round((x + 1) * framesPerPixel));

        for (let y = 0; y < height; y++) {
            const binLo = yBinLo[y];
            const binHi = yBinHi[y];
            const frac  = yBinFrac[y];
            let sumLo = 0, sumHi = 0, count = 0;

            for (let frame = frameStart; frame < frameEnd; frame++) {
                const base = frame * spectrogramMels;
                sumLo += cleanData[base + binLo] || 0;
                sumHi += cleanData[base + binHi] || 0;
                count++;
            }

            const value = (sumLo + (sumHi - sumLo) * frac) / Math.max(1, count);
            let pixel;

            if (colourScale === 'phase') {
                pixel = (value + Math.PI) / (2 * Math.PI);
            } else if (colourScale === 'meter') {
                const normalized = (value - spectrogramAbsLogMin) / dataRange;
                const raw = clamp(normalized, 0, 1);
                const db = raw <= 0 ? -80 : 20 * Math.log10(raw);
                pixel = iecDbToFader(Math.max(-70, db)) / IEC_MAX;
            } else {
                pixel = (value - spectrogramAbsLogMin) / dataRange;
            }

            gray[y * width + x] = clamp(pixel, 0, 1);
        }
    }

    // ── CLAHE (Contrast Limited Adaptive Histogram Equalization) ──
    if (clahe && colourScale !== 'phase') {
        applyCLAHE(gray, width, height);
    }

    return { gray, width, height };
}

// ─── Spectral Subtraction (Median Noise Floor) ─────────────────────

/**
 * Estimate per-bin noise floor via median across all frames,
 * then subtract it so stationary noise is suppressed.
 * Returns a new Float32Array with the same layout.
 */
export function spectralSubtract(spectrogramData: unknown, nFrames: unknown, nMels: unknown) {
    const result = new Float32Array(spectrogramData.length);

    for (let m = 0; m < nMels; m++) {
        // Sample up to 2000 frames for median estimation (speed)
        const stride = Math.max(1, Math.floor(nFrames / 2000));
        const vals = [];
        for (let f = 0; f < nFrames; f += stride) {
            vals.push(spectrogramData[f * nMels + m]);
        }
        vals.sort((a, b) => a - b);
        const median = vals[Math.floor(vals.length / 2)] || 0;

        // Subtract median (half-wave rectification)
        for (let f = 0; f < nFrames; f++) {
            const idx = f * nMels + m;
            result[idx] = Math.max(0, spectrogramData[idx] - median);
        }
    }
    return result;
}

// ─── CLAHE (Contrast Limited Adaptive Histogram Equalization) ───────

/**
 * Apply CLAHE in-place on a Float32Array grayscale image (values 0-1).
 * Divides the image into tiles, computes clipped histograms per tile,
 * and bilinearly interpolates between tile mappings for smooth results.
 *
 * @param {Float32Array} gray   - image data [0,1], modified in place
 * @param {number} width
 * @param {number} height
 * @param {number} [nTilesX=8]  - number of horizontal tiles
 * @param {number} [nTilesY=4]  - number of vertical tiles
 * @param {number} [clipLimit=2.5] - contrast limit (higher = more contrast, 1 = no enhancement)
 */
export function applyCLAHE(gray: unknown, width: unknown, height: unknown, nTilesX = 8, nTilesY = 4, clipLimit = 2.5) {
    const nBins = 256;
    const tilesX = Math.min(nTilesX, width);
    const tilesY = Math.min(nTilesY, height);
    if (tilesX < 1 || tilesY < 1) return;

    const tileW = width / tilesX;
    const tileH = height / tilesY;

    // Build CDF for each tile
    const cdfs = new Array(tilesY * tilesX);
    for (let ty = 0; ty < tilesY; ty++) {
        for (let tx = 0; tx < tilesX; tx++) {
            const x0 = Math.floor(tx * tileW);
            const x1 = Math.min(width, Math.floor((tx + 1) * tileW));
            const y0 = Math.floor(ty * tileH);
            const y1 = Math.min(height, Math.floor((ty + 1) * tileH));
            const nPixels = (x1 - x0) * (y1 - y0);
            if (nPixels === 0) { cdfs[ty * tilesX + tx] = new Float32Array(nBins); continue; }

            // Build histogram
            const hist = new Float64Array(nBins);
            for (let yy = y0; yy < y1; yy++) {
                for (let xx = x0; xx < x1; xx++) {
                    const bin = Math.min(nBins - 1, Math.floor(gray[yy * width + xx] * (nBins - 1)));
                    hist[bin]++;
                }
            }

            // Clip histogram & redistribute
            const limit = Math.max(1, Math.floor(clipLimit * nPixels / nBins));
            let excess = 0;
            for (let i = 0; i < nBins; i++) {
                if (hist[i] > limit) { excess += hist[i] - limit; hist[i] = limit; }
            }
            const perBin = excess / nBins;
            for (let i = 0; i < nBins; i++) hist[i] += perBin;

            // Build CDF (normalized 0-1)
            const cdf = new Float32Array(nBins);
            cdf[0] = hist[0];
            for (let i = 1; i < nBins; i++) cdf[i] = cdf[i - 1] + hist[i];
            const cdfMin = cdf[0];
            const cdfRange = Math.max(1, cdf[nBins - 1] - cdfMin);
            for (let i = 0; i < nBins; i++) cdf[i] = (cdf[i] - cdfMin) / cdfRange;
            cdfs[ty * tilesX + tx] = cdf;
        }
    }

    // Apply with bilinear interpolation between tile CDFs
    for (let y = 0; y < height; y++) {
        // Tile center coordinate
        const tyF = (y + 0.5) / tileH - 0.5;
        const ty0 = clamp(Math.floor(tyF), 0, tilesY - 1);
        const ty1 = Math.min(tilesY - 1, ty0 + 1);
        const fy = tyF - ty0;

        for (let x = 0; x < width; x++) {
            const txF = (x + 0.5) / tileW - 0.5;
            const tx0 = clamp(Math.floor(txF), 0, tilesX - 1);
            const tx1 = Math.min(tilesX - 1, tx0 + 1);
            const fx = txF - tx0;

            const val = gray[y * width + x];
            const bin = clamp(Math.floor(val * (nBins - 1)), 0, nBins - 1);

            // Bilinear interpolation of 4 surrounding tile CDFs
            const c00 = cdfs[ty0 * tilesX + tx0][bin];
            const c10 = cdfs[ty0 * tilesX + tx1][bin];
            const c01 = cdfs[ty1 * tilesX + tx0][bin];
            const c11 = cdfs[ty1 * tilesX + tx1][bin];
            const top = c00 + (c10 - c00) * fx;
            const bot = c01 + (c11 - c01) * fx;
            gray[y * width + x] = clamp(top + (bot - top) * fy, 0, 1);
        }
    }
}

/**
 * Stage 2 - Cheap JS fallback, called on every floor/ceil/colorScheme change.
 * Builds a 256-entry RGBA look-up table, then paints the Float32 grayscale map.
 */
export function colorizeSpectrogram(grayInfo: unknown, floor01: unknown, ceil01: unknown, colorScheme: unknown) {
    if (!grayInfo) return null;
    const { gray, width, height } = grayInfo;

    const lut = new Uint32Array(256);
    const range = Math.max(1e-6, ceil01 - floor01);
    const view = new DataView(lut.buffer);
    for (let i = 0; i < 256; i++) {
        const raw = i / 255;
        const remapped = clamp((raw - floor01) / range, 0, 1);
        const c = getSpectrogramColor(remapped, colorScheme);
        view.setUint32(i * 4, (255 << 24) | (c.b << 16) | (c.g << 8) | c.r, true);
    }

    const canvas = document.createElement('canvas');
    canvas.width  = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const imageData = ctx.createImageData(width, height);
    const pixels = new Uint32Array(imageData.data.buffer);
    const len = width * height;
    for (let i = 0; i < len; i++) {
        // Float32 gray [0,1] → LUT index [0,255]
        const idx = clamp(Math.round(gray[i] * 255), 0, 255);
        pixels[i] = lut[idx];
    }

    ctx.putImageData(imageData, 0, 0);
    return canvas;
}

// ─── Render Spectrogram to Canvas ───────────────────────────────────

export function renderSpectrogram({
    duration,
    spectrogramCanvas,
    pixelsPerSecond,
    canvasHeight,
    baseCanvas,
    freqViewSrcCrop,
    // Viewport-rendering params. When provided the canvas is sized to the
    // visible viewport only (huge perf win for long recordings at high zoom).
    canvasSizer,      // HTMLElement — sets the scrollable width
    scrollLeft = 0,   // canvasWrapper.scrollLeft
    viewportWidth,    // canvasWrapper.clientWidth (null → legacy full-width)
    totalWidth: explicitTotalWidth, // override computed width (sync to waveform width)
}) {
    if (!baseCanvas) return;
    const ctx = spectrogramCanvas.getContext('2d');
    if (!ctx) return;

    const totalWidth = explicitTotalWidth > 0
        ? explicitTotalWidth
        : Math.max(1, Math.round(duration * pixelsPerSecond));
    const height = Math.max(140, Math.floor(canvasHeight));

    // Update the sizer so the scroll container knows the full scrollable range.
    if (canvasSizer) canvasSizer.style.width = `${totalWidth}px`;

    // Canvas width = visible viewport (capped at totalWidth).
    // Falls back to full-width if viewportWidth is not supplied.
    const width = viewportWidth > 0 ? Math.min(viewportWidth, totalWidth) : totalWidth;
    const sl = viewportWidth > 0 ? scrollLeft : 0; // scroll offset applied in drawing

    spectrogramCanvas.width = width;
    spectrogramCanvas.height = height;

    ctx.clearRect(0, 0, width, height);

    // Draw the spectrogram image stretched to exactly [0, totalWidth] so that
    // the time axis matches the waveform pixel-for-pixel. Any sub-frame rounding
    // error (<< 1 hop ≈ 10ms) is imperceptible for audio visualization.
    const x0 = -sl;           // image starts at absolute pixel 0, viewport-relative: -scrollLeft
    const drawWidth = totalWidth;

    // Source region of baseCanvas (supports vertical zoom via frequency viewport crop).
    const srcY = freqViewSrcCrop?.srcY ?? 0;
    const srcH = freqViewSrcCrop?.srcH ?? baseCanvas.height;

    // Clip to visible viewport so we only blit what's on screen.
    const visLeft  = Math.max(0, -x0);                    // pixels into draw region that are visible
    const visRight = Math.min(drawWidth, width - x0);     // right edge (in draw region coords)
    if (visRight > visLeft) {
        const srcFrac0 = visLeft  / drawWidth;
        const srcFrac1 = visRight / drawWidth;
        const clipSrcX = srcFrac0 * baseCanvas.width;
        const clipSrcW = (srcFrac1 - srcFrac0) * baseCanvas.width;
        const dstX = x0 + visLeft;
        const dstW = visRight - visLeft;

        // Two-pass rendering: crisp horizontal pixels + smooth vertical interpolation.
        const wantCrispH = drawWidth >= baseCanvas.width;
        const needsVerticalScale = height !== srcH;

        if (wantCrispH && needsVerticalScale) {
            // Pass 1: crop the visible horizontal slice + scale vertically (bilinear).
            const oc = typeof OffscreenCanvas !== 'undefined'
                ? new OffscreenCanvas(Math.ceil(clipSrcW), height)
                : (() => { const c = document.createElement('canvas'); c.width = Math.ceil(clipSrcW); c.height = height; return c; })();
            const octx = oc.getContext('2d');
            if (!octx) return;
            octx.imageSmoothingEnabled = true;
            octx.imageSmoothingQuality = 'high';
            octx.drawImage(baseCanvas,
                clipSrcX, srcY, clipSrcW, srcH,
                0, 0, Math.ceil(clipSrcW), height);
            // Pass 2: scale horizontally with nearest-neighbor (crisp time axis).
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(oc,
                0, 0, Math.ceil(clipSrcW), height,
                dstX, 0, dstW, height);
        } else {
            ctx.imageSmoothingEnabled = !wantCrispH;
            ctx.drawImage(baseCanvas,
                clipSrcX, srcY, clipSrcW, srcH,
                dstX, 0, dstW, height);
        }
    }

    drawTimeGrid({ ctx, width, height, duration, pixelsPerSecond, scrollLeft: sl });
}

// ─── Worker-based Spectrogram Processor ─────────────────────────────

export function createSpectrogramProcessor() {
    let worker = null;
    let workerFailed = false;
    let requestCounter = 0;
    const pendingRequests = new Map();

    // ── Main-thread fallback - delegates directly to dsp.js ────────
    const computeMainThread = (channelData: unknown, options: unknown) => {
        return computeSpectrogram({
            channelData: channelData,
            ...options,
        });
    };

    // ── Worker setup - uses Vite-inlined module Worker ──────────────
    const ensureWorker = async () => {
        if (worker || workerFailed) return;
        try {
            const Ctor = await getWorkerCtor();
            if (!Ctor) throw new Error('Worker constructor unavailable');
            worker = new Ctor();

            worker.onmessage = (event: unknown) => {
                const { requestId, data, nFrames, nMels, smoothState, hopSize, winLength, colourScale } = event.data;
                const pending = pendingRequests.get(requestId);
                if (!pending) return;
                pendingRequests.delete(requestId);
                const result = { data: new Float32Array(data), nFrames, nMels, hopSize, winLength, colourScale };
                if (smoothState) result.smoothState = new Float32Array(smoothState);
                pending.resolve(result);
            };

            worker.onerror = (error: unknown) => {
                console.warn('Spectrogram Worker failed, using main-thread fallback:', error);
                workerFailed = true;
                worker?.terminate();
                worker = null;
                pendingRequests.forEach(({ reject }) => reject(error));
                pendingRequests.clear();
            };
        } catch (e) {
            console.warn('Cannot create Worker, using main-thread fallback:', e);
            workerFailed = true;
            worker = null;
        }
    };

    // ── Public compute ──────────────────────────────────────────────
    const compute = async (channelData: unknown, options: unknown) => {
        // If Workers don't work in this context, run synchronously
        if (workerFailed) {
            return computeMainThread(channelData, options);
        }

        await ensureWorker();

        // Worker might have failed during creation
        if (workerFailed) {
            return computeMainThread(channelData, options);
        }

        const requestId = ++requestCounter;
        const audioCopy = new Float32Array(channelData);

        const workerPromise = new Promise((resolve, reject) => {
            pendingRequests.set(requestId, { resolve, reject });
        });

        worker.postMessage(
            { requestId, channelData: audioCopy.buffer, ...options },
            [audioCopy.buffer],
        );

        // Timeout scales with audio length: 5s base + 2s per 10s of audio.
        // Progressive mode sends 10s chunks, so each chunk gets at least 7s.
        // Full-file compute for short clips: 60s → 17s timeout, plenty of headroom.
        const durationSec = channelData.length / Math.max(1, options.sampleRate || 44100);
        const timeoutMs = Math.max(5000, 5000 + Math.ceil(durationSec / 10) * 2000);

        try {
            const result = await Promise.race([
                workerPromise,
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Worker timeout')), timeoutMs)
                ),
            ]);
            return result;
        } catch (e) {
            // Worker timed out or errored → fall back to main thread
            console.warn('Worker failed/timed out, computing on main thread:', e.message);
            pendingRequests.delete(requestId);
            workerFailed = true;
            worker?.terminate();
            worker = null;
            return computeMainThread(channelData, options);
        }
    };

    // ── Progressive compute for long recordings ────────────────────
    // Yields per-chunk results and progress metadata.
    // Each chunk (after the first) is extended backwards by overlapSamples
    // so the FFT windows at chunk boundaries have proper audio context.
    // The overlap frames are trimmed from the result before yielding.
    const computeProgressive = async function* (channelData: unknown, options: unknown) {
        const sampleRate = Math.max(1, options.sampleRate || 0);
        const chunkSeconds = Math.max(1, options.chunkSeconds || 10);
        const samplesPerChunk = Math.max(1, Math.floor(chunkSeconds * sampleRate));
        const totalChunks = Math.max(1, Math.ceil(channelData.length / samplesPerChunk));

        // Overlap = one FFT window worth of samples — enough for windowing context.
        const overlapSamples = options.windowSize || options.fftSize || 2048;

        let smoothState = null; // carry-over PCEN smooth state between chunks

        for (let chunk = 0; chunk < totalChunks; chunk++) {
            const startSample = chunk * samplesPerChunk;
            const endSample = Math.min(channelData.length, startSample + samplesPerChunk);

            // For chunks after the first, prepend overlap samples for FFT context.
            const actualStart = chunk === 0
                ? startSample
                : Math.max(0, startSample - overlapSamples);
            const prependedSamples = startSample - actualStart;

            const chunkData = channelData.subarray(actualStart, endSample);
            const chunkOptions = smoothState
                ? { ...options, initialSmooth: smoothState }
                : options;
            const result = await compute(chunkData, chunkOptions);

            if (result.smoothState) smoothState = result.smoothState;

            // Trim overlap frames from the beginning of non-first chunks.
            let trimmedResult = result;
            if (prependedSamples > 0 && result.nFrames > 0) {
                const hop = result.hopSize || 1;
                const overlapFrames = Math.min(
                    result.nFrames - 1,
                    Math.ceil(prependedSamples / hop),
                );
                if (overlapFrames > 0) {
                    const nMels = result.nMels;
                    trimmedResult = {
                        ...result,
                        data: result.data.slice(overlapFrames * nMels),
                        nFrames: result.nFrames - overlapFrames,
                    };
                }
            }

            yield {
                chunk,
                totalChunks,
                percent: ((chunk + 1) / totalChunks) * 100,
                result: trimmedResult,
            };
        }
    };

    const dispose = () => {
        if (worker) { worker.terminate(); worker = null; }
        pendingRequests.clear();
    };

    return { compute, computeProgressive, dispose };
}
