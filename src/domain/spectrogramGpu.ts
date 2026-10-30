// ═══════════════════════════════════════════════════════════════════════
// spectrogramGpu.ts — viewport spectrogram rendering straight from dB data
//
// Replaces stage 1 (time/frequency resampling into a base image) and the
// drawImage scaling of stage 3 for the v2 engine: the fragment shader maps
// each display pixel to its frame and bin range, max-pools the dB values
// inside it (narrow tonal lines survive any zoom), subtracts the per-band
// noise floor, applies the dB window and colours through the LUT.
//
// Data layout: row-major [frame][bin] values packed into an R32F texture of
// PACK_W texels per row (texel index = frame · bins + bin), so long files are
// not limited by MAX_TEXTURE_SIZE in the frame direction.
// ═══════════════════════════════════════════════════════════════════════

const PACK_W = 4096;
/** Upper bound for uploaded values (R32F: 4 bytes each → 192 MiB). */
const MAX_VALUES = 48 * 1024 * 1024;
/** Samples per pixel and axis; larger spans are strided. */
const MAX_TAPS = 24;

const VS = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D u_data;   // packed dB values
uniform sampler2D u_floor;  // per-band noise floor (bins × 1)
uniform sampler2D u_lut;    // 256 × 1 RGBA
uniform int   u_bins;
uniform int   u_frames;
uniform float u_height;     // output height (px)
uniform float u_frame0;     // frame at the left edge of pixel column 0
uniform float u_framesPerPx;
uniform float u_binTop;     // fractional bin at y = 0 (top edge)
uniform float u_binsPerPx;  // decrease of the bin per pixel downwards (> 0)
uniform float u_useFloor;
uniform float u_lo;
uniform float u_rcpRange;
out vec4 fragColor;

float cell(int f, int b) {
    int i = f * u_bins + b;
    float v = texelFetch(u_data, ivec2(i % ${PACK_W}, i / ${PACK_W}), 0).r;
    return v - u_useFloor * texelFetch(u_floor, ivec2(b, 0), 0).r;
}

// Value at a frame for the pixel row's bin span [b0, b1].
float column(int f, float b0, float b1) {
    if (b1 - b0 < 1.0) {
        // Less than one bin per pixel: linear between the two nearest bins.
        float c = clamp(0.5 * (b0 + b1), 0.0, float(u_bins - 1));
        int lo = int(floor(c));
        int hi = min(lo + 1, u_bins - 1);
        return mix(cell(f, lo), cell(f, hi), c - float(lo));
    }
    int s = max(0, int(ceil(b0)));
    int e = min(u_bins - 1, int(floor(b1)));
    int step = max(1, (e - s + ${MAX_TAPS}) / ${MAX_TAPS});
    float m = -1e30;
    for (int b = s; b <= e; b += step) m = max(m, cell(f, b));
    return m;
}

