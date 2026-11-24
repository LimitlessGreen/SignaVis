// ═══════════════════════════════════════════════════════════════════════
// waveformScale.ts — how sample values map onto the amplitude view
//
//   scale     'linear' (sample value) or 'db' (mirrored dBFS, like Audacity's
//             dB waveform: quiet calls above the noise become visible)
//   reference 'peak' (top edge = loudest sample of the file) or 'full'
//             (top edge = full scale ±1 / 0 dBFS, comparable between files)
//
// The axis always shows absolute values (sample value or dBFS), so a
// normalized view still tells how loud the recording really is.
// ═══════════════════════════════════════════════════════════════════════

export type WaveformScale = 'linear' | 'db';
export type WaveformReference = 'peak' | 'full';

export interface WaveformDisplay {
    scale: WaveformScale;
    reference: WaveformReference;
    /** dB shown between the top edge and the centre line (dB scale only). */
    dbRange: number;
    /** Draw the RMS body inside the min/max envelope. */
    rms: boolean;
}

export const DEFAULT_WAVEFORM_DISPLAY: WaveformDisplay = { scale: 'linear', reference: 'peak', dbRange: 60, rms: true };
export const WAVEFORM_DB_RANGES = [36, 48, 60, 72, 96] as const;

/** |sample| at or above this counts as clipped (16-bit full scale decodes to 0.99997). */
export const CLIP_LEVEL = 0.999;

export function normalizeWaveformDisplay(v: Partial<Record<keyof WaveformDisplay, unknown>> | null | undefined, base: WaveformDisplay = DEFAULT_WAVEFORM_DISPLAY): WaveformDisplay {
    const o = v ?? {};
    const range = Number(o.dbRange);
    return {
        scale: o.scale === 'db' || o.scale === 'linear' ? o.scale : base.scale,
        reference: o.reference === 'full' || o.reference === 'peak' ? o.reference : base.reference,
        dbRange: Number.isFinite(range) && range >= 12 && range <= 144 ? Math.round(range) : base.dbRange,
        rms: typeof o.rms === 'boolean' ? o.rms : base.rms,
    };
}

export function toDbfs(v: number): number {
    const a = Math.abs(v);
    return a > 0 ? 20 * Math.log10(a) : -Infinity;
}

export interface AmplitudeMap {
    /** Sample value → position in [-1, 1] (1 = top edge). Monotonic. */
    map(v: number): number;
    /** Linear: the sample value at the top edge. dB: the dBFS at the top edge. */
    top: number;
    /** dB only: dBFS at the centre line (everything quieter collapses onto it). */
    floor: number;
    scale: WaveformScale;
}

export function amplitudeMap(display: WaveformDisplay, peakAbs: number): AmplitudeMap {
    const refAbs = display.reference === 'full' ? 1 : Math.max(1e-6, peakAbs || 0);
    if (display.scale === 'db') {
        const top = 20 * Math.log10(refAbs);
        const range = Math.max(1, display.dbRange);
        const floor = top - range;
        const inv = 1 / range;
        return {
            scale: 'db', top, floor,
            map(v: number) {
                const a = v < 0 ? -v : v;
                if (!(a > 0)) return 0;
                const f = (20 * Math.log10(a) - floor) * inv;
                const c = f <= 0 ? 0 : f >= 1 ? 1 : f;
                return v < 0 ? -c : c;
            },
        };
    }
    const inv = 1 / refAbs;
    return {
        scale: 'linear', top: refAbs, floor: 0,
        map(v: number) {
            const c = v * inv;
            return c <= -1 ? -1 : c >= 1 ? 1 : c === c ? c : 0;
        },
    };
}

export interface AxisTick {
    /** 0 = top edge, 1 = bottom edge. */
    frac: number;
    text: string;
}

const MINUS = '−';

