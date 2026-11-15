// ═══════════════════════════════════════════════════════════════════════
// live-spectrogram-view.ts — spectrogram of a recording in progress
//
// Covers the player's spectrogram pane while LiveRecorder runs: each frame
// the newest spectrum (AnalyserNode) is added at the right edge and the
// image moves left, so the sound flies in from the right (idea from the
// BirdNET website demo's live view). A chip shows the elapsed time, the
// limit and a Stop button.
//
// Events: 'stoprequest' — the Stop button was pressed.
// ═══════════════════════════════════════════════════════════════════════

import { getSpectrogramColor } from '../../../domain/spectrogram.ts';
import { formatTime } from '../../../shared/utils.ts';
import type { LiveRecorder } from '../../../infrastructure/audio/LiveRecorder.ts';

export interface LiveSpectrogramViewOptions {
    /** Seconds across the view (default 20). */
    spanSeconds?: number;
    getColorScheme?: () => string;
    /** Top of the frequency axis in Hz; 0 → Nyquist. */
    getMaxFreq?: () => number;
    /** dB mapped to black / white (AnalyserNode dBFS). */
    minDb?: number;
    maxDb?: number;
}

export class LiveSpectrogramView extends EventTarget {
    private readonly host: HTMLElement;
    private readonly opts: Required<LiveSpectrogramViewOptions>;
    private root: HTMLDivElement | null = null;
    private canvas: HTMLCanvasElement | null = null;
    private ctx: CanvasRenderingContext2D | null = null;
    private timeEl: HTMLElement | null = null;
    private freqEl: HTMLElement | null = null;
    private recorder: LiveRecorder | null = null;
    private raf = 0;
    private drawnPx = 0;
    private lut: Uint8ClampedArray | null = null;
    private lutScheme = '';
    private spectrum: Float32Array | null = null;
    private resizeObserver: ResizeObserver | null = null;

    constructor(host: HTMLElement, opts: LiveSpectrogramViewOptions = {}) {
        super();
        this.host = host;
        this.opts = {
            spanSeconds: opts.spanSeconds ?? 20,
            getColorScheme: opts.getColorScheme ?? (() => 'inferno'),
            getMaxFreq: opts.getMaxFreq ?? (() => 0),
            minDb: opts.minDb ?? -110,
            maxDb: opts.maxDb ?? -30,
        };
    }

    get attached(): boolean { return !!this.recorder; }

    attach(recorder: LiveRecorder): void {
        this.detach();
        this.recorder = recorder;
        const root = document.createElement('div');
        root.className = 'live-view';
        root.innerHTML = `
            <canvas class="live-view-canvas" aria-label="Live spectrogram of the recording"></canvas>
            <div class="live-view-chip" role="status" aria-live="off">
                <span class="live-view-dot" aria-hidden="true"></span>
                <span class="live-view-rec">REC</span>
                <span class="live-view-time">0:00</span>
                <span class="live-view-freq"></span>
                <button type="button" class="live-view-stop" title="Stop recording and open it">■ Stop</button>
            </div>`;
        this.host.appendChild(root);
        this.root = root;
        this.canvas = root.querySelector('canvas');
        this.ctx = this.canvas!.getContext('2d');
        this.timeEl = root.querySelector('.live-view-time');
        this.freqEl = root.querySelector('.live-view-freq');
        root.querySelector('.live-view-stop')!.addEventListener('click', (e) => {
            e.stopPropagation();
            this.dispatchEvent(new CustomEvent('stoprequest'));
        });
        // Keep pointer input away from the player below.
        root.addEventListener('pointerdown', (e) => e.stopPropagation());
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(root);
        this.resize();
        this.drawnPx = 0;
        const loop = () => {
            this.frame();
            this.raf = requestAnimationFrame(loop);
        };
        this.raf = requestAnimationFrame(loop);
    }

    detach(): void {
        cancelAnimationFrame(this.raf);
        this.raf = 0;
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.root?.remove();
        this.root = null;
        this.canvas = null;
        this.ctx = null;
        this.recorder = null;
        this.spectrum = null;
    }

