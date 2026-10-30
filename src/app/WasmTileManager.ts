// ═══════════════════════════════════════════════════════════════════════
// WasmTileManager.ts — tiled rendering on top of the WASM pyramid
//
// The whole file is computed once by WasmSpectrogramService (Rust/WASM,
// multi-worker, cached in OPFS) into a max-pooled level pyramid. This class
// only fetches the frames visible at the current zoom, picking the coarsest
// level that still has ≥ 1 frame per display pixel, and colorizes them.
//
// Same public surface as SpectrogramTileManager so SpectrogramController can
// treat both alike.
//
// Events emitted:
//   'tileready'  — a tile finished and was colorized
// ═══════════════════════════════════════════════════════════════════════

import {
    buildSpectrogramGrayscale,
    colorizeSpectrogram,
    drawTimeGrid,
} from '../domain/spectrogram.ts';
// Type-only: the service pulls in Vite worker/wasm imports, so it is loaded lazily in create().
import type {
    WasmSpectrogramService,
    WasmSpecParams,
    StftParamsV2,
    AnySpecParams,
    PyramidMeta,
} from '../infrastructure/wasm-dsp/WasmSpectrogramService.ts';
import type { TileColorOptions } from './SpectrogramTileManager.ts';
import { CQT_FMIN, CQT_BINS_PER_OCTAVE } from '../shared/constants.ts';

const TILE_FRAMES = 1024;          // frames of the chosen level per tile
const TILE_MAX_IN_MEMORY = 48;     // LRU limit across all levels
const TILE_PRELOAD_AHEAD = 1;

interface Tile {
    key: string;
    level: number;
    idx: number;
    state: 'computing' | 'ready' | 'error';
    data: Float32Array | null;
    nFrames: number;
    canvas: HTMLCanvasElement | null;
    lastUsed: number;
}

/** DSP options as built by SpectrogramController.generate(). */
export function wasmParamsFromDspOptions(o: Record<string, any>): WasmSpecParams | null {
    if (o.scale !== 'mel' && o.scale !== 'linear') return null;
    const windows = ['hann', 'hamming', 'blackman', 'blackmanHarris'];
    if (!windows.includes(o.windowFunction || 'hann')) return null;
    return {
        fftSize:   o.fftSize,
        hopSize:   o.hopSize || 0,
        winLength: o.windowSize || 0,
        nMels:     o.nMels,
        scale:     o.scale,
        window:    o.windowFunction || 'hann',
        pcen: o.usePcen
            ? { gain: o.pcenGain, bias: o.pcenBias, root: o.pcenRoot, smoothing: o.pcenSmoothing }
            : null,
    };
}

/**
 * v2 engine params (dBFS / PCEN, centred frames) from the same DSP options.
 * Returns null for modes v2 does not produce (phase, raw-magnitude scales).
 * 'cqt' maps to v2 log bands whose centres equal buildCQTFrequencies(), so the
 * existing axis stays exact.
 */
export function wasmV2ParamsFromDspOptions(o: Record<string, any>): StftParamsV2 | null {
    if (o.scale !== 'mel' && o.scale !== 'linear' && o.scale !== 'cqt') return null;
    if (o.colourScale && o.colourScale !== 'dbSquared' && o.colourScale !== 'db') return null;
    const winLen = o.windowSize || 0;
    const nFft = Math.max(o.fftSize || 0, winLen);
    if (!winLen || !o.hopSize) return null;
    const fn = o.windowFunction || 'hann';
    const window = fn === 'kaiser' ? { kind: 'kaiser' as const, beta: 6 }
        : ['hann', 'hamming', 'blackman', 'blackmanHarris'].includes(fn) ? { kind: fn } : null;
    if (!window) return null;
    const reassign = !!o.reassigned;
    return {
        winLen, hop: o.hopSize, nFft,
        window: window as StftParamsV2['window'],
        // fMax 0 → Nyquist (resolved in the worker).
        scale: o.scale === 'linear' ? { kind: 'linear' }
            : o.scale === 'cqt' ? logBandsForCqtAxis(o.nMels)
            : { kind: 'mel', bands: o.nMels, fMin: 0, fMax: 0 },
        // Reassignment and PCEN are exclusive; reassignment wins when both are set.
        pcen: o.usePcen && !reassign
            ? { gain: o.pcenGain, bias: o.pcenBias, power: 1 / (o.pcenRoot || 2), eps: 1e-6, timeConstant: o.pcenTimeConstant }
            : null,
        reassign,
    };
}

