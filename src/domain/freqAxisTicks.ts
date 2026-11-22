/**
 * Frequency axis ticks in the style of Audacity's ruler: as many labels as
 * the axis height allows, with the step chosen per region. On mel/log axes the
 * low end therefore gets dense labels (100, 200, 300 …) and the top sparse ones.
 *
 * Coarse steps are placed first, so round values (1, 10 kHz) win over
 * neighbours; finer steps only fill gaps that are still wide enough.
 */

export interface FreqTick {
    hz: number;
    /** true: draw a number. false: minor tick mark only. */
    labeled: boolean;
    /** Power of ten (100 Hz, 1 kHz, 10 kHz): drawn emphasized. */
    major: boolean;
}

export interface FreqTickParams {
    /** Axis height in CSS pixels. */
    height: number;
    minHz: number;
    maxHz: number;
    /** Frequency → fraction from the top (0 = top, 1 = bottom). */
    toFrac: (hz: number) => number;
    /** Minimum distance between two labels in px. */
    labelGap?: number;
    /** Minimum distance between minor ticks (and to labels) in px. */
    tickGap?: number;
    /** Keep labels this far from the top edge (room for the unit). */
    topReserve?: number;
}

/** 1-2-5 steps from 1 Hz to 100 kHz, coarse first. */
const STEPS: number[] = [];
for (let p = 100000; p >= 1; p /= 10) for (const m of [5, 2, 1]) STEPS.push(m * p);
STEPS.sort((a, b) => b - a);

const EPS = 1e-6;
const isMultiple = (hz: number, step: number) => Math.abs(hz / step - Math.round(hz / step)) < 1e-6;

/** Round values a reader expects on a log-like ruler: 1–9 and 1.5, 2.5 times a power of ten. */
const NICE_MANTISSAS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 9];
function isNice(hz: number): boolean {
    if (hz <= 0) return hz === 0;
    const m = hz / 10 ** Math.floor(Math.log10(hz) + EPS);
    return NICE_MANTISSAS.some((n) => Math.abs(n - m) < 1e-6);
}

function niceRank(hz: number): number {
    const m = hz / 10 ** Math.floor(Math.log10(hz) + EPS);
    const i = [1, 5, 2, 3, 4, 6, 7, 8, 9, 1.5, 2.5].findIndex((n) => Math.abs(n - m) < 1e-6);
    return i < 0 ? 99 : i;
}

function isPowerOfTen(hz: number): boolean {
    const l = Math.log10(hz);
    return hz > 0 && Math.abs(l - Math.round(l)) < 1e-9;
}

/** Multiples of step between lo and hi (each end inclusive or not), capped. */
function multiplesInside(lo: number, hi: number, step: number, loIncl: boolean, hiIncl: boolean, cap = 400): number[] | null {
    const k0 = loIncl ? Math.ceil(lo / step - EPS) : Math.floor(lo / step + EPS) + 1;
    const first = k0 * step;
    if ((hi - first) / step > cap) return null;
    const out: number[] = [];
    for (let k = 0; ; k++) {
        const hz = Math.round((first + k * step) * 1000) / 1000;
        if (hiIncl ? hz > hi + EPS : hz >= hi - EPS) break;
        out.push(hz);
    }
    return out;
}

/**
 * Subdivide (lo, hi). lo/hi are frequencies (an existing label) or null for
 * the axis edge. Prefers the finest step that splits the interval evenly; on
 * non-linear axes where no even split fits, keeps what fits of a coarse step.
 */
