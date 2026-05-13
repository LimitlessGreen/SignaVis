// ═══════════════════════════════════════════════════════════════════════
// xcSearchApi.ts — Xeno-canto v2 recordings search (free, no API key)
// ═══════════════════════════════════════════════════════════════════════

export const XC_SEARCH_ENDPOINT = 'https://xeno-canto.org/api/2/recordings';

/**
 * A single recording entry returned by the XC v2 search API.
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
    /** Fetch implementation override (for testing/proxies). */
    fetchImpl?: typeof fetch;
}

/**
 * Searches Xeno-canto recordings using the v2 public API.
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

    const page = options.page ?? 1;
    const params = new URLSearchParams({ query, page: String(page) });
    const url = `${XC_SEARCH_ENDPOINT}?${params}`;

    const res = await fetchFn(url);
    if (!res.ok) {
        throw new Error(`XC search HTTP ${res.status}: ${res.statusText}`);
    }

    const data: XcSearchResult = await res.json();
    if (!Array.isArray(data.recordings)) {
        data.recordings = [];
    }
    return data;
}