/** v2 log edges are geometric over bands + 1 steps with centres at edges[1..=bands];
 *  shifting f_min one step down puts centre k at CQT_FMIN · 2^(k / CQT_BINS_PER_OCTAVE). */
function logBandsForCqtAxis(bands: number): StftParamsV2['scale'] {
    const step = Math.pow(2, 1 / CQT_BINS_PER_OCTAVE);
    const fMin = CQT_FMIN / step;
    return { kind: 'log', bands, fMin, fMax: fMin * Math.pow(step, bands + 1) };
}

/**
 * Centre frequency (Hz) of each v2 output row, low → high. Same formulas as
 * aw_dsp::v2 `StftParams::bin_frequencies` (checked against WASM in tests), so the
 * axis can be built without a worker round trip. fMax 0 → Nyquist, as in the worker.
 */
export function v2BinFrequencies(p: StftParamsV2, sampleRate: number): Float64Array {
    const s = p.scale;
    if (s.kind === 'linear') {
        const n = (p.nFft >> 1) + 1;
        return Float64Array.from({ length: n }, (_, k) => k * sampleRate / p.nFft);
    }
    const fMax = s.fMax > 0 ? s.fMax : sampleRate / 2;
    const [fwd, inv] = s.kind === 'mel'
        ? [(hz: number) => 2595 * Math.log10(1 + hz / 700), (m: number) => 700 * (Math.pow(10, m / 2595) - 1)]
        : [Math.log, Math.exp];
    const a = fwd(s.fMin), b = fwd(fMax);
    // Edges at i / (bands + 1), i = 0 … bands + 1; centres are edges 1 … bands.
    return Float64Array.from({ length: s.bands }, (_, i) => inv(a + (b - a) * (i + 1) / (s.bands + 1)));
}

const isV2 = (p: AnySpecParams): p is StftParamsV2 => typeof (p as StftParamsV2).winLen === 'number';

/** Any source qualifies: WAV files are read directly, everything else via pcmWavBlob(). */
export function isWasmTileSource(file: File | null): file is File {
    return !!file && typeof WebAssembly !== 'undefined' && typeof Worker !== 'undefined';
}

/** True for a real WAV file whose bytes can be read directly (not a URL placeholder). */
export function isWavFile(file: File): boolean {
    return file.size > 0 && (/\.wav$/i.test(file.name) || /wav/i.test(file.type));
}

/**
 * Wraps already-decoded PCM (e.g. from an MP3) as a mono 32-bit float WAV so
 * the WASM pipeline can slice it like a WAV file. Limited to < 4 GiB of data
 * (~6 h at 48 kHz).
 */
export function pcmWavBlob(channelData: Float32Array, sampleRate: number): Blob {
    const dataBytes = channelData.byteLength;
    const h = new DataView(new ArrayBuffer(44));
    const tag = (at: number, s: string) => { for (let i = 0; i < 4; i++) h.setUint8(at + i, s.charCodeAt(i)); };
    tag(0, 'RIFF'); h.setUint32(4, 36 + dataBytes, true); tag(8, 'WAVE');
    tag(12, 'fmt '); h.setUint32(16, 16, true);
    h.setUint16(20, 3, true);                 // WAVE_FORMAT_IEEE_FLOAT
    h.setUint16(22, 1, true);                 // mono
    h.setUint32(24, sampleRate, true);
    h.setUint32(28, sampleRate * 4, true);    // byte rate
    h.setUint16(32, 4, true);                 // block align
    h.setUint16(34, 32, true);                // bits per sample
    tag(36, 'data'); h.setUint32(40, dataBytes, true);
    return new Blob([h.buffer, channelData as Float32Array<ArrayBuffer>]);
}

export class WasmTileManager extends EventTarget {
    readonly nMels: number;
    readonly meta: PyramidMeta;
    readonly fromCache: boolean;
    private readonly svc: WasmSpectrogramService;
    private readonly duration: number;
    private readonly frameSec: number;       // seconds per level-0 frame
    private colorOptions: TileColorOptions;

