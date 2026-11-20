/**
 * Linear chart view of the light context (default; the dials in sun-charts.ts are the alternative).
 * Two small charts for the recording context: where the recording sits in the year
 * (day length + seasons) and in the day (sun altitude over the twilight phases).
 * Many animals time their activity by light, so both are shown whenever date and
 * location are known.
 */

import {
    SUN_PHASE_TEXT, dayLengthHours, formatClock, formatDuration, phaseOf, seasonOf, seasonPart,
    sunAltitude, sunDay, type SunPhase,
} from '../../domain/sun.ts';
import type { Coords } from '../../app/recording-context.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
const W = 300;

/** Sequential night → day ramp, one hue family; low sun is the only warm step. */
const PHASE_COLOR: Record<SunPhase, string> = {
    night: '#0d1733',
    astronomical: '#1f3163',
    nautical: '#3a5796',
    civil: '#7395cc',
    golden: '#f1cf94',
    day: '#c4dcf2',
};
const SEASON_COLOR = { winter: '#7fa7d9', spring: '#8cc68a', summer: '#e8c25c', autumn: '#d9915a' } as const;
const SUN_LINE = '#d9822b';
const MONTHS = 'JFMAMJJASOND';

function svg(tag: string, attrs: Record<string, string | number>, parent?: Element) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    parent?.appendChild(el);
    return el;
}

function parseTime(t: string | null | undefined): number | null {
    const m = String(t ?? '').match(/^(\d{1,2}):(\d{2})/);
    return m ? +m[1] * 60 + +m[2] : null;
}


