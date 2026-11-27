// ═══════════════════════════════════════════════════════════════════════
// domain/catalog/histogram.ts — mini histograms of the field sidebar
//
// Date (recordings per local day, grouped into at most N bars) and time of
// day (24 hourly bars). Each bar knows whether the current filter keeps it,
// and a dragged range of bars turns into a filter (local days or hours).
// ═══════════════════════════════════════════════════════════════════════

import type { CatalogFilter, DayCount } from './catalog-types.ts';

const DAY = 86_400_000;
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

export interface DayBar { from: string; to: string; count: number; on: boolean }
export interface HourBar { hour: number; count: number; on: boolean }

/** The period of a filter as local days (inclusive). UTC-ms bounds from older datasets map to their UTC days. */
export function filterDays(f: CatalogFilter): { from: string | null; to: string | null } {
    const from = f.localDayFrom ?? (f.fromMs != null ? isoDay(f.fromMs) : null);
    const to = f.localDayTo ?? (f.toMs != null ? isoDay(f.toMs - 1) : null);
    return { from, to };
}

/**
 * Recordings per day as at most `maxBars` bars over the whole span (days without
 * recordings count 0; several days share a bar when the span is long).
 */
export function dayBars(days: DayCount[], f: CatalogFilter, maxBars = 48): DayBar[] {
    if (!days.length) return [];
    const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
    const first = dayMs(sorted[0].day);
    const span = Math.round((dayMs(sorted[sorted.length - 1].day) - first) / DAY) + 1;
    const per = Math.max(1, Math.ceil(span / Math.max(1, maxBars)));
    const n = Math.ceil(span / per);
    const counts = new Array<number>(n).fill(0);
    for (const d of sorted) counts[Math.floor(Math.round((dayMs(d.day) - first) / DAY) / per)] += d.count;
    const { from, to } = filterDays(f);
    return counts.map((count, i) => {
        const a = isoDay(first + i * per * DAY);
        const b = isoDay(first + (Math.min(span, (i + 1) * per) - 1) * DAY);
        return { from: a, to: b, count, on: (from == null || b >= from) && (to == null || a <= to) };
    });
}

/** Whether a local hour lies in [from, to) (wrapping over midnight when from > to). */
export function hourIn(h: number, from: number | null | undefined, to: number | null | undefined): boolean {
    if (from == null || to == null) return true;
    return from <= to ? h >= from && h < to : h >= from || h < to;
}

export function hourBars(hours: number[] | undefined, f: CatalogFilter): HourBar[] {
    return Array.from({ length: 24 }, (_, h) => ({ hour: h, count: hours?.[h] ?? 0, on: hourIn(h, f.hourFrom, f.hourTo) }));
}

/** Filter change for a dragged range of date bars (indices in either order); null clears the period. */
export function brushDays(bars: DayBar[], i: number, j: number): Pick<CatalogFilter, 'localDayFrom' | 'localDayTo' | 'fromMs' | 'toMs'> {
    const [a, b] = i <= j ? [i, j] : [j, i];
    const all = a <= 0 && b >= bars.length - 1;
    return { localDayFrom: all ? null : bars[a].from, localDayTo: all ? null : bars[b].to, fromMs: null, toMs: null };
}

/** Filter change for a dragged range of hour bars: [min, max + 1); the full day clears it. */
export function brushHours(i: number, j: number): Pick<CatalogFilter, 'hourFrom' | 'hourTo'> {
    const [a, b] = i <= j ? [i, j] : [j, i];
    return a <= 0 && b >= 23 ? { hourFrom: null, hourTo: null } : { hourFrom: a, hourTo: b + 1 };
}

/** Whether a bar click should clear its filter instead: the filter is exactly that one bar. */
export function isOnlyBar<T extends { on: boolean }>(bars: T[], i: number): boolean {
    return bars[i]?.on === true && bars.filter((b) => b.on).length === 1 && bars.length > 1;
}

/**
 * Period inputs (local days "YYYY-MM-DD", empty = open); replaces UTC-ms bounds of older filters.
 * Returns false (and changes nothing) for text that is no valid day.
 */
export function setPeriod(f: CatalogFilter, side: 'from' | 'to', value: string): boolean {
    const v = value.trim() || null;
    if (v != null && (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(dayMs(v)) || isoDay(dayMs(v)) !== v)) return false;
    const cur = filterDays(f);
    f.localDayFrom = side === 'from' ? v : cur.from;
    f.localDayTo = side === 'to' ? v : cur.to;
    f.fromMs = null;
    f.toMs = null;
    return true;
}
