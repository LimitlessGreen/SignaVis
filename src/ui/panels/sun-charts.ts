/**
 * Two astronomical dials for the recording context: a 24-hour sun dial (twilight phases as a
 * ring, sun altitude as a polar curve, event times at their place on the ring) and a year wheel
 * (seasons as a ring, day length as a polar curve, solstices and equinoxes). Many animals time
 * their activity by light, so both are shown whenever date and location are known.
 *
 * Both dials put light at the top: noon / the longest day up, midnight / the shortest day down,
 * morning and spring on the left as on a sky chart facing the equator.
 */

import {
    SUN_PHASE_TEXT, dayLengthHours, clockDiff, formatClock, formatDuration, guessUtcOffset, phaseOf, seasonOf, seasonPart,
    phaseSpans, sunAltitude, sunDay, timeZoneAt, UTC_OFFSETS, type Season, type SunPhase,
} from '../../domain/sun.ts';
import type { Coords } from '../../app/recording-context.ts';
import { buildDayChart, buildYearChart } from './sun-linear-charts.ts';
import { prefs } from '../../infrastructure/storage/prefs.ts';

export type LightView = 'chart' | 'dial';
const VIEW_KEY = 'aw.props.lightView';
/** Recordings shorter than this are shown as a moment, not a span. */
export const SPAN_MIN_MINUTES = 10;

const NS = 'http://www.w3.org/2000/svg';
const S = 260;              // viewBox size
const C = S / 2;            // centre
const R_OUT = 98;           // outer ring edge
const R_IN = 82;            // inner ring edge
const R_CORE = 42;          // free centre for the readout
const TAU = Math.PI * 2;

/** Sequential night → day ramp, one hue family; low sun is the only warm step. */
export const PHASE_COLOR: Record<SunPhase, string> = {
    night: '#0b1430',
    astronomical: '#1d2e5e',
    nautical: '#365393',
    civil: '#6f92cb',
    golden: '#f0c987',
    day: '#bfdcf5',
};
const SEASON_COLOR: Record<Season, string> = { winter: '#6f9ad6', spring: '#79bd7c', summer: '#e6bb4a', autumn: '#d9844f' };
const SUN = '#ffb347';
const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

// ── SVG helpers ──────────────────────────────────────────────────────

function el(tag: string, attrs: Record<string, string | number>, parent?: Element) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    parent?.appendChild(e);
    return e;
}

/** Point on the dial; φ = 0 at the bottom, increasing clockwise (left at π/2, top at π). */
const pol = (r: number, phi: number): [number, number] => [C - r * Math.sin(phi), C + r * Math.cos(phi)];
const P = (r: number, phi: number) => pol(r, phi).map((v) => v.toFixed(2)).join(',');

function sector(r0: number, r1: number, a: number, b: number) {
    const large = b - a > Math.PI ? 1 : 0;
    return `M${P(r1, a)} A${r1},${r1} 0 ${large} 1 ${P(r1, b)} L${P(r0, b)} A${r0},${r0} 0 ${large} 0 ${P(r0, a)} Z`;
}

/** Text placed radially (reading outward), flipped on the left so it is never upside down. */
function radialText(parent: Element, r: number, phi: number, text: string, cls: string) {
    const [x, y] = pol(r, phi);
    let deg = (Math.atan2(Math.cos(phi), -Math.sin(phi)) * 180) / Math.PI;
    let anchor = 'start';
    if (deg > 90 || deg < -90) { deg += 180; anchor = 'end'; }
    const t = el('text', { x, y, class: cls, 'text-anchor': anchor, 'dominant-baseline': 'central', transform: `rotate(${deg.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})` }, parent);
    t.textContent = text;
    return t;
}

/** Text along the ring (tangential), flipped in the lower half. */
function tangentText(parent: Element, r: number, phi: number, text: string, cls: string) {
    const [x, y] = pol(r, phi);
    let deg = (Math.atan2(Math.cos(phi), -Math.sin(phi)) * 180) / Math.PI + 90;
    if (Math.cos(phi) > 0) deg += 180; // lower half
    const t = el('text', { x, y, class: cls, 'text-anchor': 'middle', 'dominant-baseline': 'central', transform: `rotate(${deg.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})` }, parent);
    t.textContent = text;
    return t;
}

function closedCurve(values: number[], phiOf: (i: number) => number, rOf: (v: number) => number) {
    return `M${values.map((v, i) => P(rOf(v), phiOf(i))).join(' L')} Z`;
}