/** Chart frame with title, an SVG and a hover readout; returns the parts. */
function frame(title: string, height: number) {
    const box = document.createElement('div');
    box.className = 'sun-chart';
    const head = document.createElement('div');
    head.className = 'sun-chart-head';
    const h = document.createElement('span');
    h.className = 'sun-chart-title';
    h.textContent = title;
    head.appendChild(h);
    box.appendChild(head);
    const plot = document.createElement('div');
    plot.className = 'sun-chart-plot';
    const root = svg('svg', { viewBox: `0 0 ${W} ${height}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': title });
    plot.appendChild(root);
    const tip = document.createElement('div');
    tip.className = 'sun-chart-tip';
    tip.hidden = true;
    plot.appendChild(tip);
    box.appendChild(plot);
    const summary = document.createElement('div');
    summary.className = 'sun-chart-summary';
    box.appendChild(summary);
    return { box, head, root, plot, tip, summary };
}

/** Crosshair + tooltip: `read(x)` returns the tooltip text for a viewBox x. */
function hover(plot: HTMLElement, root: SVGElement, height: number, read: (x: number) => string) {
    const line = svg('line', { y1: 0, y2: height, class: 'sun-chart-cross', visibility: 'hidden' }, root);
    const tip = plot.querySelector('.sun-chart-tip') as HTMLElement;
    plot.addEventListener('pointermove', (e) => {
        const r = plot.getBoundingClientRect();
        const fx = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
        const x = fx * W;
        line.setAttribute('x1', String(x));
        line.setAttribute('x2', String(x));
        line.setAttribute('visibility', 'visible');
        tip.textContent = read(x);
        tip.hidden = false;
        tip.style.left = `${Math.min(fx * r.width, r.width - tip.offsetWidth)}px`;
    });
    plot.addEventListener('pointerleave', () => { line.setAttribute('visibility', 'hidden'); tip.hidden = true; });
}

// ── Year ─────────────────────────────────────────────────────────────

export function buildYearChart(c: Coords, date: string) {
    const H = 70;
    const plotH = 58;
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(5, 7));
    const yearDays = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
    const f = frame('Season & day length', H);
    const xOf = (doy: number) => ((doy - 1) / (yearDays - 1)) * W;
    const yOf = (hours: number) => plotH - (hours / 24) * (plotH - 4);
    const monthStart = (m: number) => Math.round((Date.UTC(year, m, 1) - Date.UTC(year, 0, 1)) / 86400000) + 1;

    // Season bands (meteorological) with a faint fill
    for (let m = 0; m < 12; m++) {
        const s = seasonOf(m + 1, c.lat);
        const x0 = xOf(monthStart(m));
        const x1 = m === 11 ? W : xOf(monthStart(m + 1));
        svg('rect', { x: x0, y: 0, width: x1 - x0, height: plotH, fill: SEASON_COLOR[s], 'fill-opacity': 0.22 }, f.root);
        svg('text', { x: (x0 + x1) / 2, y: H - 2, class: 'sun-chart-axis', 'text-anchor': 'middle' }, f.root).textContent = MONTHS[m];
    }
    // 12 h reference
    svg('line', { x1: 0, x2: W, y1: yOf(12), y2: yOf(12), class: 'sun-chart-ref' }, f.root);

    const lengths: number[] = [];
    for (let d = 1; d <= yearDays; d++) lengths.push(dayLengthHours(c.lat, d, yearDays));
    const pts = lengths.map((h, i) => `${xOf(i + 1).toFixed(1)},${yOf(h).toFixed(1)}`);
    svg('path', { d: `M0,${plotH} L${pts.join(' L')} L${W},${plotH} Z`, fill: '#f1cf94', 'fill-opacity': 0.45 }, f.root);
    svg('path', { d: `M${pts.join(' L')}`, fill: 'none', stroke: SUN_LINE, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }, f.root);

    const doy = Math.round((Date.UTC(year, month - 1, Number(date.slice(8, 10))) - Date.UTC(year, 0, 1)) / 86400000) + 1;
    const here = lengths[doy - 1];
    svg('line', { x1: xOf(doy), x2: xOf(doy), y1: 0, y2: plotH, class: 'sun-chart-marker' }, f.root);
    svg('circle', { cx: xOf(doy), cy: yOf(here), r: 4, class: 'sun-chart-dot' }, f.root);

    hover(f.plot, f.root, plotH, (x) => {
        const d = Math.round((x / W) * (yearDays - 1)) + 1;
        const dt = new Date(Date.UTC(year, 0, d));
        const label = dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
        return `${label} · ${formatDuration(lengths[d - 1] * 60)} daylight`;
    });

    // Summary: season, day length and its trend, distance to the next solstice
    const trend = ((lengths[Math.min(doy, yearDays - 1)] - lengths[Math.max(doy - 2, 0)]) / 2) * 60;
    const solstices = [172, 355, 172 + yearDays];
    const next = solstices.find((s) => s >= doy)!;
    const nextIsLong = (next % yearDays === 172) === c.lat >= 0;
    const season = seasonOf(month, c.lat);
    const trendText = Math.abs(trend) < 0.5 ? 'about steady' : `${trend > 0 ? '+' : '−'}${Math.abs(trend).toFixed(1)} min/day`;
    f.summary.innerHTML = '';
    const strong = document.createElement('strong');
    strong.textContent = `${seasonPart(month)[0].toUpperCase()}${seasonPart(month).slice(1)} ${season}`;
    f.summary.append(strong,
        ` · ${formatDuration(here * 60)} daylight (${trendText}) · `
        + `${next - doy === 0 ? 'solstice today' : `${next - doy} d to ${nextIsLong ? 'longest' : 'shortest'} day`}`);
    return f.box;
}

// ── Day ──────────────────────────────────────────────────────────────

export function buildDayChart(c: Coords, date: string, time: string | null, utcOffsetH: number, durationMin = 0) {
    const H = 86;
    const plotH = 72;
    const f = frame('Sun & twilight', H);
    const s = sunDay(c.lat, c.lon, date, utcOffsetH);
    const alt = (min: number) => sunAltitude(c.lat, c.lon, s.doy, min, utcOffsetH, s.yearDays);
    const xOf = (min: number) => (min / 1440) * W;

    // Phase background, 5-min columns
    const samples: number[] = [];
    for (let m = 0; m <= 1440; m += 5) samples.push(alt(m));
    let runStart = 0;
    for (let i = 1; i <= samples.length; i++) {
        const p = phaseOf(samples[runStart]);
        if (i < samples.length && phaseOf(samples[i]) === p) continue;
        svg('rect', { x: xOf(runStart * 5), y: 0, width: xOf((i - runStart) * 5) + 0.5, height: plotH, fill: PHASE_COLOR[p] }, f.root);
        runStart = i;
    }
    const lo = Math.min(-20, ...samples);
    const hi = Math.max(20, ...samples);
    const yOf = (a: number) => 4 + (1 - (a - lo) / (hi - lo)) * (plotH - 8);
    svg('line', { x1: 0, x2: W, y1: yOf(0), y2: yOf(0), class: 'sun-chart-horizon' }, f.root);
    const pts = samples.map((a, i) => `${xOf(i * 5).toFixed(1)},${yOf(a).toFixed(1)}`);
    svg('path', { d: `M${pts.join(' L')}`, fill: 'none', stroke: SUN_LINE, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }, f.root);
    for (let h = 0; h <= 24; h += 6) {
        svg('text', { x: Math.min(Math.max(xOf(h * 60), 6), W - 6), y: H - 2, class: 'sun-chart-axis', 'text-anchor': 'middle' }, f.root)
            .textContent = String(h).padStart(2, '0');
    }

    const rec = parseTime(time);
    if (rec != null) {
        // Recording span (wraps past midnight, at most one full day)
        const end = rec + Math.min(durationMin, 1440);
        if (end > rec) {
            const parts: [number, number][] = end <= 1440 ? [[rec, end]] : [[rec, 1440], [0, end - 1440]];
            for (const [a, b] of parts) {
                svg('rect', { x: xOf(a), y: 0, width: Math.max(1, xOf(b) - xOf(a)), height: plotH, class: 'sun-chart-span' }, f.root);
                const seg: string[] = [];
                for (let m = a; m <= b; m += 5) seg.push(`${xOf(m).toFixed(1)},${yOf(alt(m)).toFixed(1)}`);
                seg.push(`${xOf(b).toFixed(1)},${yOf(alt(b)).toFixed(1)}`);
                svg('path', { d: `M${seg.join(' L')}`, class: 'sun-chart-span-curve' }, f.root);
            }
            const ex = xOf(end % 1440 || (end === 1440 ? 1440 : 0));
            svg('line', { x1: ex, x2: ex, y1: 0, y2: plotH, class: 'sun-chart-marker sun-chart-marker--end' }, f.root);
        }
        svg('line', { x1: xOf(rec), x2: xOf(rec), y1: 0, y2: plotH, class: 'sun-chart-marker' }, f.root);
        svg('circle', { cx: xOf(rec), cy: yOf(alt(rec)), r: 4, class: 'sun-chart-dot' }, f.root);
    }

    hover(f.plot, f.root, plotH, (x) => {
        const m = Math.round((x / W) * 1440);
        const a = alt(m);
        return `${formatClock(m)} · ${SUN_PHASE_TEXT[phaseOf(a)]} · ${a.toFixed(1)}°`;
    });

    // Summary: recording position + event times
    f.summary.innerHTML = '';
    const sr = s.events.horizon;
    if (rec != null) {
        const a = alt(rec);
        const strong = document.createElement('strong');
        strong.textContent = `${formatClock(rec)}${durationMin >= 1 ? `–${formatClock(rec + durationMin)}` : ''} · ${SUN_PHASE_TEXT[phaseOf(a)]}`;
        let rel = '';
        if (typeof sr === 'object') {
            const toRise = rec - sr.rise;
            const toSet = rec - sr.set;
            const [d, name] = Math.abs(toRise) <= Math.abs(toSet) ? [toRise, 'sunrise'] : [toSet, 'sunset'];
            rel = ` · ${formatDuration(d)} ${d < 0 ? 'before' : 'after'} ${name}`;
        }
        f.summary.append(strong, ` · ${durationMin >= 1 ? 'starts at ' : ''}sun ${a.toFixed(1)}°${rel}`);
    } else {
        f.summary.append('No recording time — set one to place it in the day.');
    }
    // Event table: columns = thresholds, rows = morning / evening
    const ev = document.createElement('div');
    ev.className = 'sun-chart-events';
    const cols: [string, SunPhase, typeof sr, string][] = [
        ['Astro', 'astronomical', s.events.astronomical, 'Astronomical twilight (sun at −18°)'],
        ['Naut.', 'nautical', s.events.nautical, 'Nautical twilight (sun at −12°)'],
        ['Civil', 'civil', s.events.civil, 'Civil twilight (sun at −6°)'],
        ['Sun', 'golden', sr, 'Sunrise / sunset'],
    ];
    const cell = (text: string, cls = '') => { const d = document.createElement('span'); d.textContent = text; if (cls) d.className = cls; return d; };
    ev.appendChild(cell(''));
    for (const [label, key, , title] of cols) {
        const h = cell(label, 'sun-ev-head');
        const sw = document.createElement('i');
        sw.style.background = PHASE_COLOR[key];
        h.prepend(sw);
        h.title = title;
        ev.appendChild(h);
    }
    for (const [row, side] of [['Dawn', 'rise'], ['Dusk', 'set']] as const) {
        ev.appendChild(cell(row, 'sun-ev-row'));
        for (const [, , e] of cols) {
            const c = cell(typeof e === 'object' ? formatClock(e[side]) : '—');
            if (typeof e !== 'object') c.title = e === 'always-above' ? 'The sun never sinks this low today' : 'The sun never rises this high today';
            ev.appendChild(c);
        }
    }
    f.summary.appendChild(ev);
    return f.box;
}

