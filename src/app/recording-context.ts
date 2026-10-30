/**
 * Recording context — date/time, location and device of one recording.
 *
 * Values come from several sources (XC metadata, GUANO chunk, file name) and can be overridden
 * by hand. The resolved context is the single coordinate/date source for BirdNET's geo filter
 * and Explore. It is not uploaded: XC already has these data via xc_nr.
 */

export type ContextSource = 'manual' | 'xc' | 'guano' | 'filename';
export type ContextField = 'date' | 'time' | 'coords' | 'locality' | 'device';

export interface Coords { lat: number; lon: number }

export interface ContextValues {
    date?: string;      // YYYY-MM-DD
    time?: string;      // HH:MM
    coords?: Coords | null;
    locality?: string;
    device?: string;
}

export type ResolvedContext = { [K in ContextField]: { value: NonNullable<ContextValues[K]> | null; source: ContextSource | null } };

export const CONTEXT_SOURCE_TEXT: Record<ContextSource, string> = {
    manual: 'manual', xc: 'XC', guano: 'GUANO', filename: 'file name',
};

const FIELDS: ContextField[] = ['date', 'time', 'coords', 'locality', 'device'];
const str = (v: any) => String(v ?? '').trim();
const pad = (n: number) => String(n).padStart(2, '0');

function validCoords(lat: number, lon: number): Coords | null {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    if (lat === 0 && lon === 0) return null; // "unset" in many devices
    return { lat, lon };
}

/**
 * Parse pasted coordinates: "51.5074, -0.1278", "51.5074 -0.1278", "51,5074; -0,1278",
 * "51.5074N 0.1278W". Returns null when the text isn't a valid pair.
 */
export function parseCoords(text: any): Coords | null {
    let s = str(text).toUpperCase();
    if (!s) return null;
    // Decimal commas only when a separate separator exists ("51,5; -0,1")
    if (s.includes(';')) s = s.replace(/(\d),(\d)/g, '$1.$2').replace(';', ' ');
    const parts = s.match(/-?\d+(?:\.\d+)?\s*[NSEW]?/g);
    if (!parts || parts.length !== 2) return null;
    const val = (p: string) => {
        const n = parseFloat(p);
        return /[SW]/.test(p) ? -Math.abs(n) : n;
    };
    return validCoords(val(parts[0]), val(parts[1]));
}

export function formatCoords(c: Coords | null | undefined, digits = 4) {
    if (!c) return '';
    return `${c.lat.toFixed(digits)}, ${c.lon.toFixed(digits)}`;
}

function normDate(v: any) {
    const m = str(v).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!m) return '';
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return ''; // XC uses 00 for unknown parts
    return `${y}-${pad(mo)}-${pad(d)}`;
}

function normTime(v: any) {
    const m = str(v).match(/^(\d{1,2})[:.h](\d{2})/);
    if (!m || +m[1] > 23 || +m[2] > 59) return '';
    return `${pad(+m[1])}:${m[2]}`;
}

/** From the raw XC API recording object or the app's normalized recordingMeta. */
export function contextFromXc(meta: any): ContextValues {
    if (!meta || typeof meta !== 'object') return {};
    const coords = validCoords(parseFloat(meta.lat), parseFloat(meta.lon ?? meta.lng));
    const locality = [str(meta.loc ?? meta.locality), str(meta.cnt ?? meta.country)].filter(Boolean).join(', ');
    const device = [str(meta.dvc ?? meta.device), str(meta.mic ?? meta.microphone)].filter(Boolean).join(' · ');
    return { date: normDate(meta.date), time: normTime(meta.time), coords, locality, device };
}

/** From a parsed GUANO chunk (bat detectors, many ARUs). */
export function contextFromGuano(g: Record<string, string> | null | undefined): ContextValues {
    if (!g) return {};
    const out: ContextValues = {};
    const pos = str(g['Loc Position']).split(/[\s,]+/).map(parseFloat);
    if (pos.length >= 2) out.coords = validCoords(pos[0], pos[1]);
    // Timestamp: ISO 8601, local time of the recording (offset ignored on purpose)
    const ts = str(g.Timestamp).match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
    if (ts) { out.date = normDate(ts[1]); out.time = normTime(ts[2]); }
    out.device = [str(g.Make), str(g.Model)].filter(Boolean).join(' ');
    out.locality = str(g['Site Name']);
    return out;
}

/** Date/time encoded in file names such as AudioMoth "20240512_053000.WAV" or "SM4_20240512_053000". */
export function contextFromFilename(name: any): ContextValues {
    const s = str(name);
    const m = s.match(/(?:^|\D)(\d{4})-?(\d{2})-?(\d{2})[_T\s-]?(\d{2})[-:]?(\d{2})(?:[-:]?(\d{2}))?(?!\d)/);
    if (!m) {
        const d = s.match(/(?:^|\D)(\d{4})-?(\d{2})-?(\d{2})(?!\d)/);
        return d ? { date: normDate(`${d[1]}-${d[2]}-${d[3]}`) } : {};
    }
    const date = normDate(`${m[1]}-${m[2]}-${m[3]}`);
    if (!date || +m[1] < 1990) return {};
    return { date, time: normTime(`${m[4]}:${m[5]}`) };
}

const isSet = (v: any) => v != null && v !== '';

/**
 * Resolve each field from the first source that has it: manual > XC > GUANO > file name.
 */
export function resolveRecordingContext(src: { manual?: ContextValues | null; xc?: any; guano?: any; filename?: any }): ResolvedContext {
    const layers: [ContextSource, ContextValues][] = [
        ['manual', src.manual || {}],
        ['xc', contextFromXc(src.xc)],
        ['guano', contextFromGuano(src.guano)],
        ['filename', contextFromFilename(src.filename)],
    ];
    const out: any = {};
    for (const f of FIELDS) {
        const hit = layers.find(([, v]) => isSet(v[f]));
        out[f] = hit ? { value: hit[1][f], source: hit[0] } : { value: null, source: null };
    }
    return out as ResolvedContext;
}