    private tiles = new Map<string, Tile>();
    private queue: Tile[] = [];
    private isComputing = false;
    private disposed = false;
    private tilesComputed = 0;

    globalMin: number;
    globalMax: number;

    /** Computes (or loads from OPFS) the pyramid for `file`. */
    static async create(params: {
        file: File;
        /** Data actually read by the workers; defaults to `file` (cache key stays `file`). */
        source?: Blob;
        wasmParams: AnySpecParams;
        duration: number;
        colorOptions: TileColorOptions;
        onProgress?: (fraction: number) => void;
    }): Promise<WasmTileManager> {
        const { WasmSpectrogramService } = await import('../infrastructure/wasm-dsp/WasmSpectrogramService.ts');
        const svc = await WasmSpectrogramService.create();
        try {
            const { meta, fromCache } = await svc.open(params.file, params.wasmParams,
                (f) => params.onProgress?.(f), params.source);
            return new WasmTileManager(svc, meta, fromCache, params.duration, params.colorOptions);
        } catch (err) {
            svc.dispose();
            throw err;
        }
    }

    private constructor(svc: WasmSpectrogramService, meta: PyramidMeta, fromCache: boolean,
                        duration: number, colorOptions: TileColorOptions) {
        super();
        this.svc = svc;
        this.meta = meta;
        this.fromCache = fromCache;
        this.nMels = meta.bins;
        this.duration = duration;
        this.v2 = isV2(meta.params);
        this.frameSec = this.hopSize / meta.params.sampleRate;
        this.colorOptions = colorOptions;
        // Level-0 range of the whole file: stable, so tiles never need re-colorizing.
        // v2 (dBFS / PCEN): black point at the median — the noise floor of sparse
        // recordings such as bird song — instead of the minimum, which leaves
        // the background mid-grey.
        [this.globalMin, this.globalMax] = this.contrastRange(0);
    }

    /** v2 stores use centred frames (frame i at i·hop) and noise-floor contrast. */
    private readonly v2: boolean;

    /** Black/white points come from the noise floor (median) and p99.9. */
    get noiseFloorContrast(): boolean { return this.v2; }

    /** Black/white point for tiles of `level` (max-pooled levels are brighter). */
    private contrastRange(level: number): [number, number] {
        const st = this.meta.levels[level]?.stats ?? this.meta.stats;
        if (this.v2 && st.median !== undefined && st.p999 !== undefined && st.p999 > st.median) {
            return [st.median, st.p999];
        }
        return [this.meta.stats.min, this.meta.stats.max];
    }

    get hasTiles(): boolean { return this.tilesComputed > 0; }
    /** Row centre frequencies for v2 pyramids, null for v1 (legacy axis formulas). */
    get binFreqs(): Float64Array | null {
        const p = this.meta.params;
        if (this._binFreqs === undefined) this._binFreqs = isV2(p) ? v2BinFrequencies(p, p.sampleRate) : null;
        return this._binFreqs;
    }
    private _binFreqs: Float64Array | null | undefined;
    get hopSize(): number {
        const p = this.meta.params;
        return isV2(p) ? p.hop : (p as WasmSpecParams).hopSize;
    }
    get winLength(): number {
        const p = this.meta.params;
        return isV2(p) ? p.winLen : (p as WasmSpecParams).winLength;
    }

    firstReadyTileData(): Float32Array | null {
        for (const tile of this.tiles.values()) {
            if (tile.level === 0 && tile.state === 'ready' && tile.data) return tile.data;
        }
        return null;
    }

    // ── Level / tile geometry ───────────────────────────────────────

    /** Coarsest level with at least one frame per display pixel. */
    levelFor(pixelsPerSecond: number): number {
        const framesPerPx = 1 / (this.frameSec * pixelsPerSecond);
        let best = 0;
        this.meta.levels.forEach((l, i) => { if (l.factor <= framesPerPx) best = i; });
        return best;
    }

    private tileSeconds(level: number): number {
        return TILE_FRAMES * this.meta.levels[level].factor * this.frameSec;
    }

    private tileCount(level: number): number {
        return Math.ceil(this.meta.levels[level].nFrames / TILE_FRAMES);
    }