/** Dial frame: SVG + hover tooltip; `read(φ)` returns the tooltip for an angle (null = hide). */
function dial(label: string, read: (phi: number, r: number) => string | null) {
    const wrap = document.createElement('div');
    wrap.className = 'sun-dial';
    const svg = el('svg', { viewBox: `0 0 ${S} ${S}`, role: 'img', 'aria-label': label }) as SVGSVGElement;
    wrap.appendChild(svg);
    const tip = document.createElement('div');
    tip.className = 'sun-dial-tip';
    tip.hidden = true;
    wrap.appendChild(tip);
    const cursor = el('line', { class: 'sun-dial-cursor', visibility: 'hidden' }, undefined);
    svg.addEventListener('pointermove', (e) => {
        const box = svg.getBoundingClientRect();
        const x = ((e.clientX - box.left) / box.width) * S - C;
        const y = ((e.clientY - box.top) / box.height) * S - C;
        const r = Math.hypot(x, y);
        // invert pol(): x = -r sinφ, y = r cosφ
        const phi = (Math.atan2(-x, y) + TAU) % TAU;
        const text = r > R_CORE - 4 && r < R_OUT + 26 ? read(phi, r) : null;
        if (!text) { tip.hidden = true; cursor.setAttribute('visibility', 'hidden'); return; }
        const [x1, y1] = pol(R_CORE, phi);
        const [x2, y2] = pol(R_OUT, phi);
        Object.entries({ x1, y1, x2, y2 }).forEach(([k, v]) => cursor.setAttribute(k, v.toFixed(1)));
        cursor.setAttribute('visibility', 'visible');
        svg.appendChild(cursor);
        tip.textContent = text;
        tip.hidden = false;
        const px = e.clientX - box.left;
        tip.style.left = `${Math.max(0, Math.min(px - tip.offsetWidth / 2, box.width - tip.offsetWidth))}px`;
        tip.style.top = `${Math.max(0, e.clientY - box.top - 34)}px`;
    });
    svg.addEventListener('pointerleave', () => { tip.hidden = true; cursor.setAttribute('visibility', 'hidden'); });
    return { wrap, svg };
}

