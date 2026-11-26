/**
 * Moon position and phase, low precision (truncated Meeus series, as used by many planetarium
 * widgets): altitude within about half a degree, rise/set within a few minutes, phase within
 * a few hours. Enough to say whether the moon was up during a recording and how bright it was.
 */

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;
const J2000 = Date.UTC(2000, 0, 1, 12);
const OBLIQUITY = 23.4397 * RAD;
/** Altitude of the moon's centre at rise/set: parallax minus semi-diameter and refraction. */
export const MOON_HORIZON = 0.125;

export type MoonPhaseName =
    | 'new moon' | 'waxing crescent' | 'first quarter' | 'waxing gibbous'
    | 'full moon' | 'waning gibbous' | 'last quarter' | 'waning crescent';

export interface MoonIllumination {
    /** Lit part of the disc, 0…1. */
    fraction: number;
    /** Position in the cycle: 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter. */
    phase: number;
    waxing: boolean;
    name: MoonPhaseName;
}

const days = (ms: number) => (ms - J2000) / DAY_MS;

function equatorial(lonEcl: number, latEcl: number) {
    const ra = Math.atan2(Math.sin(lonEcl) * Math.cos(OBLIQUITY) - Math.tan(latEcl) * Math.sin(OBLIQUITY), Math.cos(lonEcl));
    const dec = Math.asin(Math.sin(latEcl) * Math.cos(OBLIQUITY) + Math.cos(latEcl) * Math.sin(OBLIQUITY) * Math.sin(lonEcl));
    return { ra, dec };
}

function moonCoords(d: number) {
    const L = RAD * (218.316 + 13.176396 * d);  // mean longitude
    const M = RAD * (134.963 + 13.064993 * d);  // mean anomaly
    const F = RAD * (93.272 + 13.22935 * d);    // mean distance from the ascending node
    const lon = L + RAD * 6.289 * Math.sin(M);
    const lat = RAD * 5.128 * Math.sin(F);
    return { ...equatorial(lon, lat), dist: 385001 - 20905 * Math.cos(M) };
}

function sunCoords(d: number) {
    const M = RAD * (357.5291 + 0.98560028 * d);
    const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    const lon = M + C + RAD * 102.9372 + Math.PI;
    return { ...equatorial(lon, 0), dist: 149598000 };
}

/** Moon altitude (degrees, topocentric, without refraction) at a UTC instant. */
export function moonAltitudeAt(lat: number, lon: number, ms: number): number {
    const d = days(ms);
    const m = moonCoords(d);
    const H = RAD * (280.16 + 360.9856235 * d) + lon * RAD - m.ra;
    const phi = lat * RAD;
    const h = Math.asin(Math.sin(phi) * Math.sin(m.dec) + Math.cos(phi) * Math.cos(m.dec) * Math.cos(H));
    // Parallax: the moon is close enough that the observer's place on the globe shifts it
    const parallax = Math.asin(6378.14 / m.dist) * Math.cos(h);
    return (h - parallax) / RAD;
}

/** UTC milliseconds of a local clock time on `date` (YYYY-MM-DD). */
export function localToUtcMs(date: string, minutes: number, utcOffsetH = 0): number {
    const [y, mo, da] = date.split('-').map(Number);
    return Date.UTC(y, mo - 1, da) + (minutes - utcOffsetH * 60) * 60_000;
}

/** Moon altitude in degrees at `minutes` local clock time on `date`. */
export function moonAltitude(lat: number, lon: number, date: string, minutes: number, utcOffsetH = 0): number {
    return moonAltitudeAt(lat, lon, localToUtcMs(date, minutes, utcOffsetH));
}

export function moonIlluminationAt(ms: number): MoonIllumination {
    const d = days(ms);
    const s = sunCoords(d);
    const m = moonCoords(d);
    const elong = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
    const inc = Math.atan2(s.dist * Math.sin(elong), m.dist - s.dist * Math.cos(elong));
    const angle = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra),
        Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra));
    const phase = 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / Math.PI;
    return { fraction: (1 + Math.cos(inc)) / 2, phase, waxing: phase < 0.5, name: phaseName(phase) };
}

export function moonIllumination(date: string, minutes = 720, utcOffsetH = 0): MoonIllumination {
    return moonIlluminationAt(localToUtcMs(date, minutes, utcOffsetH));
}

/** Eight named phases; the quarters and full/new each cover ±1/32 of the cycle (~0.9 days). */
export function phaseName(phase: number): MoonPhaseName {
    const p = ((phase % 1) + 1) % 1;
    const names: MoonPhaseName[] = ['new moon', 'waxing crescent', 'first quarter', 'waxing gibbous',
        'full moon', 'waning gibbous', 'last quarter', 'waning crescent'];
    const exact = [0, 0.25, 0.5, 0.75, 1];
    for (let i = 0; i < exact.length; i++) if (Math.abs(p - exact[i]) <= 1 / 32) return names[(i * 2) % 8];
    return names[Math.floor(p * 4) * 2 + 1];
}

export interface MoonEvent { kind: 'rise' | 'set'; minutes: number }

/**
 * Moonrises and moonsets on that local day (0, 1 or 2 events; the moon rises about 50 min later
 * each day, so some days have no rise or no set).
 */
export function moonEvents(lat: number, lon: number, date: string, utcOffsetH = 0, step = 10): MoonEvent[] {
    const out: MoonEvent[] = [];
    let prev = moonAltitude(lat, lon, date, 0, utcOffsetH) - MOON_HORIZON;
    for (let m = step; m <= 1440; m += step) {
        const cur = moonAltitude(lat, lon, date, m, utcOffsetH) - MOON_HORIZON;
        if ((prev < 0) !== (cur < 0)) {
            out.push({ kind: cur > 0 ? 'rise' : 'set', minutes: m - step + (step * prev) / (prev - cur) });
        }
        prev = cur;
    }
    return out;
}
