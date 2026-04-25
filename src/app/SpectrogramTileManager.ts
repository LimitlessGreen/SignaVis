// ═══════════════════════════════════════════════════════════════════════
// SpectrogramTileManager.ts — tile-based lazy spectrogram rendering
//
// Divides a long audio file into fixed-time tiles (TILE_SECONDS each).
// Tiles are computed on demand, prioritised by proximity to the visible
// viewport, and evicted via LRU when TILE_MAX_IN_MEMORY is exceeded.
//
// Pipeline per tile:  DSP (worker)  →  grayscale  →  colorized canvas
//
// Events emitted:
//   'tileready'  — { detail: { idx } }  a tile finished and was colorized
// ═══════════════════════════════════════════════════════════════════════

import {
    buildSpectrogramGrayscale,
    colorizeSpectrogram,
    updateSpectrogramStats,
    drawTimeGrid,
    createSpectrogramProcessor,
} from '../domain/spectrogram.ts';

import {
    TILE_SECONDS,
    TILE_MAX_IN_MEMORY,
} from '../shared/constants.ts';

const TILE_PRELOAD_AHEAD = 2;

type TileState = 'idle' | 'computing' | 'ready' | 'error';

interface Tile {
    idx: number;
    state: TileState;
    data: Float32Array | null;
    nFrames: number;
    canvas: HTMLCanvasElement | null;
    canvasWidth: number;
    lastUsed: number;
}

export interface TileColorOptions {
    colorScheme: string;
    maxFreq: number;
    floor01: number;
    ceil01: number;
    noiseReduction: boolean;
    clahe: boolean;
    scale: string;
    colourScale: string;
}

export class SpectrogramTileManager extends EventTarget {
    private readonly channelData: Float32Array;
    private readonly sampleRate: number;
    private readonly totalDuration: number;
    readonly nMels: number;
    private readonly dspOptions: Record<string, any>;
    private colorOptions: TileColorOptions;

    readonly totalTiles: number;
    private readonly samplesPerTile: number;

    private tiles: Map<number, Tile>;
    private queue: number[];
    private isComputing: boolean;
    readonly processor: ReturnType<typeof createSpectrogramProcessor>;

    globalMin: number;
    globalMax: number;
    private tilesComputed: number;
    private disposed: boolean;

    constructor(params: {
        channelData: Float32Array;
        sampleRate: number;
        totalDuration: number;
        nMels: number;
        dspOptions: Record<string, any>;
        colorOptions: TileColorOptions;
    }) {
        super();
        this.channelData   = params.channelData;
        this.sampleRate    = params.sampleRate;
        this.totalDuration = params.totalDuration;
        this.nMels         = params.nMels;
        this.dspOptions    = params.dspOptions;
        this.colorOptions  = params.colorOptions;

        this.totalTiles    = Math.ceil(this.totalDuration / TILE_SECONDS);
        this.samplesPerTile = Math.floor(TILE_SECONDS * this.sampleRate);

        this.tiles         = new Map();
        this.queue         = [];
        this.isComputing   = false;
        this.processor     = createSpectrogramProcessor();

        this.globalMin     = 0;
        this.globalMax     = 1;
        this.tilesComputed = 0;
        this.disposed      = false;
    }

    get hasTiles(): boolean { return this.tilesComputed > 0; }

    firstReadyTileData(): Float32Array | null {
        for (const tile of this.tiles.values()) {
            if (tile.state === 'ready' && tile.data) return tile.data;
        }
        return null;
    }

    // ── Viewport scheduling ─────────────────────────────────────────

    requestViewport(startTime: number, endTime: number): void {
        if (this.disposed) return;

        const firstTile = Math.max(0, Math.floor(startTime / TILE_SECONDS));
        const lastTile  = Math.min(this.totalTiles - 1, Math.ceil(endTime / TILE_SECONDS));

        // Visible tiles first, then neighbors ahead and behind.
        const wanted: number[] = [];
        for (let i = firstTile; i <= lastTile; i++) wanted.push(i);
        for (let d = 1; d <= TILE_PRELOAD_AHEAD; d++) {
            if (firstTile - d >= 0) wanted.push(firstTile - d);
            if (lastTile + d < this.totalTiles) wanted.push(lastTile + d);
        }

        const inQueue = new Set(this.queue);
        for (const idx of wanted) {
            const tile = this.tiles.get(idx);
            if ((!tile || tile.state === 'idle' || tile.state === 'error') && !inQueue.has(idx)) {
                this.queue.unshift(idx); // prepend → visible tiles processed first
                inQueue.add(idx);
            }
        }

        this._evict(Math.floor((firstTile + lastTile) / 2));

        if (!this.isComputing) this._computeNext();
    }