function subdivide(
    lo: number | null, hi: number | null, minHz: number, maxHz: number,
    y: (hz: number) => number, gap: number, yTop: number, yBottom: number, nonLinear: boolean, sink: number[],
) {
    const loHz = lo ?? minHz, hiHz = hi ?? maxHz;
    const loY = lo === null ? null : y(lo);
    const hiY = hi === null ? null : y(hi);
    const fits = (pts: number[]) => {
        let prev = loY ?? yBottom + gap; // bottom edge: no gap needed
        for (const p of pts) {
            const py = y(p);
            if (py > yBottom + EPS || py < yTop) return false;
            if (prev - py < gap) return false;
            prev = py;
        }
        return hiY === null || prev - hiY >= gap;
    };
    const onAxis = (p: number) => { const py = y(p); return py <= yBottom + EPS && py >= yTop; };
    let chosen: number[] | null = null;
    for (const step of STEPS) {
        if (lo !== null && hi !== null && step >= hiHz - loHz) continue;
        if (lo !== null && !isMultiple(lo, step)) continue;
        if (hi !== null && !isMultiple(hi, step)) continue;
        const pts = multiplesInside(loHz, hiHz, step, lo === null, hi === null);
        if (!pts) break;
        // At the axis edges, values beyond the drawable area just drop out.
        const inRange = pts.filter((p) => (lo !== null && hi !== null) || onAxis(p));
        if (inRange.length && fits(inRange)) chosen = inRange; // keep going: finer wins
        else if (chosen) break;
    }
    if (!chosen) {
        // Non-linear spacing: no even split fits, so keep what fits of the coarsest
        // step that places anything. Steps below the decade of lo would give
        // odd values (3.8 kHz), so they are not tried.
        const minStep = 10 ** Math.floor(Math.log10(loHz > 0 ? loHz : hiHz / 10) + EPS);
        let best: number[] = [];
        for (const step of STEPS) {
            if (!nonLinear) break;
            if (step >= hiHz - loHz) continue;
            if (step < minStep) break;
            if (lo !== null && !isMultiple(lo, step)) continue;
            const pts = multiplesInside(loHz, hiHz, step, lo === null, hi === null);
            if (!pts) break;
            // Roundest values first (1, then 5 and 2, …), each kept if it has room.
            const taken: number[] = [loY ?? yBottom + gap, ...(hiY === null ? [] : [hiY])];
            const kept: number[] = [];
            for (const p of pts.filter((q) => onAxis(q) && isNice(q)).sort((a, b) => niceRank(a) - niceRank(b))) {
                const py = y(p);
                if (taken.some((t) => Math.abs(t - py) < gap)) continue;
                taken.push(py); kept.push(p);
            }
            kept.sort((a, b) => a - b);
            if (kept.length > best.length) best = kept; // ties keep the coarser step
        }
        if (best.length) chosen = best;
    }
    if (!chosen || !chosen.length) return;
    sink.push(...chosen);
    const bounds = [lo, ...chosen, hi];
    for (let i = 0; i + 1 < bounds.length; i++) {
        subdivide(bounds[i], bounds[i + 1], minHz, maxHz, y, gap, yTop, yBottom, nonLinear, sink);
    }
}

function layer(minHz: number, maxHz: number, y: (hz: number) => number, gap: number, yTop: number, yBottom: number, nonLinear: boolean): number[] {
    const sink: number[] = [];
    subdivide(null, null, minHz, maxHz, y, gap, yTop, yBottom, nonLinear, sink);
    return sink.sort((a, b) => a - b);
}

export function computeFreqTicks({
    height, minHz, maxHz, toFrac, labelGap = 16, tickGap = 6, topReserve = 10,
}: FreqTickParams): FreqTick[] {
    if (!(height > 0) || !(maxHz > minHz)) return [];
    const y = (hz: number) => toFrac(hz) * height;
    // Linear axes only get even splits; uneven filling is for mel/log.
    const mid = y((minHz + maxHz) / 2);
    const nonLinear = Math.abs(mid - (y(minHz) + y(maxHz)) / 2) > 1;
    const labels = layer(minHz, maxHz, y, labelGap, topReserve, height, nonLinear);
    const out = new Map<number, FreqTick>();
    for (const hz of labels) out.set(hz, { hz, labeled: true, major: isPowerOfTen(hz) });
    // Minor ticks: subdivide again between the labels with a smaller gap.
    const bounds: (number | null)[] = [null, ...labels, null];
    const minor: number[] = [];
    for (let i = 0; i + 1 < bounds.length; i++) {
        subdivide(bounds[i], bounds[i + 1], minHz, maxHz, y, tickGap, 0, height, nonLinear, minor);
    }
    for (const hz of minor) if (!out.has(hz)) out.set(hz, { hz, labeled: false, major: false });
    return [...out.values()].sort((a, b) => a.hz - b.hz);
}

/** kHz without unit, trailing zeros trimmed: 0 → "0", 250 → "0.25", 1500 → "1.5", 20000 → "20". */
export function formatKhz(hz: number): string {
    return String(Math.round(hz) / 1000);
}
