/**
 * Configuration shared by all charts and dials: texts (English and German built in), colours,
 * clock format. Every builder takes a partial `SunChartConfig`; missing parts fall back to the
 * defaults (English, 24 h, the built-in palette).
 */

import { formatClock, type Season, type SunPhase } from './sun.ts';
import type { MoonPhaseName } from './moon.ts';

export type SunEventName = 'sunrise' | 'sunset';
export type Solstice = 'longest' | 'shortest';

export interface SunLabels {
    /** BCP 47 locale for dates in tooltips (undefined = browser default). */
    locale?: string;
    title: string;
    viewGroup: string;
    viewChart: string;
    viewChartTip: string;
    viewDial: string;
    viewDialTip: string;
    zoneTip: string;
    zoneLocal: string;
    dayChartTitle: string;
    yearChartTitle: string;
    dayDialAria: string;
    yearDialAria: string;
    phases: Record<SunPhase, string>;
    phasesShort: Record<SunPhase, string>;
    seasons: Record<Season, string>;
    /** "Early summer" */
    seasonHeading(part: 'early' | 'mid' | 'late', season: Season): string;
    /** One letter per month, January first. */
    months: string[];
    /** "1 h 22 min" */
    duration(minutes: number): string;
    /** "1h 22m" (for the dial centres) */
    durationShort(minutes: number): string;
    daylight(duration: string): string;
    trendSteady: string;
    /** signed: "+1.2" or "−0.4" */
    trendPerDay(signed: string): string;
    solsticeToday: string;
    daysToSolstice(days: number, which: Solstice): string;
    daysToSolsticeShort(days: number, which: Solstice): string;
    relToSunEvent(duration: string, before: boolean, event: SunEventName): string;
    sunAt(degrees: string, startsAt: boolean): string;
    noTimeHint: string;
    eventCols: { astronomical: string; nautical: string; civil: string; sun: string };
    eventColTips: { astronomical: string; nautical: string; civil: string; sun: string };
    dawn: string;
    dusk: string;
    neverBelow: string;
    neverAbove: string;
    noTime: string;
    dayLengthShort(duration: string): string;
    noSunset: string;
    noSunrise: string;
    recording(from: string, to: string, duration: string, truncated: boolean): string;
    shareOfRecording(percent: number): string;
    equinox: string;
    solstice: string;
    moonPhases: Record<MoonPhaseName, string>;
    moonUp: string;
    moonDown: string;
    moonrise: string;
    moonset: string;
    moonTitle(phase: string, percent: number): string;
}

const dur = (h: string, min: string) => (minutes: number) => {
    const m = Math.round(Math.abs(minutes));
    const hh = Math.floor(m / 60);
    return hh ? `${hh}${h}${m % 60}${min}` : `${m}${min}`;
};

export const LABELS_EN: SunLabels = {
    locale: undefined,
    title: 'Light',
    viewGroup: 'Light view',
    viewChart: 'Chart',
    viewChartTip: 'Time lines',
    viewDial: 'Dial',
    viewDialTip: 'Astronomical dials',
    zoneTip: 'Clock of the recording time. Local time (with summer time) is the usual case; AudioMoth file names are often UTC.',
    zoneLocal: 'Local',
    dayChartTitle: 'Sun & twilight',
    yearChartTitle: 'Season & day length',
    dayDialAria: 'Sun altitude and twilight over the day',
    yearDialAria: 'Season and day length over the year',
    phases: { night: 'Night', astronomical: 'Astronomical twilight', nautical: 'Nautical twilight', civil: 'Civil twilight', golden: 'Low sun', day: 'Day' },
    phasesShort: { night: 'Night', astronomical: 'Astronomical', nautical: 'Nautical', civil: 'Civil', golden: 'Low sun', day: 'Day' },
    seasons: { winter: 'winter', spring: 'spring', summer: 'summer', autumn: 'autumn' },
    seasonHeading: (part, season) => `${part[0].toUpperCase()}${part.slice(1)} ${season}`,
    months: ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'],
    duration: dur(' h ', ' min'),
    durationShort: dur('h ', 'm'),
    daylight: (d) => `${d} daylight`,
    trendSteady: 'about steady',
    trendPerDay: (s) => `${s} min/day`,
    solsticeToday: 'solstice today',
    daysToSolstice: (n, w) => `${n} d to ${w} day`,
    daysToSolsticeShort: (n, w) => `${n} d → ${w}`,
    relToSunEvent: (d, before, ev) => `${d} ${before ? 'before' : 'after'} ${ev}`,
    sunAt: (deg, starts) => `${starts ? 'starts at ' : ''}sun ${deg}°`,
    noTimeHint: 'No recording time — set one to place it in the day.',
    eventCols: { astronomical: 'Astro', nautical: 'Naut.', civil: 'Civil', sun: 'Sun' },
    eventColTips: {
        astronomical: 'Astronomical twilight (sun at −18°)',
        nautical: 'Nautical twilight (sun at −12°)',
        civil: 'Civil twilight (sun at −6°)',
        sun: 'Sunrise / sunset',
    },
    dawn: 'Dawn',
    dusk: 'Dusk',
    neverBelow: 'The sun never sinks this low today',
    neverAbove: 'The sun never rises this high today',
    noTime: 'no time',
    dayLengthShort: (d) => `day ${d}`,
    noSunset: 'no sunset',
    noSunrise: 'no sunrise',
    recording: (a, b, d, cut) => `Recording ${a}–${b} · ${d}${cut ? ' (first 24 h shown above)' : ''}`,
    shareOfRecording: (p) => `${p} % of the recording`,
    equinox: 'Equinox',
    solstice: 'Solstice',
    moonPhases: {
        'new moon': 'new moon', 'waxing crescent': 'waxing crescent', 'first quarter': 'first quarter', 'waxing gibbous': 'waxing gibbous',
        'full moon': 'full moon', 'waning gibbous': 'waning gibbous', 'last quarter': 'last quarter', 'waning crescent': 'waning crescent',
    },
    moonUp: 'up',
    moonDown: 'down',
    moonrise: 'Moonrise',
    moonset: 'Moonset',
    moonTitle: (phase, p) => `Moon: ${phase}, ${p} % lit`,
};