    // ── Color options ───────────────────────────────────────────────

    updateColorOptions(opts: TileColorOptions): void {
        this.colorOptions = opts;
        for (const tile of this.tiles.values()) {
            if (tile.state === 'ready' && tile.data) this._colorize(tile);
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
        const tileDisplayWidth = (TILE_SECONDS / duration) * totalDisplayWidth;

        for (let i = 0; i < this.totalTiles; i++) {
            const tile = this.tiles.get(i);
            if (!tile || tile.state !== 'ready' || !tile.canvas) continue;

            // Tile boundaries in viewport-relative display pixels.
            const tileDstX0 = i * tileDisplayWidth - scrollLeft;
            const tileEndTime = Math.min((i + 1) * TILE_SECONDS, duration);
            const tileDstX1 = (tileEndTime / duration) * totalDisplayWidth - scrollLeft;

            if (tileDstX1 <= 0 || tileDstX0 >= viewportWidth) continue;

            tile.lastUsed = Date.now();

            // Snap to integer pixels to prevent sub-pixel gaps between adjacent tiles.
            const visLeft  = Math.floor(Math.max(0, tileDstX0));
            const visRight = Math.ceil(Math.min(viewportWidth, tileDstX1));
            if (visRight <= visLeft) continue;

            const tileDispW = tileDstX1 - tileDstX0;
            const frac0 = (visLeft - tileDstX0) / tileDispW;
            const frac1 = (visRight - tileDstX0) / tileDispW;

            const srcX = frac0 * tile.canvasWidth;
            const srcW = Math.max(1, (frac1 - frac0) * tile.canvasWidth);
            const srcY = freqViewSrcCrop?.srcY ?? 0;
            const srcH = freqViewSrcCrop?.srcH ?? tile.canvas.height;
            const dstW = visRight - visLeft;

            ctx.imageSmoothingEnabled = tileDispW < tile.canvasWidth; // smooth only when shrinking
            ctx.drawImage(tile.canvas, srcX, srcY, srcW, srcH, visLeft, 0, dstW, canvasHeight);
        }

        drawTimeGrid({
            ctx,
            width: viewportWidth,
            height: canvasHeight,
            duration,
            pixelsPerSecond: totalDisplayWidth / duration,
            scrollLeft,
        });
    }

    // ── Synchronous first-tile computation (for auto-adjust) ────────

    async computeFirstTile(): Promise<void> {
        if (this.tilesComputed > 0 || this.disposed) return;
        await this._computeTile(0);
    }

    // Enqueue all tiles for background computation (lowest priority).
    // Call after computeFirstTile() so tile 0 is already done.
    queueAllTiles(): void {
        if (this.disposed) return;
        const inQueue = new Set(this.queue);
        for (let i = 0; i < this.totalTiles; i++) {
            const tile = this.tiles.get(i);
            if ((!tile || tile.state === 'idle' || tile.state === 'error') && !inQueue.has(i)) {
                this.queue.push(i); // append = lower priority than viewport tiles
                inQueue.add(i);
            }
        }
        if (!this.isComputing) this._computeNext();
    }

    // ── Invalidate (DSP settings changed) ──────────────────────────

    invalidate(): void {
        this.tiles.clear();
        this.queue         = [];
        this.tilesComputed = 0;
        this.globalMin     = 0;
        this.globalMax     = 1;
    }

    dispose(): void {
        this.disposed = true;
        this.processor.dispose();
        this.tiles.clear();
        this.queue = [];
    }

    // ── Private ─────────────────────────────────────────────────────

    private async _computeNext(): Promise<void> {
        if (this.disposed || this.queue.length === 0) {
            this.isComputing = false;
            return;
        }

        let idx: number | undefined;
        while (this.queue.length > 0) {
            const candidate = this.queue.shift()!;
            const existing = this.tiles.get(candidate);
            if (!existing || existing.state === 'idle' || existing.state === 'error') {
                idx = candidate;
                break;
            }
        }

        if (idx === undefined) {
            this.isComputing = false;
            return;
        }

        this.isComputing = true;
        await this._computeTile(idx);
        this._computeNext();
    }

    private async _computeTile(idx: number): Promise<void> {
        const tile: Tile = {
            idx, state: 'computing', data: null, nFrames: 0,
            canvas: null, canvasWidth: 0, lastUsed: Date.now(),
        };
        this.tiles.set(idx, tile);

        try {
            const startSample   = idx * this.samplesPerTile;
            const overlapSamples = this.dspOptions.windowSize || 2048;
            const actualStart   = idx === 0 ? startSample : Math.max(0, startSample - overlapSamples);
            const endSample     = Math.min(this.channelData.length, (idx + 1) * this.samplesPerTile);

            const chunkData = this.channelData.subarray(actualStart, endSample);
            const result    = await this.processor.compute(chunkData, this.dspOptions);

            if (this.disposed) return;

            let { data, nFrames } = result;

            // Trim the overlap frames prepended at tile boundaries.
            if (actualStart < startSample) {
                const hop = result.hopSize || 1;
                const overlapFrames = Math.min(nFrames - 1, Math.ceil((startSample - actualStart) / hop));
                if (overlapFrames > 0) {
                    data = data.slice(overlapFrames * result.nMels);
                    nFrames -= overlapFrames;
                }
            }

            tile.data   = data;
            tile.nFrames = nFrames;
            tile.state  = 'ready';

            const rangeChanged = this._updateGlobalStats(data);
            this.tilesComputed++;

            // Re-colorize existing tiles if the global normalization range widened.
            if (rangeChanged) {
                for (const t of this.tiles.values()) {
                    if (t !== tile && t.state === 'ready' && t.data) this._colorize(t);
                }
            }

            this._colorize(tile);
            this.dispatchEvent(new CustomEvent('tileready', { detail: { idx } }));
        } catch (err) {
            if (!this.disposed) {
                tile.state = 'error';
                console.warn(`SpectrogramTileManager: tile ${idx} failed:`, err);
            }
        }
    }

    private _colorize(tile: Tile): void {
        if (!tile.data || tile.nFrames <= 0) return;
        const opts = this.colorOptions;

        const grayInfo = buildSpectrogramGrayscale({
            spectrogramData:      tile.data,
            spectrogramFrames:    tile.nFrames,
            spectrogramMels:      this.nMels,
            sampleRateHz:         this.sampleRate,
            maxFreq:              opts.maxFreq,
            spectrogramAbsLogMin: this.globalMin,
            spectrogramAbsLogMax: this.globalMax,
            scale:                opts.scale,
            colourScale:          opts.colourScale,
            noiseReduction:       opts.noiseReduction,
            clahe:                opts.clahe,
        });

        if (!grayInfo) return;

        const canvas = colorizeSpectrogram(grayInfo, opts.floor01, opts.ceil01, opts.colorScheme);
        if (!canvas) return;

        tile.canvas      = canvas;
        tile.canvasWidth = grayInfo.width;
    }

    // Returns true if the global [min, max] range changed (triggers re-colorization).
    private _updateGlobalStats(data: Float32Array): boolean {
        const { logMin, logMax } = updateSpectrogramStats(data);

        const prevMin = this.globalMin;
        const prevMax = this.globalMax;

        if (this.tilesComputed === 0) {
            this.globalMin = logMin;
            this.globalMax = logMax;
        } else {
            if (logMin < this.globalMin) this.globalMin = logMin;
            if (logMax > this.globalMax) this.globalMax = logMax;
        }

        return (
            Math.abs(this.globalMin - prevMin) > 1e-4 ||
            Math.abs(this.globalMax - prevMax) > 1e-4
        );
    }

    private _evict(centerIdx: number): void {
        if (this.tiles.size <= TILE_MAX_IN_MEMORY) return;

        const candidates = [...this.tiles.values()]
            .filter(t => t.state === 'ready')
            .sort((a, b) => Math.abs(b.idx - centerIdx) - Math.abs(a.idx - centerIdx));

        while (this.tiles.size > TILE_MAX_IN_MEMORY && candidates.length > 0) {
            this.tiles.delete(candidates.pop()!.idx);
        }
    }
}
