// ═══════════════════════════════════════════════════════════════════════
// domain/catalog/calendar.ts — calendar heatmap of the library (days × hours)
//
// Which cells the filter keeps, sunrise/sunset lines in local time, and the
// filter a click or a dragged rectangle on the calendar stands for.
// ═══════════════════════════════════════════════════════════════════════

import type { CatalogFilter, DayCount } from './catalog-types.ts';
import { filterDays, hourIn } from './histogram.ts';
import { crossing, dayOfYear, daysInYear, SUN_ALT } from '../../../packages/sun-charts/src/sun.ts';

export interface CalCell { i: number; hour: number }

/** Whether the filter's period and time of day keep this cell. */
export function cellInView(day: string, hour: number, f: CatalogFilter): boolean {
    const { from, to } = filterDays(f);
    return (from == null || day >= from) && (to == null || day <= to) && hourIn(hour, f.hourFrom, f.hourTo);
}

/** Cell under a point (clamped to the grid). */
export function cellAt(x: number, y: number, g: { left: number; top: number; cw: number; ch: number; days: number }): CalCell {
    const clamp = (v: number, hi: number) => Math.max(0, Math.min(hi, v));
    return { i: clamp(Math.floor((x - g.left) / g.cw), g.days - 1), hour: clamp(Math.floor((y - g.top) / g.ch), 23) };
}

type TimePatch = Pick<CatalogFilter, 'localDayFrom' | 'localDayTo' | 'fromMs' | 'toMs' | 'hourFrom' | 'hourTo'>;

/**
 * Filter change for a click (a = b) or a dragged rectangle on the calendar.
 * Click: that day (again on the only day shown: all days). Rectangle: its days, and its hours
 * when it spans more than one row (a single-row drag picks days only).
 */
export function calendarBrush(days: string[], a: CalCell, b: CalCell, f: CatalogFilter): Partial<TimePatch> {
    const [i0, i1] = a.i <= b.i ? [a.i, b.i] : [b.i, a.i];
    const [h0, h1] = a.hour <= b.hour ? [a.hour, b.hour] : [b.hour, a.hour];
    const cur = filterDays(f);
    if (i0 === i1 && h0 === h1) {
        const d = days[i0];
        return cur.from === d && cur.to === d
            ? { localDayFrom: null, localDayTo: null, fromMs: null, toMs: null }
            : { localDayFrom: d, localDayTo: d, fromMs: null, toMs: null };
    }
    const out: Partial<TimePatch> = i0 === 0 && i1 === days.length - 1
        ? { localDayFrom: null, localDayTo: null, fromMs: null, toMs: null }
        : { localDayFrom: days[i0], localDayTo: days[i1], fromMs: null, toMs: null };
    if (h0 !== h1) Object.assign(out, h0 === 0 && h1 === 23 ? { hourFrom: null, hourTo: null } : { hourFrom: h0, hourTo: h1 + 1 });
    return out;
}

export interface SunLine { rise: number | null; set: number | null }

/**
 * Sunrise and sunset per day in local clock hours (0–24) at `center`, using each day's UTC offset
 * (`offsets`, else the nearest earlier known one, else the first known). Null where the sun does not rise or set.
 */
export function sunLines(days: string[], offsets: DayCount[], center: [number, number] | null | undefined): SunLine[] | null {
    if (!center || !days.length) return null;
    const known = new Map(offsets.filter((d) => d.offsetMin != null).map((d) => [d.day, d.offsetMin! / 60]));
    let off = known.size ? known.values().next().value! : 0;
    const [lat, lon] = center;
    return days.map((day) => {
        off = known.get(day) ?? off;
        const c = crossing(lat, lon, dayOfYear(day), SUN_ALT.horizon, off, daysInYear(Number(day.slice(0, 4))));
        if (typeof c === 'string') return { rise: null, set: null };
        const h = (m: number) => (((m / 60) % 24) + 24) % 24;
        return { rise: h(c.rise), set: h(c.set) };
    });
}