    private resize(): void {
        const c = this.canvas, root = this.root;
        if (!c || !root) return;
        const w = Math.max(1, Math.floor(root.clientWidth));
        const h = Math.max(1, Math.floor(root.clientHeight));
        if (c.width === w && c.height === h) return;
        // The view always spans the same seconds: scale what is drawn to the new size
        // and continue from the current time at the new pixels per second.
        const old = c.width > 1 && c.height > 1 ? this.snapshot(c) : null;
        c.width = w;
        c.height = h;
        const ctx = this.ctx!;
        ctx.fillStyle = this.color(0);
        ctx.fillRect(0, 0, w, h);
        if (old) ctx.drawImage(old, 0, 0, w, h);
        if (this.recorder) this.drawnPx = Math.floor(this.recorder.elapsed * w / this.opts.spanSeconds);
    }

    private snapshot(c: HTMLCanvasElement): HTMLCanvasElement {
        const s = document.createElement('canvas');
        s.width = c.width; s.height = c.height;
        s.getContext('2d')?.drawImage(c, 0, 0);
        return s;
    }

    private ensureLut(): Uint8ClampedArray {
        const scheme = this.opts.getColorScheme();
        if (this.lut && this.lutScheme === scheme) return this.lut;
        const lut = new Uint8ClampedArray(256 * 3);
        for (let i = 0; i < 256; i++) {
            const { r, g, b } = getSpectrogramColor(i / 255, scheme);
            lut[i * 3] = r; lut[i * 3 + 1] = g; lut[i * 3 + 2] = b;
        }
        this.lut = lut;
        this.lutScheme = scheme;
        return lut;
    }

    private color(v: number): string {
        const lut = this.ensureLut();
        const i = Math.max(0, Math.min(255, Math.round(v * 255))) * 3;
        return `rgb(${lut[i]},${lut[i + 1]},${lut[i + 2]})`;
    }

    private frame(): void {
        const rec = this.recorder, c = this.canvas, ctx = this.ctx;
        if (!rec || !c || !ctx) return;
        const elapsed = rec.elapsed;
        if (this.timeEl) this.timeEl.textContent = `${formatTime(elapsed)} / ${formatTime(rec.maxSeconds)}`;
        const an = rec.analyser;
        if (!an || !rec.recording) return;
        const nyquist = rec.sampleRate / 2;
        const maxFreq = Math.min(nyquist, this.opts.getMaxFreq() || nyquist);
        if (this.freqEl) this.freqEl.textContent = `0–${(maxFreq / 1000).toFixed(maxFreq < 10000 ? 1 : 0)} kHz`;

        const pxPerSec = c.width / this.opts.spanSeconds;
        const target = Math.floor(elapsed * pxPerSec);
        let n = target - this.drawnPx;
        if (n <= 0) return;
        if (n > c.width) { this.drawnPx = target - c.width; n = c.width; }
        this.drawnPx += n;

        const bins = an.frequencyBinCount;
        if (!this.spectrum || this.spectrum.length !== bins) this.spectrum = new Float32Array(bins);
        an.getFloatFrequencyData(this.spectrum as Float32Array<ArrayBuffer>);

        const h = c.height;
        const lut = this.ensureLut();
        const { minDb, maxDb } = this.opts;
        const col = ctx.createImageData(1, h);
        const px = col.data;
        for (let y = 0; y < h; y++) {
            const f = (1 - (y + 0.5) / h) * maxFreq;
            const bin = Math.min(bins - 1, Math.max(0, Math.round(f / nyquist * bins)));
            const v = (this.spectrum[bin] - minDb) / (maxDb - minDb);
            const i = Math.max(0, Math.min(255, Math.round((Number.isFinite(v) ? v : 0) * 255))) * 3;
            const o = y * 4;
            px[o] = lut[i]; px[o + 1] = lut[i + 1]; px[o + 2] = lut[i + 2]; px[o + 3] = 255;
        }
        // Move the image left by n pixels, then fill the new columns with the newest spectrum.
        ctx.drawImage(c, n, 0, c.width - n, h, 0, 0, c.width - n, h);
        for (let x = c.width - n; x < c.width; x++) ctx.putImageData(col, x, 0);
    }
}