function centre(svg: Element, lines: [string, string][]) {
    const heights: Record<string, number> = { 'sun-c-big': 19, 'sun-c-mid': 12, 'sun-c-small': 10.5 };
    const total = lines.reduce((s, [, c]) => s + heights[c], 0);
    let y = C - total / 2;
    for (const [text, cls] of lines) {
        y += heights[cls] / 2;
        const t = el('text', { x: C, y, class: cls, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, svg);
        t.textContent = text;
        y += heights[cls] / 2;
    }
}

function parseTime(t: string | null | undefined): number | null {
    const m = String(t ?? '').match(/^(\d{1,2}):(\d{2})/);
    return m ? +m[1] * 60 + +m[2] : null;
}

export const fmtOffset = (h: number) => {
    const m = Math.round(Math.abs(h) * 60);
    return `UTC${h < 0 ? '−' : '+'}${Math.floor(m / 60)}${m % 60 ? `:${String(m % 60).padStart(2, '0')}` : ''}`;
};

// ── Day dial ─────────────────────────────────────────────────────────

export function buildDayDial(c: Coords, date: string, time: string | null, utcOffsetH: number, durationMin = 0) {
    const s = sunDay(c.lat, c.lon, date, utcOffsetH);
    const alt = (min: number) => sunAltitude(c.lat, c.lon, s.doy, min, utcOffsetH, s.yearDays);
    const phiOf = (min: number) => (min / 1440) * TAU;
    const minOf = (phi: number) => (phi / TAU) * 1440;
    const STEP = 4;
    const samples: number[] = [];
    for (let m = 0; m < 1440; m += STEP) samples.push(alt(m));
    const lo = Math.min(...samples) - 4;
    const hi = Math.max(10, ...samples) + 4;
    const rAlt = (a: number) => R_CORE + 2 + ((a - lo) / (hi - lo)) * (R_IN - R_CORE - 4);

    const { wrap, svg } = dial('Sun altitude and twilight over the day', (phi, r) => {
        const m = minOf(phi);
        const a = alt(m);
        return `${formatClock(m)} · ${SUN_PHASE_TEXT[phaseOf(a)]} · ${a >= 0 ? '+' : ''}${a.toFixed(1)}°`;
    });

    // Sky disc; the area the sun sweeps above the horizon glows, below it is masked by the earth disc
    const curve = closedCurve(samples, (i) => phiOf(i * STEP), rAlt);
    el('circle', { cx: C, cy: C, r: R_IN, class: 'sun-sky' }, svg);
    el('path', { d: curve, class: 'sun-sweep' }, svg);
    el('circle', { cx: C, cy: C, r: rAlt(0), class: 'sun-below' }, svg);

    // Phase ring
    let start = 0;
    for (let i = 1; i <= samples.length; i++) {
        const p = phaseOf(samples[start]);
        if (i < samples.length && phaseOf(samples[i]) === p) continue;
        el('path', { d: sector(R_IN, R_OUT, phiOf(start * STEP), phiOf(i * STEP) + 0.004), fill: PHASE_COLOR[p] }, svg);
        start = i;
    }
    // Hour ticks + cardinal hours
    for (let h = 0; h < 24; h++) {
        const major = h % 6 === 0;
        const [x1, y1] = pol(R_IN, phiOf(h * 60));
        const [x2, y2] = pol(R_IN + (major ? 6 : 3), phiOf(h * 60));
        el('line', { x1, y1, x2, y2, class: 'sun-tick' }, svg);
        if (major) {
            const [x, y] = pol(R_IN - 8, phiOf(h * 60));
            el('text', { x, y, class: 'sun-hour', 'text-anchor': 'middle', 'dominant-baseline': 'central' }, svg).textContent = String(h).padStart(2, '0');
        }
    }

    // Horizon circle and the sun's altitude curve
    el('circle', { cx: C, cy: C, r: rAlt(0), class: 'sun-horizon' }, svg);
    for (const a of [-18, -12, -6]) if (a > lo) el('circle', { cx: C, cy: C, r: rAlt(a), class: 'sun-twl' }, svg);
    el('path', { d: curve, class: 'sun-curve' }, svg);

    // Event times at their place, outside the ring
    const events: [number, string, boolean][] = [];
    const add = (e: (typeof s.events)['horizon'], label: string, strong: boolean) => {
        if (typeof e !== 'object') return;
        events.push([e.rise, `${label} ${formatClock(e.rise)}`, strong], [e.set, `${formatClock(e.set)} ${label}`, strong]);
    };
    add(s.events.astronomical, '', false);
    add(s.events.nautical, '', false);
    add(s.events.civil, '', false);
    add(s.events.horizon, '', true);
    for (const [m, text, strong] of events) {
        const phi = phiOf(((m % 1440) + 1440) % 1440);
        const [x1, y1] = pol(R_IN, phi);
        const [x2, y2] = pol(R_OUT + 3, phi);
        el('line', { x1, y1, x2, y2, class: strong ? 'sun-ev-line sun-ev-line--sun' : 'sun-ev-line' }, svg);
        radialText(svg, R_OUT + 5, phi, text.trim(), strong ? 'sun-ev sun-ev--sun' : 'sun-ev');
    }
    // Solar noon
    const [nx, ny] = pol(R_OUT + 3, phiOf(s.noon));
    el('circle', { cx: nx, cy: ny, r: 1.8, class: 'sun-noon' }, svg);

    // Recording: hand + sun on the curve
    const rec = parseTime(time);
    let lines: [string, string][];
    if (rec != null) {
        const phi = phiOf(rec);
        const a = alt(rec);
        const [hx, hy] = pol(R_OUT, phi);
        const [sx, sy] = pol(rAlt(a), phi);
        // Recording span over the ring, sun path highlighted, end hand
        const span = Math.min(durationMin, 1440);
        if (span >= 1) {
            const b = phi + (span / 1440) * TAU;
            if (span >= 1440) el('circle', { cx: C, cy: C, r: (R_IN + R_OUT) / 2, class: 'sun-span sun-span--full', 'stroke-width': R_OUT - R_IN + 4 }, svg);
            else el('path', { d: sector(R_IN - 2, R_OUT + 2, phi, b), class: 'sun-span' }, svg);
            const pts: string[] = [];
            for (let m = rec; m <= rec + span; m += 4) pts.push(P(rAlt(alt(m % 1440)), phiOf(m)));
            el('path', { d: `M${pts.join(' L')}`, class: 'sun-span-curve' }, svg);
            const [ex, ey] = pol(R_OUT, b);
            el('line', { x1: C, y1: C, x2: ex, y2: ey, class: 'sun-hand sun-hand--end' }, svg);
        }
        el('line', { x1: C, y1: C, x2: hx, y2: hy, class: 'sun-hand' }, svg);
        el('circle', { cx: sx, cy: sy, r: 6, class: a >= -0.833 ? 'sun-disc' : 'sun-disc sun-disc--down' }, svg);
        el('circle', { cx: C, cy: C, r: R_CORE, class: 'sun-core' }, svg);
        let rel = '';
        const sr = s.events.horizon;
        if (typeof sr === 'object') {
            const toRise = clockDiff(rec, sr.rise);
            const toSet = clockDiff(rec, sr.set);
            const [d, up] = Math.abs(toRise) <= Math.abs(toSet) ? [toRise, true] : [toSet, false];
            rel = `${d < 0 ? '−' : '+'}${formatDuration(d).replace(' min', 'm').replace(' h ', 'h ')} ${up ? '☀↑' : '☀↓'}`;
        } else rel = sr === 'always-above' ? 'no sunset' : 'no sunrise';
        lines = [[formatClock(rec), 'sun-c-big'], [SUN_PHASE_TEXT[phaseOf(a)].replace(' twilight', ''), 'sun-c-mid'], [`${a >= 0 ? '+' : ''}${a.toFixed(1)}° · ${rel}`, 'sun-c-small']];
        if (durationMin >= 1) lines.push([`→ ${formatClock(rec + durationMin)} · ${formatDuration(durationMin).replace(' min', 'm').replace(' h ', 'h ')}`, 'sun-c-small']);
    } else {
        el('circle', { cx: C, cy: C, r: R_CORE, class: 'sun-core' }, svg);
        lines = [['no time', 'sun-c-mid'], [`day ${formatDuration(s.dayLengthH * 60).replace(' min', 'm').replace(' h ', 'h ')}`, 'sun-c-small']];
    }
    centre(svg, lines);
    return wrap;
}

// ── Year wheel ───────────────────────────────────────────────────────

export function buildYearDial(c: Coords, date: string) {
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(5, 7));
    const N = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
    const doyOfDate = (m: number, d: number) => Math.round((Date.UTC(year, m, d) - Date.UTC(year, 0, 1)) / 86400000) + 1;
    const doy = doyOfDate(month - 1, Number(date.slice(8, 10)));
    const top = c.lat >= 0 ? 172 : 355; // longest day at the top
    const phiOf = (d: number) => (((Math.PI + (TAU * (d - top)) / N) % TAU) + TAU) % TAU;
    const doyOf = (phi: number) => ((Math.round(((phi - Math.PI) / TAU) * N + top) - 1 + N * 2) % N) + 1;
    const lengths: number[] = [];
    for (let d = 1; d <= N; d++) lengths.push(dayLengthHours(c.lat, d, N));
    const hLo = Math.max(0, Math.min(...lengths, 12) - 2);
    const hHi = Math.min(24, Math.max(...lengths, 12) + 2);
    const rLen = (h: number) => R_CORE + 2 + ((h - hLo) / (hHi - hLo)) * (R_IN - R_CORE - 4);
    const dayLabel = (d: number) => new Date(Date.UTC(year, 0, d)).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });

    const { wrap, svg } = dial('Season and day length over the year', (phi) => {
        const d = doyOf(phi);
        const m = new Date(Date.UTC(year, 0, d)).getUTCMonth() + 1;
        return `${dayLabel(d)} · ${seasonOf(m, c.lat)} · ${formatDuration(lengths[d - 1] * 60)} daylight`;
    });

    // Night disc with the daylight area on top
    el('circle', { cx: C, cy: C, r: R_IN, class: 'sun-sky sun-sky--night' }, svg);
    el('path', { d: closedCurve(lengths, (i) => phiOf(i + 1), rLen), class: 'sun-daylight' }, svg);
    el('circle', { cx: C, cy: C, r: rLen(12), class: 'sun-horizon' }, svg);

    // Season ring (meteorological, hemisphere-aware), one arc per season
    const monthStart = (m: number) => doyOfDate(m, 1);
    for (let m = 0; m < 12; m++) {
        const a = phiOf(monthStart(m));
        const b = m === 11 ? phiOf(N + 1) : phiOf(monthStart(m + 1));
        const s = seasonOf(m + 1, c.lat);
        el('path', { d: sector(R_IN, R_OUT, a, b < a ? b + TAU : b + 0.004), fill: SEASON_COLOR[s], class: m + 1 === month ? 'sun-season sun-season--now' : 'sun-season' }, svg);
        // month start tick + letter outside
        const [x1, y1] = pol(R_OUT, a);
        const [x2, y2] = pol(R_OUT + 4, a);
        el('line', { x1, y1, x2, y2, class: 'sun-tick' }, svg);
        const mid = a + (((b - a) % TAU) + TAU) % TAU / 2;
        const [lx, ly] = pol(R_OUT + 10, mid);
        el('text', { x: lx, y: ly, class: m + 1 === month ? 'sun-month sun-month--now' : 'sun-month', 'text-anchor': 'middle', 'dominant-baseline': 'central' }, svg).textContent = MONTHS[m];
    }
    // Season names on the ring, centred on the middle month (Jan, Apr, Jul, Oct)
    for (const m0 of [0, 3, 6, 9]) {
        tangentText(svg, (R_IN + R_OUT) / 2, phiOf(monthStart(m0) + 15), seasonOf(m0 + 1, c.lat).toUpperCase(), 'sun-season-label');
    }
    // Solstices & equinoxes as small diamonds inside the ring
    for (const [d, name] of [[80, 'Equinox'], [172, 'Solstice'], [266, 'Equinox'], [355, 'Solstice']] as const) {
        const [x, y] = pol(R_IN - 4, phiOf(d));
        const m = el('rect', { x: x - 2.5, y: y - 2.5, width: 5, height: 5, class: 'sun-mark', transform: `rotate(45 ${x} ${y})` }, svg);
        el('title', {}, m).textContent = `${name} · ${dayLabel(d)}`;
    }

    // Recording date: hand + dot on the day-length curve
    const phi = phiOf(doy);
    const [hx, hy] = pol(R_OUT, phi);
    const [dx, dy] = pol(rLen(lengths[doy - 1]), phi);
    el('line', { x1: C, y1: C, x2: hx, y2: hy, class: 'sun-hand' }, svg);
    el('circle', { cx: dx, cy: dy, r: 5, class: 'sun-disc' }, svg);
    el('circle', { cx: C, cy: C, r: R_CORE, class: 'sun-core' }, svg);

    const trend = ((lengths[Math.min(doy, N - 1)] - lengths[Math.max(doy - 2, 0)]) / 2) * 60;
    const next = [172, 355, 172 + N].find((x) => x >= doy)!;
    const longest = (next % N === 172) === c.lat >= 0;
    const season = seasonOf(month, c.lat);
    const part = seasonPart(month);
    const short = (h: number) => formatDuration(h * 60).replace(' min', 'm').replace(' h ', 'h ');
    centre(svg, [
        [`${part} ${season}`, 'sun-c-mid'],
        [short(lengths[doy - 1]), 'sun-c-big'],
        [`${Math.abs(trend) < 0.5 ? '±0' : `${trend > 0 ? '+' : '−'}${Math.abs(trend).toFixed(1)}`} min/day`, 'sun-c-small'],
        [next === doy ? 'solstice today' : `${next - doy} d → ${longest ? 'longest' : 'shortest'}`, 'sun-c-small'],
    ]);
    return wrap;
}