    private ensureTile(level: number, idx: number): Tile {
        const key = `${level}:${idx}`;
        let tile = this.tiles.get(key);
        if (!tile) {
            tile = { key, level, idx, state: 'computing', data: null, nFrames: 0, canvas: null, lastUsed: Date.now() };
            this.tiles.set(key, tile);
            this.queue.push(tile);
        }
        return tile;
    }

    // ── Viewport scheduling ─────────────────────────────────────────

    requestViewport(startTime: number, endTime: number, pixelsPerSecond: number): void {
        if (this.disposed) return;
        const level = this.levelFor(pixelsPerSecond);
        const ts = this.tileSeconds(level);
        const n = this.tileCount(level);
        const first = Math.max(0, Math.floor(startTime / ts) - TILE_PRELOAD_AHEAD);
        const last = Math.min(n - 1, Math.floor(endTime / ts) + TILE_PRELOAD_AHEAD);

        // Only what is wanted now stays queued; stale requests from old zoom levels are dropped.
        const wanted = new Set<string>();
        const pending: Tile[] = [];
        for (let i = first; i <= last; i++) {
            const tile = this.ensureTile(level, i);
            wanted.add(tile.key);
            if (tile.state === 'error') { tile.state = 'computing'; pending.push(tile); }
        }
        for (const tile of this.queue) {
            if (!wanted.has(tile.key)) this.tiles.delete(tile.key);
        }
        this.queue = this.queue.filter(t => wanted.has(t.key)).concat(pending);

        this._evict(wanted);
        if (!this.isComputing) this._computeNext();
    }

    // ── Color options ───────────────────────────────────────────────

    updateColorOptions(opts: TileColorOptions): void {
        this.colorOptions = opts;
        for (const tile of this.tiles.values()) {
            if (tile.state === 'ready') this._colorize(tile);
        }
        this.dispatchEvent(new CustomEvent('tileready'));
    }

    // ── Rendering ───────────────────────────────────────────────────

    renderToCanvas(
        ctx: CanvasRenderingContext2D,
        params: {
            duration: number;
            totalDisplayWidth: number;
            canvasHeight: number;
            scrollLeft: number;
            viewportWidth: number;
            freqViewSrcCrop: { srcY: number; srcH: number } | null;
        },
    ): void {
        const { duration, totalDisplayWidth, canvasHeight, scrollLeft, viewportWidth, freqViewSrcCrop } = params;
        const pps = totalDisplayWidth / duration;
        const target = this.levelFor(pps);

        // Coarser/finer levels first as placeholders, the target level on top.
        const levels = [...new Set([...this.tiles.values()].map(t => t.level))]
            .sort((a, b) => Math.abs(b - target) - Math.abs(a - target));

        for (const level of levels) {
            const frameSec = this.meta.levels[level].factor * this.frameSec;
            for (const tile of this.tiles.values()) {
                if (tile.level !== level || tile.state !== 'ready' || !tile.canvas) continue;
                // Centred frames: level-0 frame i covers [(i − ½)·hop, (i + ½)·hop).
                const t0 = tile.idx * TILE_FRAMES * frameSec - (this.v2 ? this.frameSec / 2 : 0);
                const x0 = t0 * pps - scrollLeft;
                const x1 = (t0 + tile.nFrames * frameSec) * pps - scrollLeft;
                if (x1 <= 0 || x0 >= viewportWidth) continue;
                tile.lastUsed = Date.now();

                // Snap to integer pixels to prevent sub-pixel gaps between adjacent tiles.
                const visLeft = Math.floor(Math.max(0, x0));
                const visRight = Math.ceil(Math.min(viewportWidth, x1));
                if (visRight <= visLeft) continue;

                const w = tile.canvas.width;
                const srcX = ((visLeft - x0) / (x1 - x0)) * w;
                const srcW = Math.max(1, ((visRight - visLeft) / (x1 - x0)) * w);
                const srcY = freqViewSrcCrop?.srcY ?? 0;
                const srcH = freqViewSrcCrop?.srcH ?? tile.canvas.height;

                ctx.imageSmoothingEnabled = x1 - x0 < w; // smooth only when shrinking
                ctx.drawImage(tile.canvas, srcX, srcY, srcW, srcH, visLeft, 0, visRight - visLeft, canvasHeight);
            }
        }

        drawTimeGrid({ ctx, width: viewportWidth, height: canvasHeight, duration, pixelsPerSecond: pps, scrollLeft });
    }

