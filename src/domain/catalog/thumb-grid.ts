// ═══════════════════════════════════════════════════════════════════════
// domain/catalog/thumb-grid.ts — layout, keyboard moves and colours for the
// library's tile grid (spectrogram thumbnails). Pure functions, no DOM.
// ═══════════════════════════════════════════════════════════════════════

export interface ThumbSpec { w: number; h: number; maxHz: number }
export interface Thumb { recordingId: number; w: number; h: number; maxHz: number; data: number[] }
export interface ThumbResult { recordingId: number; thumb: Thumb | null; error: string | null }

export interface GridWindow {
    /** Tiles per row (at least 1). */
    cols: number;
    /** Height of the whole grid (px). */
    height: number;
    /** First and last (exclusive) item index to render, with one spare row above and below. */
    first: number;
    last: number;
}

/** Which tiles of a virtual grid are visible. */
export function gridWindow(width: number, total: number, scrollTop: number, viewH: number, tileW: number, tileH: number): GridWindow {
    const cols = Math.max(1, Math.floor(width / tileW));
    const rows = Math.ceil(total / cols);
    const r0 = Math.max(0, Math.floor(scrollTop / tileH) - 1);
    const r1 = Math.min(rows, Math.ceil((scrollTop + viewH) / tileH) + 1);
    return { cols, height: rows * tileH, first: r0 * cols, last: Math.min(total, r1 * cols) };
}

/** New current index after an arrow key (`cols` = 1 for the table). -1 = no change. */
export function moveIndex(i: number, key: string, cols: number, n: number): number {
    if (n <= 0) return -1;
    if (i < 0) return 0;
    const step = ({ ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols } as Record<string, number>)[key];
    if (step === undefined) return -1;
    if (cols > 1 && (key === 'ArrowRight' || key === 'ArrowLeft')) return Math.max(0, Math.min(n - 1, i + step));
    if (cols === 1 && (key === 'ArrowRight' || key === 'ArrowLeft')) return -1;
    const j = i + step;
    return j < 0 || j >= n ? i : j;
}

/** Scroll position that brings an item row [y, y+h) into a viewport, or null when it is visible. */
export function scrollToShow(y: number, h: number, scrollTop: number, viewH: number): number | null {
    if (y < scrollTop) return y;
    if (y + h > scrollTop + viewH) return y + h - viewH;
    return null;
}

/** 256-entry RGB lookup: dark blue-black → purple → orange → pale yellow (inferno-like). */
export function heatLut(): Uint8ClampedArray {
    const stops: [number, number, number, number][] = [
        [0, 8, 8, 24], [0.25, 60, 15, 110], [0.5, 150, 40, 100], [0.75, 235, 110, 40], [1, 252, 245, 170],
    ];
    const lut = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
        const t = i / 255;
        let k = 0;
        while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
        const [t0, ...a] = stops[k];
        const [t1, ...b] = stops[k + 1];
        const f = (t - t0) / (t1 - t0);
        for (let c = 0; c < 3; c++) lut[i * 3 + c] = Math.round(a[c] + (b[c] - a[c]) * f);
    }
    return lut;
}

/** RGBA pixels of a thumbnail through a lookup table. */
export function thumbPixels(t: Pick<Thumb, 'w' | 'h' | 'data'>, lut: Uint8ClampedArray): Uint8ClampedArray<ArrayBuffer> {
    const px = new Uint8ClampedArray(t.w * t.h * 4);
    for (let i = 0; i < t.w * t.h; i++) {
        const v = t.data[i] ?? 0;
        px[i * 4] = lut[v * 3];
        px[i * 4 + 1] = lut[v * 3 + 1];
        px[i * 4 + 2] = lut[v * 3 + 2];
        px[i * 4 + 3] = 255;
    }
    return px;
}

/** "0:42" · "12:05" · "1:02:00" */
export function clockDuration(s: number | null): string {
    if (s == null || !Number.isFinite(s)) return '';
    const t = Math.round(s);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    const two = (x: number) => String(x).padStart(2, '0');
    return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}