const SEASON_DE: Record<Season, string> = { winter: 'Winter', spring: 'Frühling', summer: 'Sommer', autumn: 'Herbst' };

export const LABELS_DE: SunLabels = {
    locale: 'de',
    title: 'Licht',
    viewGroup: 'Lichtansicht',
    viewChart: 'Diagramm',
    viewChartTip: 'Zeitleisten',
    viewDial: 'Uhr',
    viewDialTip: 'Astronomische Zifferblätter',
    zoneTip: 'Uhr der Aufnahmezeit. Meist Ortszeit (mit Sommerzeit); AudioMoth-Dateinamen sind oft UTC.',
    zoneLocal: 'Ortszeit',
    dayChartTitle: 'Sonne & Dämmerung',
    yearChartTitle: 'Jahreszeit & Taglänge',
    dayDialAria: 'Sonnenhöhe und Dämmerung über den Tag',
    yearDialAria: 'Jahreszeit und Taglänge über das Jahr',
    phases: { night: 'Nacht', astronomical: 'Astronomische Dämmerung', nautical: 'Nautische Dämmerung', civil: 'Bürgerliche Dämmerung', golden: 'Tiefe Sonne', day: 'Tag' },
    phasesShort: { night: 'Nacht', astronomical: 'Astronomisch', nautical: 'Nautisch', civil: 'Bürgerlich', golden: 'Tiefe Sonne', day: 'Tag' },
    seasons: SEASON_DE,
    // Phenological names: Vorfrühling, Hochsommer, Spätherbst …
    seasonHeading: (part, season) => ({
        early: { winter: 'Frühwinter', spring: 'Vorfrühling', summer: 'Frühsommer', autumn: 'Frühherbst' },
        mid: { winter: 'Hochwinter', spring: 'Vollfrühling', summer: 'Hochsommer', autumn: 'Vollherbst' },
        late: { winter: 'Spätwinter', spring: 'Spätfrühling', summer: 'Spätsommer', autumn: 'Spätherbst' },
    } as const)[part][season],
    months: ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'],
    duration: dur(' h ', ' min'),
    durationShort: dur('h ', 'm'),
    daylight: (d) => `${d} Tageslicht`,
    trendSteady: 'etwa gleich',
    trendPerDay: (s) => `${s} min/Tag`,
    solsticeToday: 'heute Sonnenwende',
    daysToSolstice: (n, w) => `noch ${n} T bis zum ${w === 'longest' ? 'längsten' : 'kürzesten'} Tag`,
    daysToSolsticeShort: (n, w) => `${n} T → ${w === 'longest' ? 'längster' : 'kürzester'}`,
    relToSunEvent: (d, before, ev) => `${d} ${before ? 'vor' : 'nach'} ${ev === 'sunrise' ? 'Sonnenaufgang' : 'Sonnenuntergang'}`,
    sunAt: (deg, starts) => `${starts ? 'Beginn bei ' : ''}Sonne ${deg}°`,
    noTimeHint: 'Keine Aufnahmezeit – mit Uhrzeit wird sie im Tag eingeordnet.',
    eventCols: { astronomical: 'Astro', nautical: 'Naut.', civil: 'Bürg.', sun: 'Sonne' },
    eventColTips: {
        astronomical: 'Astronomische Dämmerung (Sonne bei −18°)',
        nautical: 'Nautische Dämmerung (Sonne bei −12°)',
        civil: 'Bürgerliche Dämmerung (Sonne bei −6°)',
        sun: 'Sonnenaufgang / -untergang',
    },
    dawn: 'Morgens',
    dusk: 'Abends',
    neverBelow: 'Die Sonne sinkt heute nicht so tief',
    neverAbove: 'Die Sonne steigt heute nicht so hoch',
    noTime: 'keine Zeit',
    dayLengthShort: (d) => `Tag ${d}`,
    noSunset: 'kein Untergang',
    noSunrise: 'kein Aufgang',
    recording: (a, b, d, cut) => `Aufnahme ${a}–${b} · ${d}${cut ? ' (oben die ersten 24 h)' : ''}`,
    shareOfRecording: (p) => `${p} % der Aufnahme`,
    equinox: 'Tagundnachtgleiche',
    solstice: 'Sonnenwende',
    moonPhases: {
        'new moon': 'Neumond', 'waxing crescent': 'zunehmende Sichel', 'first quarter': 'erstes Viertel', 'waxing gibbous': 'zunehmender Mond',
        'full moon': 'Vollmond', 'waning gibbous': 'abnehmender Mond', 'last quarter': 'letztes Viertel', 'waning crescent': 'abnehmende Sichel',
    },
    moonUp: 'auf',
    moonDown: 'unter',
    moonrise: 'Mondaufgang',
    moonset: 'Monduntergang',
    moonTitle: (phase, p) => `Mond: ${phase}, ${p} % beleuchtet`,
};

