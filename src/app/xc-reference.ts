// xc-reference.ts — Xeno-canto reference search for the Lite panel "Reference" (Annotate v2, mockup R1)
//
// Pure parts: filters → XC API v3 query, a recording of the API → tile data (length, distance, month, licence),
// sorting. The network call is injected, so the panel and the tests share the same logic.

export type XcSort = 'quality' | 'distance' | 'length' | 'similar';

export interface XcFilters {
    /** XC sound type ('' = any), e.g. 'song', 'call', 'alarm call'. */
    type: string;
    /** 'A' only, 'AB' = better than C, 'any'. */
    quality: 'A' | 'AB' | 'any';
    /** Longest recording in seconds (0 = any). */
    maxLenS: number;
    /** Radius around the project location in km (0 = world). */
    nearKm: number;
    /** Only recordings from the same months as the own recording (±1). */
    sameSeason: boolean;
}

export const DEFAULT_FILTERS: XcFilters = { type: 'song', quality: 'AB', maxLenS: 60, nearKm: 500, sameSeason: false };

export interface XcRef {
    id: string;
    type: string;
    q: string;
    lenS: number;
    country: string;
    recordist: string;
    month: number | null;
    distKm: number | null;
    licence: string;
    sono: string;
    lat: number | null;
    lon: number | null;
    /** Similarity to the own clip (cosine of Perch embeddings), once ranked. */
    sim?: number;
    /** Start (s) of the most similar 5-s window. */
    simStart?: number;
}

/** Ranked first by similarity (unranked keep their order after them). */
export function bySimilarity(list: XcRef[]): XcRef[] {
    return list.map((r, i) => ({ r, i })).sort((a, b) => {
        const sa = a.r.sim ?? -Infinity, sb = b.r.sim ?? -Infinity;
        return sb - sa || a.i - b.i;
    }).map((x) => x.r);
}

export interface LatLon { lat: number; lon: number }

const enc = encodeURIComponent;

/** Seconds of an XC length "m:ss" / "h:mm:ss". */
export function parseXcLength(len: unknown): number {
    if (len == null || len === '') return 0;
    const parts = String(len).split(':').map(Number);
    if (parts.some((p) => !Number.isFinite(p))) return 0;
    return parts.reduce((s, p) => s * 60 + p, 0);
}

/** Great-circle distance in km. */
export function distanceKm(a: LatLon, b: LatLon): number {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Lat/lon box around `c` that contains the circle of `km` (XC `box:` tag: lat_min,lon_min,lat_max,lon_max). */
export function boxAround(c: LatLon, km: number): [number, number, number, number] {
    const dLat = km / 111.2;
    const dLon = km / (111.2 * Math.max(0.05, Math.cos(c.lat * Math.PI / 180)));
    const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));
    return [clamp(c.lat - dLat, 90), clamp(c.lon - dLon, 180), clamp(c.lat + dLat, 90), clamp(c.lon + dLon, 180)];
}

/** XC length tag for "at most `s` seconds" (XC takes seconds, `len:"<60"`). */
function lenTag(s: number) { return s > 0 ? `len:${enc(`"<${Math.round(s)}"`)}` : ''; }

/** Query string (without page/key) for one species name "Genus epithet". */
export function buildXcQuery(name: string, f: XcFilters, where: LatLon | null): string {
    const [genus = '', epithet = ''] = name.trim().split(/\s+/);
    if (!genus) throw new Error('Invalid scientific name');
    const tags = [`gen:${enc(genus)}`];
    if (epithet) tags.push(`sp:${enc(epithet)}`);
    if (f.type) tags.push(`type:${enc(`"${f.type}"`)}`);
    if (f.quality === 'A') tags.push('q:A');
    else if (f.quality === 'AB') tags.push(`q:${enc('">C"')}`);
    const len = lenTag(f.maxLenS);
    if (len) tags.push(len);
    if (where && f.nearKm > 0) tags.push(`box:${boxAround(where, f.nearKm).map((v) => v.toFixed(2)).join(',')}`);
    return tags.join('+');
}

