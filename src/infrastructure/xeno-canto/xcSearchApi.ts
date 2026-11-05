// ═══════════════════════════════════════════════════════════════════════
// xcSearchApi.ts — Xeno-canto v3 recordings search (needs an API key)
// ═══════════════════════════════════════════════════════════════════════

import { readStoredXcApiKey } from './xcHelpers.ts';

// v2 was switched off (HTTP 404). v3 needs `key=` and tag-only queries.
export const XC_SEARCH_ENDPOINT = 'https://xeno-canto.org/api/3/recordings';

/**
 * A single recording entry returned by the XC v3 search API.
 * Only the fields we map are listed; the raw API has more.
 */
export interface XcRecording {
    /** Numeric recording ID (as string from XC API). */
    id: string;
    /** Genus name. */
    gen: string;
    /** Species epithet. */
    sp: string;
    /** English common name. */
    en: string;
    /** Country of recording. */
    cnt: string;
    /** Locality (place name string). */
    loc: string;
    /** Latitude (decimal degrees as string). */
    lat: string;
    /** Longitude (decimal degrees as string). */
    lng: string;
    /** Altitude (metres as string). */
    alt: string;
    /** Date of recording (YYYY-MM-DD or partial). */
    date: string;
    /** Time of recording (HH:MM). */
    time: string;
    /** Call type (e.g. "song", "call"). */
    type: string;
    /** Quality rating (A–E). */
    q: string;
    /** Duration (m:ss). */
    len: string;
    /** Recordist name. */
    rec: string;
    /** License string. */
    lic: string;
    /** URL of the recording page on xeno-canto.org. */
    url: string;
    /** Direct URL of the audio file (mp3). */
    file: string;
    /** Original filename. */
    'file-name': string;
    /** XC thumbnail image URL. */
    sono?: { small?: string; med?: string };
}

export interface XcSearchResult {
    /** Total matching recordings across all pages. */
    numRecordings: string;
    /** Total matching species across all pages. */
    numSpecies: string;
    /** Current page (1-based). */
    page: number;
    /** Total pages. */
    numPages: number;
    recordings: XcRecording[];
}

export interface XcSearchOptions {
    /** Page number (1-based, default 1). */
    page?: number;
    /** XC API key; defaults to the key saved in the XC panel. */
    apiKey?: string;
    /** Fetch implementation override (for testing/proxies). */
    fetchImpl?: typeof fetch;
}

/**
 * v3 accepts only tag queries (`gen:`, `sp:`, `en:`, `cnt:` …). Free text is
 * translated: a Latin binomial ("Turdus merula") becomes `gen:Turdus sp:merula`,
 * anything else is searched as English name (`en:"Common Blackbird"`).
 * Queries that already contain a tag are passed through unchanged.
 * Heuristic: "Capitalised lowercase" is read as a binomial, so a two-word
 * English name must be written in XC's title case ("Common Blackbird").
 */
export function toV3Query(query: string): string {
    const q = String(query ?? '').trim().replace(/\s+/g, ' ');
    if (!q || /(^|\s)[a-z-]+:/i.test(q)) return q;
    const words = q.split(' ');
    if (words.length === 2 && /^[A-Z][a-z]+$/.test(words[0]) && /^[a-z-]+$/.test(words[1])) {
        return `gen:${words[0]} sp:${words[1]}`;
    }
    if (words.length === 1 && /^[A-Z][a-z]+$/.test(words[0])) return `gen:${words[0]}`;
    return `en:"${q}"`;
}

/**
 * Searches Xeno-canto recordings using the v3 API.
 *
 * @param query  Free-form XC query, e.g. "Turdus merula" or "cnt:Germany grp:birds"
 * @param options Optional pagination / fetch override.
 */
export async function searchXenoCantoRecordings(
    query: string,
    options: XcSearchOptions = {},
): Promise<XcSearchResult> {
    const fetchFn: typeof fetch = options.fetchImpl ?? globalThis.fetch;
    if (!fetchFn) throw new Error('No fetch implementation available.');

    const apiKey = (options.apiKey ?? readStoredXcApiKey()).trim();
    if (!apiKey) throw new Error('XC API key required. Add your key in the XC API panel (xeno-canto.org → account → API key).');

    const page = options.page ?? 1;
    const params = new URLSearchParams({ query: toV3Query(query), page: String(page), key: apiKey });
    const url = `${XC_SEARCH_ENDPOINT}?${params}`;

    const res = await fetchFn(url);
    if (!res.ok) {
        // v3 explains client errors as { error, message } (e.g. invalid key, bad tag).
        const body = await res.json().catch(() => null);
        throw new Error(`XC search HTTP ${res.status}: ${body?.message || res.statusText}`);
    }

    const data: XcSearchResult = await res.json();
    if (!Array.isArray(data.recordings)) {
        data.recordings = [];
    }
    return data;
}
