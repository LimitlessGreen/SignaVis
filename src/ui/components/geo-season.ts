/**
 * Season at a place from the BirdNET geomodel: weeks 1–48 (four per month).
 * Pure helpers (no DOM) for the year chart and the "unusual here now" hint.
 */

export const GEO_WEEKS = 48;
const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

/** BirdNET geo week of a date: 4 per month, 1–48 (days 22–31 are week 4). Null for invalid dates. */
export function geoWeek(date: Date | string | null | undefined): number | null {
  if (date == null || date === '') return null;
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return null;
  return d.getMonth() * 4 + Math.min(3, Math.floor((d.getDate() - 1) / 7)) + 1;
}

export interface SeasonSummary {
  peak: number;
  peakWeek: number;
  /** Score in the recording week, null without date. */
  current: number | null;
  week: number | null;
  /** Recording week below the threshold: the area filter would drop this species. */
  unusual: boolean;
  /** Weeks at or above the threshold, as inclusive ranges (wrapping over the new year is split). */
  presentRanges: Array<[number, number]>;
}

export function summarizeSeason(scores: ArrayLike<number>, week: number | null, threshold: number): SeasonSummary {
  let peak = -1, peakWeek = 1;
  const ranges: Array<[number, number]> = [];
  let start = 0;
  for (let w = 1; w <= GEO_WEEKS; w++) {
    const v = Number(scores[w - 1]) || 0;
    if (v > peak) { peak = v; peakWeek = w; }
    const on = v >= threshold;
    if (on && !start) start = w;
    if (!on && start) { ranges.push([start, w - 1]); start = 0; }
  }
  if (start) ranges.push([start, GEO_WEEKS]);
  const current = week != null && week >= 1 && week <= GEO_WEEKS ? Number(scores[week - 1]) || 0 : null;
  return {
    peak: Math.max(0, peak), peakWeek, current, week: current == null ? null : week,
    unusual: current != null && current < threshold,
    presentRanges: ranges,
  };
}

/** "early Mar" etc. for a geo week. */
export function weekLabel(week: number): string {
  const m = Math.floor((week - 1) / 4);
  const q = (week - 1) % 4;
  const part = q === 0 ? 'early' : q === 3 ? 'late' : 'mid';
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${part} ${names[m]}`;
}

/** Text for the present weeks, e.g. "early Apr – late Sep"; "all year"; "never". */
export function presentText(ranges: Array<[number, number]>): string {
  if (!ranges.length) return 'not expected';
  if (ranges.length === 1 && ranges[0][0] === 1 && ranges[0][1] === GEO_WEEKS) return 'all year';
  // Join a range over the new year (…–48 and 1–…) into one.
  const r = ranges.map((x) => [...x] as [number, number]);
  if (r.length > 1 && r[0][0] === 1 && r[r.length - 1][1] === GEO_WEEKS) {
    const last = r.pop()!; r[0][0] = last[0];
  }
  return r.map(([a, b]) => `${weekLabel(a)} – ${weekLabel(b)}`).join(', ');
}

const esc = (n: number) => (Math.round(n * 10) / 10).toString();

/**
 * SVG markup of the year chart: area of the scores (0–1), threshold line, month ticks,
 * marker at the recording week.
 */
export function seasonChartSvg(scores: ArrayLike<number>, opts: { week?: number | null; threshold?: number; width?: number; height?: number } = {}): string {
  const W = opts.width ?? 240, H = opts.height ?? 56, padB = 12;
  const ph = H - padB;
  const x = (w: number) => ((w - 0.5) / GEO_WEEKS) * W;
  const y = (v: number) => ph - Math.max(0, Math.min(1, v)) * (ph - 2);
  let d = `M0 ${ph}`;
  for (let w = 1; w <= GEO_WEEKS; w++) d += ` L${esc(x(w))} ${esc(y(Number(scores[w - 1]) || 0))}`;
  d += ` L${W} ${ph} Z`;
  const parts = [`<svg class="geo-season-chart" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Expected occurrence over the year">`];
  parts.push(`<path class="geo-season-area" d="${d}"/>`);
  if (opts.threshold != null) {
    const ty = esc(y(opts.threshold));
    parts.push(`<line class="geo-season-threshold" x1="0" x2="${W}" y1="${ty}" y2="${ty}"/>`);
  }
  for (let m = 0; m < 12; m++) {
    const mx = esc((m * 4 / GEO_WEEKS) * W);
    parts.push(`<line class="geo-season-tick" x1="${mx}" x2="${mx}" y1="${ph}" y2="${ph + 3}"/>`);
    parts.push(`<text class="geo-season-month" x="${esc(((m * 4 + 2) / GEO_WEEKS) * W)}" y="${H - 1}" text-anchor="middle">${MONTHS[m]}</text>`);
  }
  if (opts.week != null && opts.week >= 1 && opts.week <= GEO_WEEKS) {
    const wx = esc(x(opts.week));
    parts.push(`<line class="geo-season-now" x1="${wx}" x2="${wx}" y1="0" y2="${ph}"/>`);
    parts.push(`<circle class="geo-season-now-dot" cx="${wx}" cy="${esc(y(Number(scores[opts.week - 1]) || 0))}" r="2.5"/>`);
  }
  parts.push('</svg>');
  return parts.join('');
}