    async computeFirstTile(): Promise<void> {
        if (this.tilesComputed > 0 || this.disposed) return;
        const tile = this.ensureTile(0, 0);
        this.queue = this.queue.filter(t => t !== tile);
        await this._computeTile(tile);
    }

    /** No-op: the pyramid is complete after create(). */
    queueAllTiles(): void {}

    invalidate(): void {
        this.tiles.clear();
        this.queue = [];
        this.tilesComputed = 0;
    }

    dispose(): void {
        this.disposed = true;
        this.svc.dispose();
        this.tiles.clear();
        this.queue = [];
    }

    // ── Private ─────────────────────────────────────────────────────

    private async _computeNext(): Promise<void> {
        const tile = this.queue.shift();
        if (this.disposed || !tile) {
            this.isComputing = false;
            return;
        }
        this.isComputing = true;
        await this._computeTile(tile);
        this._computeNext();
    }

    private async _computeTile(tile: Tile): Promise<void> {
        try {
            const nTotal = this.meta.levels[tile.level].nFrames;
            const f0 = tile.idx * TILE_FRAMES;
            const f1 = Math.min(nTotal, f0 + TILE_FRAMES);
            const data = await this.svc.tile(tile.level, f0, f1);
            if (this.disposed || this.tiles.get(tile.key) !== tile) return;
            tile.data = data;
            tile.nFrames = f1 - f0;
            tile.state = 'ready';
            this.tilesComputed++;
            this._colorize(tile);
            this.dispatchEvent(new CustomEvent('tileready', { detail: { key: tile.key } }));
        } catch (err) {
            if (!this.disposed) {
                tile.state = 'error';
                console.warn(`WasmTileManager: tile ${tile.key} failed:`, err);
            }
        }
    }

    private _colorize(tile: Tile): void {
        if (!tile.data || tile.nFrames <= 0) return;
        const opts = this.colorOptions;
        // v2 + dB sliders: one window [noise + floor, noise + floor + range] in dB.
        // Each level uses its own noise floor (max pooling raises it).
        const dbWindow = this.v2 && opts.floorDb !== undefined && opts.rangeDb !== undefined;
        let [lo, hi] = this.v2 ? this.contrastRange(tile.level) : [this.globalMin, this.globalMax];
        if (dbWindow) {
            lo = (opts.noiseReduction ? 0 : lo) + opts.floorDb!;
            hi = lo + opts.rangeDb!;
        }
        const grayInfo = buildSpectrogramGrayscale({
            spectrogramData:      tile.data,
            spectrogramFrames:    tile.nFrames,
            spectrogramMels:      this.nMels,
            sampleRateHz:         this.meta.params.sampleRate,
            maxFreq:              opts.maxFreq,
            spectrogramAbsLogMin: lo,
            spectrogramAbsLogMax: hi,
            scale:                opts.scale,
            binFreqs:             this.binFreqs,
            colourScale:          opts.colourScale,
            noiseReduction:       opts.noiseReduction,
            bandFloor:            this.meta.levels[tile.level]?.stats.bandFloor ?? null,
            clahe:                opts.clahe,
        });
        if (!grayInfo) return;
        const canvas = dbWindow
            ? colorizeSpectrogram(grayInfo, 0, 1, opts.colorScheme)
            : colorizeSpectrogram(grayInfo, opts.floor01, opts.ceil01, opts.colorScheme);
        if (canvas) tile.canvas = canvas as HTMLCanvasElement;
    }

    private _evict(keep: Set<string>): void {
        if (this.tiles.size <= TILE_MAX_IN_MEMORY) return;
        const candidates = [...this.tiles.values()]
            .filter(t => t.state === 'ready' && !keep.has(t.key))
            .sort((a, b) => b.lastUsed - a.lastUsed);
        while (this.tiles.size > TILE_MAX_IN_MEMORY && candidates.length > 0) {
            this.tiles.delete(candidates.pop()!.key);
        }
    }
}