/** Built-in label sets by language code. */
export const LABELS: Record<string, SunLabels> = { en: LABELS_EN, de: LABELS_DE };

export interface SunColors {
    phases: Record<SunPhase, string>;
    seasons: Record<Season, string>;
}

/** Sequential night → day ramp, one hue family; low sun is the only warm step. */
export const DEFAULT_COLORS: SunColors = {
    phases: { night: '#0b1430', astronomical: '#1d2e5e', nautical: '#365393', civil: '#6f92cb', golden: '#f0c987', day: '#bfdcf5' },
    seasons: { winter: '#6f9ad6', spring: '#79bd7c', summer: '#e6bb4a', autumn: '#d9844f' },
};

export type ClockFormat = '24h' | '12h';

/** What callers pass: everything optional. */
export interface SunChartConfig {
    /** A language code of a built-in set ('en', 'de') or a full/partial label set. */
    labels?: string | Partial<SunLabels>;
    /** Overrides for single colours; CSS variables (--sun-phase-civil, …) win over these. */
    colors?: { phases?: Partial<Record<SunPhase, string>>; seasons?: Partial<Record<Season, string>> };
    clock?: ClockFormat;
}

/** Resolved form used inside the builders. */
export interface ResolvedConfig {
    t: SunLabels;
    colors: SunColors;
    clock: ClockFormat;
    /** Clock time, e.g. "04:10" or "4:10 AM". */
    time(minutes: number): string;
    /** Compact clock time for tight spots, e.g. "04:10" or "4:10a". */
    timeShort(minutes: number): string;
    /** Hour label on axes, e.g. "06" or "6a". */
    hour(h: number): string;
    /** CSS paint value: the CSS variable, falling back to the configured colour. */
    phaseFill(p: SunPhase): string;
    seasonFill(s: Season): string;
}

function clock12(minutes: number, compact: boolean) {
    const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
    const h = Math.floor(m / 60);
    const h12 = h % 12 || 12;
    const ap = h < 12 ? 'AM' : 'PM';
    return `${h12}:${String(m % 60).padStart(2, '0')}${compact ? ap[0].toLowerCase() : ` ${ap}`}`;
}

export function resolveConfig(cfg: SunChartConfig = {}): ResolvedConfig {
    const base = typeof cfg.labels === 'string' ? LABELS[cfg.labels.slice(0, 2).toLowerCase()] ?? LABELS_EN : LABELS_EN;
    const t: SunLabels = typeof cfg.labels === 'object' ? { ...LABELS_EN, ...cfg.labels } : base;
    const colors: SunColors = {
        phases: { ...DEFAULT_COLORS.phases, ...cfg.colors?.phases },
        seasons: { ...DEFAULT_COLORS.seasons, ...cfg.colors?.seasons },
    };
    const clock = cfg.clock ?? '24h';
    const twelve = clock === '12h';
    return {
        t, colors, clock,
        time: (m) => (twelve ? clock12(m, false) : formatClock(m)),
        timeShort: (m) => (twelve ? clock12(m, true) : formatClock(m)),
        hour: (h) => {
            const hh = ((h % 24) + 24) % 24;
            return twelve ? `${hh % 12 || 12}${hh < 12 ? 'a' : 'p'}` : String(h).padStart(2, '0');
        },
        phaseFill: (p) => `var(--sun-phase-${p}, ${colors.phases[p]})`,
        seasonFill: (s) => `var(--sun-season-${s}, ${colors.seasons[s]})`,
    };
}