// ── Container ────────────────────────────────────────────────────────

/** Both dials, or nothing when date or location is missing. Keeps a manual zone choice per date/place. */
export class SunCharts {
    el: HTMLElement;
    _key = '';
    _offset: number | null = null;
    _last: [Coords | null, string | null, string | null, number] = [null, null, null, 0];

    constructor() {
        this.el = document.createElement('div');
        this.el.className = 'sun-charts';
    }

    /** durationSec: recording length; its span is drawn across the light phases. */
    render(coords: Coords | null, date: string | null, time: string | null, durationSec = 0) {
        this._last = [coords, date, time, durationSec];
        // Most recordings last seconds or minutes: their span would be invisible noise.
        const durationMin = durationSec / 60 >= SPAN_MIN_MINUTES ? durationSec / 60 : 0;
        this.el.innerHTML = '';
        if (!coords || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { this.el.hidden = true; return this.el; }
        this.el.hidden = false;
        const key = `${coords.lat},${coords.lon},${date}`;
        if (key !== this._key) { this._key = key; this._offset = null; }
        const local = guessUtcOffset(coords.lat, coords.lon, date, time || undefined);
        const off = this._offset ?? local;

        // Header: title + clock zone of the recording time
        const head = document.createElement('div');
        head.className = 'sun-charts-head';
        const title = document.createElement('span');
        title.className = 'sun-charts-title';
        title.textContent = 'Light';
        const sel = document.createElement('select');
        sel.className = 'sun-charts-zone';
        const zone = timeZoneAt(coords.lat, coords.lon);
        sel.title = 'Clock of the recording time. Local time (with summer time) is the usual case; AudioMoth file names are often UTC.';
        const opts = new Map<number, string>();
        opts.set(local, `${zone ? zone.split('/').pop()!.replace(/_/g, ' ') : 'Local'} · ${fmtOffset(local)}`);
        if (!opts.has(0)) opts.set(0, 'UTC');
        for (const h of UTC_OFFSETS) if (!opts.has(h)) opts.set(h, fmtOffset(h));
        if (!opts.has(off)) opts.set(off, fmtOffset(off));
        for (const [h, text] of opts) {
            const o = document.createElement('option');
            o.value = String(h);
            o.textContent = text;
            o.selected = h === off;
            sel.appendChild(o);
        }
        sel.addEventListener('change', () => { this._offset = Number(sel.value); this.render(...this._last); });
        // View switch: charts (default) or dials, remembered
        let view: LightView = 'chart';
        if (prefs.get(VIEW_KEY) === 'dial') view = 'dial';
        const seg = document.createElement('div');
        seg.className = 'sun-view-switch';
        seg.setAttribute('role', 'group');
        seg.setAttribute('aria-label', 'Light view');
        for (const [v, text, tip] of [['chart', 'Chart', 'Time lines'], ['dial', 'Dial', 'Astronomical dials']] as const) {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = text;
            b.title = tip;
            b.setAttribute('aria-pressed', String(v === view));
            b.addEventListener('click', () => {
                prefs.set(VIEW_KEY, v);
                this.render(...this._last);
            });
            seg.appendChild(b);
        }
        const right = document.createElement('div');
        right.className = 'sun-charts-tools';
        right.append(seg, sel);
        head.append(title, right);

        const body = document.createElement('div');
        if (view === 'dial') {
            body.className = 'sun-dials';
            body.append(buildDayDial(coords, date, time, off, durationMin), buildYearDial(coords, date));
        } else {
            body.className = 'sun-lines';
            body.append(buildDayChart(coords, date, time, off, durationMin), buildYearChart(coords, date));
        }
        this.el.append(head, body);
        const spans = this._spanStrip(coords, date, time, off, durationMin);
        if (spans) body.firstElementChild?.after(spans);
        return this.el;
    }

    /** Proportional strip + legend of the light phases the recording passes through. */
    _spanStrip(c: Coords, date: string, time: string | null, off: number, durationMin: number) {
        const m = String(time ?? '').match(/^(\d{1,2}):(\d{2})/);
        if (!m || durationMin < 1) return null;
        const start = +m[1] * 60 + +m[2];
        const spans = phaseSpans(c.lat, c.lon, date, start, durationMin, off);
        if (spans.length < 2) return null; // stays in one light phase: the summary line says it
        const box = document.createElement('div');
        box.className = 'sun-spans';
        const bar = document.createElement('div');
        bar.className = 'sun-spans-bar';
        const legend = document.createElement('div');
        legend.className = 'sun-spans-legend';
        const total = spans.reduce((t, s) => t + (s.to - s.from), 0) || 1;
        const short = (min: number) => formatDuration(min).replace(' min', 'm').replace(' h ', 'h ');
        // Aggregate per phase for the legend (a long recording can pass a phase twice)
        const sum = new Map<SunPhase, number>();
        for (const s of spans) {
            const seg = document.createElement('span');
            seg.style.flexGrow = String(s.to - s.from);
            seg.style.background = PHASE_COLOR[s.phase];
            seg.title = `${formatClock(s.from)}–${formatClock(s.to)} · ${SUN_PHASE_TEXT[s.phase]} · ${short(s.to - s.from)}`;
            bar.appendChild(seg);
            sum.set(s.phase, (sum.get(s.phase) || 0) + (s.to - s.from));
        }
        for (const [p, min] of sum) {
            const item = document.createElement('span');
            const sw = document.createElement('i');
            sw.style.background = PHASE_COLOR[p];
            item.append(sw, `${SUN_PHASE_TEXT[p].replace(' twilight', '')} ${short(min)}`);
            item.title = `${Math.round((min / total) * 100)} % of the recording`;
            legend.appendChild(item);
        }
        const title = document.createElement('div');
        title.className = 'sun-spans-title';
        title.textContent = `Recording ${formatClock(start)}–${formatClock(start + durationMin)} · ${short(durationMin)}${durationMin > 1440 ? ' (first 24 h shown above)' : ''}`;
        box.append(title, bar, legend);
        return box;
    }
}
