/**
 * Sun position, twilight phases and day length for a place and date.
 *
 * NOAA's low-precision solar formulas (Spencer series for declination and equation of time),
 * accurate to about a minute for sunrise/sunset outside the polar regions — enough to tell
 * where in the day and year a recording sits. All times are minutes after local midnight in
 * the zone given by `utcOffsetH`; values outside 0…1440 belong to the previous/next day.
 */

const RAD = Math.PI / 180;

/** Sun altitude thresholds in degrees (upper limb with refraction for sunrise/sunset). */
export const SUN_ALT = { horizon: -0.833, civil: -6, nautical: -12, astronomical: -18, golden: 6 } as const;

export type SunPhase = 'night' | 'astronomical' | 'nautical' | 'civil' | 'golden' | 'day';

export const SUN_PHASE_TEXT: Record<SunPhase, string> = {
    night: 'Night',
    astronomical: 'Astronomical twilight',
    nautical: 'Nautical twilight',
    civil: 'Civil twilight',
    golden: 'Low sun',
    day: 'Day',
};

/** Day of year, 1-based, for a YYYY-MM-DD date (UTC calendar). */
export function dayOfYear(date: string): number {
    const [y, m, d] = date.split('-').map(Number);
    return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000) + 1;
}

export function daysInYear(year: number): number {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
}

/** Declination (rad) and equation of time (minutes) at a fractional day of year. */
export function solarParams(doy: number, hourUtc = 12, yearDays = 365) {
    const g = (2 * Math.PI / yearDays) * (doy - 1 + (hourUtc - 12) / 24);
    const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
        - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
        - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
        - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    return { decl, eqTime };
}

/** Sun altitude in degrees at `minutes` local clock time. */
export function sunAltitude(lat: number, lon: number, doy: number, minutes: number, utcOffsetH = 0, yearDays = 365): number {
    const utcMin = minutes - utcOffsetH * 60;
    const { decl, eqTime } = solarParams(doy, utcMin / 60, yearDays);
    const trueSolar = utcMin + eqTime + 4 * lon;
    const ha = (trueSolar / 4 - 180) * RAD;
    const cosZ = Math.sin(lat * RAD) * Math.sin(decl) + Math.cos(lat * RAD) * Math.cos(decl) * Math.cos(ha);
    return 90 - Math.acos(Math.max(-1, Math.min(1, cosZ))) / RAD;
}

/**
 * Local clock times (minutes) when the sun crosses `altitude` on that day, or a flag when it
 * never does (polar day / polar night for that threshold).
 */
export function crossing(lat: number, lon: number, doy: number, altitude: number, utcOffsetH = 0, yearDays = 365):
    { rise: number; set: number } | 'always-above' | 'always-below' {
    const { decl, eqTime } = solarParams(doy, 12, yearDays);
    const cosH = (Math.sin(altitude * RAD) - Math.sin(lat * RAD) * Math.sin(decl)) / (Math.cos(lat * RAD) * Math.cos(decl));
    if (cosH < -1) return 'always-above';
    if (cosH > 1) return 'always-below';
    const h = Math.acos(cosH) / RAD; // degrees
    const noon = 720 - 4 * lon - eqTime + utcOffsetH * 60;
    return { rise: noon - 4 * h, set: noon + 4 * h };
}

/** Solar noon in local clock minutes. */
export function solarNoon(lon: number, doy: number, utcOffsetH = 0, yearDays = 365): number {
    return 720 - 4 * lon - solarParams(doy, 12, yearDays).eqTime + utcOffsetH * 60;
}

/** Hours of daylight (sunrise to sunset). */
export function dayLengthHours(lat: number, doy: number, yearDays = 365): number {
    const c = crossing(lat, 0, doy, SUN_ALT.horizon, 0, yearDays);
    if (c === 'always-above') return 24;
    if (c === 'always-below') return 0;
    return (c.set - c.rise) / 60;
}

export function phaseOf(altitude: number): SunPhase {
    if (altitude >= SUN_ALT.golden) return 'day';
    if (altitude >= SUN_ALT.horizon) return 'golden';
    if (altitude >= SUN_ALT.civil) return 'civil';
    if (altitude >= SUN_ALT.nautical) return 'nautical';
    if (altitude >= SUN_ALT.astronomical) return 'astronomical';
    return 'night';
}

export interface SunDay {
    doy: number;
    yearDays: number;
    noon: number;
    /** Per threshold: rise/set minutes or a polar flag. */
    events: Record<'horizon' | 'civil' | 'nautical' | 'astronomical', ReturnType<typeof crossing>>;
    dayLengthH: number;
}

export function sunDay(lat: number, lon: number, date: string, utcOffsetH = 0): SunDay {
    const doy = dayOfYear(date);
    const yearDays = daysInYear(Number(date.slice(0, 4)));
    const ev = (a: number) => crossing(lat, lon, doy, a, utcOffsetH, yearDays);
    return {
        doy, yearDays,
        noon: solarNoon(lon, doy, utcOffsetH, yearDays),
        events: { horizon: ev(SUN_ALT.horizon), civil: ev(SUN_ALT.civil), nautical: ev(SUN_ALT.nautical), astronomical: ev(SUN_ALT.astronomical) },
        dayLengthH: dayLengthHours(lat, doy, yearDays),
    };
}

/**
 * Best guess of the local clock's UTC offset from the coordinates: the nautical zone
 * (lon/15) plus European summer time inside Europe. The user can correct it.
 */
export function guessUtcOffset(lat: number, lon: number, date: string): number {
    let off = Math.round(lon / 15);
    const inEurope = lat > 35 && lat < 72 && lon > -11 && lon < 40;
    if (inEurope) {
        // Western/Central/Eastern European time rather than the nautical zones
        if (lon < -7.5 || (lat > 49.8 && lon < 1.8)) off = 0;   // Portugal, Ireland, UK
        else if (lon < 22) off = 1;                              // Spain … Poland
        else off = 2;                                            // Finland, Baltics, Greece, Romania …
        const y = Number(date.slice(0, 4));
        const lastSunday = (m: number) => { const d = new Date(Date.UTC(y, m + 1, 0)); return d.getUTCDate() - d.getUTCDay(); };
        const md = date.slice(5);
        const start = `03-${String(lastSunday(2)).padStart(2, '0')}`;
        const end = `10-${String(lastSunday(9)).padStart(2, '0')}`;
        if (md >= start && md < end) off += 1;
    }
    return off;
}

/** Meteorological season for a month (1–12), hemisphere-aware. */
export type Season = 'winter' | 'spring' | 'summer' | 'autumn';
export function seasonOf(month: number, lat: number): Season {
    const north: Season[] = ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'];
    const s = north[month - 1];
    if (lat >= 0) return s;
    return ({ winter: 'summer', summer: 'winter', spring: 'autumn', autumn: 'spring' } as const)[s];
}

/** "early/mid/late" within the meteorological season. */
export function seasonPart(month: number): 'early' | 'mid' | 'late' {
    return (['mid', 'late', 'early', 'mid', 'late', 'early', 'mid', 'late', 'early', 'mid', 'late', 'early'] as const)[month - 1];
}

export function formatClock(minutes: number): string {
    const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function formatDuration(minutes: number): string {
    const m = Math.round(Math.abs(minutes));
    const h = Math.floor(m / 60);
    return h ? `${h} h ${m % 60} min` : `${m} min`;
}