/** Readable licence ("CC BY-NC-SA 4.0") from the XC licence URL. */
export function licenceLabel(lic: unknown): string {
    const s = String(lic || '');
    const m = s.match(/creativecommons\.org\/licenses\/([^/]+)\/([^/]+)/i);
    if (m) return `CC ${m[1].toUpperCase()} ${m[2]}`;
    return /publicdomain|zero|cc0/i.test(s) ? 'CC0' : '';
}

const num = (v: unknown) => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : null; };
const abs = (u: unknown) => { const s = String(u || ''); return s.startsWith('//') ? `https:${s}` : s; };

/** One API recording → tile data; distance to `where` when both have coordinates. */
export function toXcRef(r: any, where: LatLon | null): XcRef {
    const lat = num(r?.lat), lon = num(r?.lon ?? r?.lng);
    const m = /^\d{4}-(\d{2})/.exec(String(r?.date || ''));
    const month = m && +m[1] >= 1 && +m[1] <= 12 ? +m[1] : null;
    return {
        id: String(r?.id ?? ''),
        type: String(r?.type || '').trim(),
        q: String(r?.q || '').trim(),
        lenS: parseXcLength(r?.len ?? r?.length),
        country: String(r?.cnt || ''),
        recordist: String(r?.rec || ''),
        month,
        distKm: where && lat != null && lon != null ? Math.round(distanceKm(where, { lat, lon })) : null,
        licence: licenceLabel(r?.lic),
        sono: abs(r?.sono?.med || r?.sono?.small),
        lat, lon,
    };
}

/** Month distance on the circle (Dec ↔ Jan = 1). */
function monthGap(a: number, b: number) { const d = Math.abs(a - b) % 12; return Math.min(d, 12 - d); }

const Q_RANK: Record<string, number> = { A: 0, B: 1, C: 2, D: 3, E: 4 };

/**
 * Filters the API cannot do (exact radius, season) and the sort order.
 * Quality sort: quality, then distance, then shorter first.
 */
export function refineRefs(list: XcRef[], f: XcFilters, opts: { month?: number | null; sort?: XcSort } = {}): XcRef[] {
    let out = list.filter((r) => r.id);
    if (f.nearKm > 0) out = out.filter((r) => r.distKm == null || r.distKm <= f.nearKm);
    if (f.sameSeason && opts.month) out = out.filter((r) => r.month == null || monthGap(r.month, opts.month!) <= 1);
    const q = (r: XcRef) => Q_RANK[r.q] ?? 5;
    const d = (r: XcRef) => r.distKm ?? Infinity;
    const by: Record<XcSort, (a: XcRef, b: XcRef) => number> = {
        quality: (a, b) => q(a) - q(b) || d(a) - d(b) || a.lenS - b.lenS,
        distance: (a, b) => d(a) - d(b) || q(a) - q(b),
        length: (a, b) => a.lenS - b.lenS || q(a) - q(b),
        // ranked later (embeddings); until then quality order decides which get ranked first
        similar: (a, b) => q(a) - q(b) || d(a) - d(b) || a.lenS - b.lenS,
    };
    return out.sort(by[opts.sort || 'quality']);
}

export interface XcPage { recordings: any[]; numRecordings: number; numPages: number }

/**
 * Search one species: tries each name (taxonomy spelling first, XC's next), relaxes nothing else.
 * `fetchPage(query, page)` does the HTTP call (key, cache) outside.
 */
export async function searchXcRefs(names: string[], f: XcFilters, where: LatLon | null,
    fetchPage: (query: string, page: number) => Promise<XcPage>, page = 1):
    Promise<{ name: string; total: number; pages: number; refs: XcRef[] }> {
    let last = { name: names[0] || '', total: 0, pages: 0, refs: [] as XcRef[] };
    for (const name of names.filter(Boolean)) {
        const res = await fetchPage(buildXcQuery(name, f, where), page);
        last = { name, total: res.numRecordings, pages: res.numPages, refs: res.recordings.map((r) => toXcRef(r, where)) };
        if (res.recordings.length) break;
    }
    return last;
}