/** Two significant digits, no exponent for the usual range; sign written with a real minus. */
export function formatAmplitude(v: number): string {
    if (v === 0) return '0';
    const a = Math.abs(v);
    let s: string;
    if (a >= 1) s = a.toFixed(a >= 10 ? 0 : 1).replace(/\.0$/, '');
    else {
        const decimals = Math.min(6, Math.max(1, 1 - Math.floor(Math.log10(a))));
        s = a.toFixed(decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    }
    return (v < 0 ? MINUS : '+') + s;
}

export function formatDb(db: number, digits = 0): string {
    if (!Number.isFinite(db)) return `${MINUS}∞`;
    const r = Number(db.toFixed(digits));
    if (r === 0) return '0';
    return (r < 0 ? MINUS : '+') + Math.abs(r).toFixed(digits);
}

/** Minimum vertical distance between two labels, in px. */
const TICK_SPACING_PX = 13;
const DB_STEPS = [3, 6, 10, 12, 20, 30, 40, 60];

/** Smallest 1/2/5 × 10^k at or above x. */
function niceStep(x: number): number {
    const e = Math.pow(10, Math.floor(Math.log10(x)));
    for (const m of [1, 2, 5, 10]) if (m * e >= x * (1 - 1e-9)) return m * e;
    return 10 * e;
}

/**
 * Round-valued ticks, mirrored around the centre line, as many as fit `heightPx`:
 * sample values (0.005, 0.01, …) or dBFS (−40, −60, …). The centre carries "0" on the
 * linear scale and no label on the dB scale (there it stands for "floor and quieter").
 * When no round value fits, the edge value is labelled instead.
 */
export function amplitudeTicks(m: AmplitudeMap, heightPx = 80): AxisTick[] {
    const perHalf = Math.max(1, Math.floor((heightPx / 2) / TICK_SPACING_PX));
    const half: { pos: number; text: string; neg: string }[] = []; // pos ∈ (0, 1]: distance from centre
    if (m.scale === 'db') {
        const range = m.top - m.floor;
        const step = DB_STEPS.find((d) => range / d <= perHalf + 1e-9) ?? Math.ceil(range / perHalf / 10) * 10;
        // A tick and its mirror image must not crowd each other at the centre line.
        const minPos = TICK_SPACING_PX / heightPx;
        for (let v = Math.floor(m.top / step + 1e-9) * step; v > m.floor + 1e-9; v -= step) {
            const pos = (v - m.floor) / range;
            if (pos < minPos) break;
            const t = formatDb(v);
            half.push({ pos, text: t, neg: t });
        }
        if (!half.length) half.push({ pos: 1, text: formatDb(m.top), neg: formatDb(m.top) });
    } else {
        const step = niceStep(m.top / perHalf);
        const n = Math.floor(m.top / step + 1e-6);
        for (let k = 1; k <= n; k++) {
            const v = Number((k * step).toPrecision(6));
            half.push({ pos: Math.min(1, v / m.top), text: formatAmplitude(v), neg: formatAmplitude(-v) });
        }
        if (!half.length) half.push({ pos: 1, text: formatAmplitude(m.top), neg: formatAmplitude(-m.top) });
    }
    const ticks: AxisTick[] = [];
    for (const h of [...half].sort((a, b) => b.pos - a.pos)) ticks.push({ frac: (1 - h.pos) / 2, text: h.text });
    if (m.scale === 'linear') ticks.push({ frac: 0.5, text: '0' });
    for (const h of [...half].sort((a, b) => a.pos - b.pos)) ticks.push({ frac: (1 + h.pos) / 2, text: h.neg });
    return ticks;
}

export function isClipped(lo: number, hi: number): boolean {
    return hi >= CLIP_LEVEL || lo <= -CLIP_LEVEL;
}

/** Badge text for the top corner of the view, e.g. "Peak −38.4 dBFS". */
export function peakBadge(peakAbs: number): string {
    return `Peak ${formatDb(toDbfs(peakAbs), 1)} dBFS`;
}