void main() {
    // gl_FragCoord.y counts from the bottom; display y counts from the top.
    float yTop = u_height - gl_FragCoord.y - 0.5;
    float b1 = u_binTop - yTop * u_binsPerPx;           // upper edge of the row
    float b0 = b1 - u_binsPerPx;                         // lower edge
    if (b1 < -0.5 || b0 > float(u_bins) - 0.5) { fragColor = texture(u_lut, vec2(0.0, 0.5)); return; }

    float x = gl_FragCoord.x - 0.5;
    float f0 = u_frame0 + x * u_framesPerPx;
    float v;
    if (u_framesPerPx < 1.0) {
        // Zoomed in: nearest frame (crisp time axis, as the old drawImage path).
        int f = int(clamp(floor(f0 + 0.5 * u_framesPerPx + 0.5), 0.0, float(u_frames - 1)));
        v = column(f, b0, b1);
    } else {
        int s = max(0, int(ceil(f0)));
        int e = min(u_frames - 1, int(ceil(f0 + u_framesPerPx)) - 1);
        int step = max(1, (e - s + ${MAX_TAPS}) / ${MAX_TAPS});
        v = -1e30;
        for (int f = s; f <= e; f += step) v = max(v, column(f, b0, b1));
    }
    float t = clamp((v - u_lo) * u_rcpRange, 0.0, 1.0);
    fragColor = texture(u_lut, vec2(t, 0.5));
}`;

export interface GpuViewParams {
    width: number;
    height: number;
    /** Frame index at the left edge of the first pixel column, and frames per pixel. */
    frame0: number;
    framesPerPx: number;
    /** Fractional bin at the top edge of the image, and bins per pixel downwards. */
    binTop: number;
    binsPerPx: number;
    /** dB window [lo, hi] → [black, white]. */
    lo: number;
    hi: number;
    /** Subtract the uploaded band floor. */
    useFloor: boolean;
}

export class GpuSpectrogramView {
    readonly canvas: HTMLCanvasElement;
    private gl: WebGL2RenderingContext | null;
    private prog: WebGLProgram | null = null;
    private u: Record<string, WebGLUniformLocation | null> = {};
    private dataTex: WebGLTexture | null = null;
    private floorTex: WebGLTexture | null = null;
    private lutTex: WebGLTexture | null = null;
    private lutFn: ((t: number) => { r: number; g: number; b: number }) | null = null;
    private lutKey: string | null = null;
    private bins = 0;
    private frames = 0;
    private dataRef: Float32Array | null = null;

    constructor() {
        this.canvas = document.createElement('canvas');
        this.gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: true });
        const gl = this.gl;
        if (!gl) return;
        const sh = (type: number, src: string) => {
            const s = gl.createShader(type)!;
            gl.shaderSource(s, src); gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
                console.warn('GpuSpectrogramView shader:', gl.getShaderInfoLog(s));
                return null;
            }
            return s;
        };
        const vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, FS);
        if (!vs || !fs) { this.gl = null; return; }
        const p = gl.createProgram()!;
        gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
        gl.deleteShader(vs); gl.deleteShader(fs);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { this.gl = null; return; }
        this.prog = p;
        for (const n of ['u_data', 'u_floor', 'u_lut', 'u_bins', 'u_frames', 'u_height', 'u_frame0', 'u_framesPerPx',
            'u_binTop', 'u_binsPerPx', 'u_useFloor', 'u_lo', 'u_rcpRange']) {
            this.u[n] = gl.getUniformLocation(p, n);
        }
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(p, 'a_pos');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        this.dataTex = this.texture();
        this.floorTex = this.texture();
        this.lutTex = this.texture(gl.LINEAR);
    }

    get ok(): boolean { return !!this.gl; }

    /** True when `data` is the array currently on the GPU. */
    holds(data: Float32Array): boolean { return this.dataRef === data; }

    private texture(filter?: number): WebGLTexture | null {
        const gl = this.gl!;
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        const f = filter ?? gl.NEAREST;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
    }

    /** Uploads row-major [frame][bin] dB values. False if too large or unsupported. */
    setData(data: Float32Array, frames: number, bins: number): boolean {
        const gl = this.gl;
        this.dataRef = null;
        if (!gl || bins <= 0 || frames <= 0 || frames * bins > MAX_VALUES) return false;
        const rows = Math.ceil(frames * bins / PACK_W);
        if (rows > gl.getParameter(gl.MAX_TEXTURE_SIZE)) return false;
        const packed = new Float32Array(rows * PACK_W);
        packed.set(data.subarray(0, frames * bins));
        gl.bindTexture(gl.TEXTURE_2D, this.dataTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, PACK_W, rows, 0, gl.RED, gl.FLOAT, packed);
        this.frames = frames;
        this.bins = bins;
        this.dataRef = data;
        this.setBandFloor(null);
        return true;
    }

    /** Per-band floor (dB) subtracted when `useFloor` is set; null → zeros. */
    setBandFloor(floor: ArrayLike<number> | null): void {
        const gl = this.gl;
        if (!gl || !this.bins) return;
        const v = new Float32Array(this.bins);
        if (floor && floor.length === this.bins) v.set(floor);
        gl.bindTexture(gl.TEXTURE_2D, this.floorTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, this.bins, 1, 0, gl.RED, gl.FLOAT, v);
    }

    /** 256-entry colour LUT; `key` identifies the scheme so it is built once. */
    setLut(key: string, colorAt: (t: number) => { r: number; g: number; b: number }): void {
        const gl = this.gl;
        if (!gl || (key === this.lutKey && colorAt === this.lutFn)) return;
        this.lutKey = key; this.lutFn = colorAt;
        const d = new Uint8Array(256 * 4);
        for (let i = 0; i < 256; i++) {
            const c = colorAt(i / 255);
            d.set([c.r, c.g, c.b, 255], i * 4);
        }
        gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, d);
    }

    /** Renders the view into `canvas` (sized width × height). */
    render(p: GpuViewParams): HTMLCanvasElement | null {
        const gl = this.gl;
        if (!gl || !this.prog || !this.dataRef || p.width <= 0 || p.height <= 0) return null;
        if (this.canvas.width !== p.width) this.canvas.width = p.width;
        if (this.canvas.height !== p.height) this.canvas.height = p.height;
        gl.viewport(0, 0, p.width, p.height);
        gl.useProgram(this.prog);
        const tex = (unit: number, t: WebGLTexture | null, name: string) => {
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.uniform1i(this.u[name], unit);
        };
        tex(0, this.dataTex, 'u_data');
        tex(1, this.floorTex, 'u_floor');
        tex(2, this.lutTex, 'u_lut');
        gl.uniform1i(this.u.u_bins, this.bins);
        gl.uniform1i(this.u.u_frames, this.frames);
        gl.uniform1f(this.u.u_height, p.height);
        gl.uniform1f(this.u.u_frame0, p.frame0);
        gl.uniform1f(this.u.u_framesPerPx, p.framesPerPx);
        gl.uniform1f(this.u.u_binTop, p.binTop);
        gl.uniform1f(this.u.u_binsPerPx, p.binsPerPx);
        gl.uniform1f(this.u.u_useFloor, p.useFloor ? 1 : 0);
        gl.uniform1f(this.u.u_lo, p.lo);
        gl.uniform1f(this.u.u_rcpRange, 1 / Math.max(1e-6, p.hi - p.lo));
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        return this.canvas;
    }

    dispose(): void {
        const gl = this.gl;
        if (!gl) return;
        for (const t of [this.dataTex, this.floorTex, this.lutTex]) if (t) gl.deleteTexture(t);
        if (this.prog) gl.deleteProgram(this.prog);
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        this.gl = null;
        this.dataRef = null;
    }
}
