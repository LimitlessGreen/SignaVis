// ═══════════════════════════════════════════════════════════════════════
// domain/catalog/catalog-types.ts — project catalog (data management)
//
// Types mirror the Rust crate aw-catalog (serde camelCase) and the Lite
// commands in src-tauri-lite/src/catalog.rs. Pure helpers only.
// ═══════════════════════════════════════════════════════════════════════

/** site | device | start | date | time | ignore | meta:<key> */
export type FieldRole = 'site' | 'device' | 'start' | 'date' | 'time' | 'ignore' | `meta:${string}`;

export interface MappingSpec {
    field: string;
    role: FieldRole;
    format?: string;
    lookup?: Record<string, string>;
}

export interface ProfileSpec {
    name: string;
    patterns: string[];
    mappings: MappingSpec[];
    utcOffsetMin: number;
    tz?: string | null;
    derivedDirs: string[];
}

export interface Suggestion { pattern: string; mappings: MappingSpec[]; matches: number; example: string }

/** Profile from suggestions: all patterns, mappings merged (first suggestion wins per field). */
export function profileFromSuggestions(base: ProfileSpec, sug: Suggestion[]): ProfileSpec {
    const mappings: MappingSpec[] = [];
    for (const s of sug) for (const m of s.mappings) if (!mappings.some((x) => x.field === m.field)) mappings.push({ ...m });
    return { ...base, patterns: sug.map((s) => s.pattern), mappings };
}

export interface SampleRow {
    path: string; pattern: number | null; site: string | null; device: string | null;
    start: string | null; meta: [string, string][];
}
export interface Preview {
    audioFiles: number; audioBytes: number; selectionTables: number; skippedDirs: string[];
    perPattern: number[]; unmatched: number;
    unmatchedGroups: { dir: string; count: number; example: string }[];
    groups: { site: string | null; device: string | null; files: number; bytes: number; first: string | null; last: string | null }[];
    issues: { kind: 'no-start' | 'implausible-time' | 'duplicate-time'; count: number; examples: string[] }[];
    samples: SampleRow[];
}
export interface MovedFile { from: string; to: string; by: 'hash' | 'sha256' | 'size+mtime' }
export interface ImportResult {
    rootId: number; moved: number; movedExamples: MovedFile[]; missing: number; changed: number; inserted: number; alreadyKnown: number; unmatched: number; noStart: number;
    tables: number; detections: number;
}

export interface CatalogFilter {
    rootId?: number | null;
    siteIds?: number[];
    deviceIds?: number[];
    tagIds?: number[];
    /** Only recordings without site or recorder. */
    unassigned?: boolean;
    /** Area [south, west, north, east] on the own position, else the site's. */
    bbox?: [number, number, number, number] | null;
    hasPosition?: boolean | null;
    fromMs?: number | null;
    toMs?: number | null;
    /** Local calendar days YYYY-MM-DD, both inclusive (as the statistics count). */
    localDayFrom?: string | null;
    localDayTo?: string | null;
    /** Only recordings without a site. */
    noSite?: boolean;
    hourFrom?: number | null;
    hourTo?: number | null;
    pathContains?: string | null;
    hasLabels?: boolean | null;
    detection?: { runId?: number | null; class: string; minScore: number } | null;
    noStart?: boolean;
    status?: 'ok' | 'missing' | 'changed' | null;
    /** Only recordings in this dataset (static: members; dynamic: its saved filter). */
    datasetId?: number | null;
    /** Start relative to the sun at the recording's (or its site's) position. */
    sun?: SunWindow | null;
    /** Review state in Annotate: new (never opened), open, done, todo (not done). */
    review?: ReviewFilter | null;
}
export type ReviewFilter = 'new' | 'open' | 'done' | 'todo';
export type CatalogSort = 'start' | 'path';
export interface CatalogCursor { key: number | string | null; id: number }
export interface CatalogRow {
    id: number; rootId: number | null; path: string | null; size: number | null; startMs: number | null;
    localOffsetMin: number | null; durationS: number | null; site: string | null; device: string | null; labels: number;
    status: 'ok' | 'missing' | 'changed' | null;
    /** Review state in Annotate: null = new (never opened). */
    review?: 'open' | 'done' | null;
}
export interface CatalogPage { rows: CatalogRow[]; next: CatalogCursor | null }
export interface FacetValue { id: number; name: string; count: number }
export interface Facets {
    total: number; bytes: number; seconds: number | null; firstMs: number | null; lastMs: number | null;
    noStart: number; reviewOpen?: number; reviewDone?: number; sites: FacetValue[]; devices: FacetValue[]; tags?: FacetValue[];
    /** Recordings per local day / per local hour (0–23), each without its own part of the filter. */
    days?: DayCount[]; hours?: number[];
    /** Mean position [lat, lon] of the recordings with one (for sun times). */
    center?: [number, number] | null;
}
export interface DayCount { day: string; count: number; offsetMin?: number | null }
export interface HeatCell { day: string; hour: number; count: number }
export interface DuplicateGroup { hash: string; size: number; paths: string[]; verified: boolean }
export interface Integrity {
    hashed: number; unhashed: number; noHeader: number; fullHashed: number; fullUnhashed: number; bytesWithoutChecksum: number;
    missing: number; changed: number;
    duplicateGroups: number; duplicates: DuplicateGroup[]; hashing: boolean;
}
export interface HashProgress { projectRoot: string; kind: 'header' | 'quick' | 'full'; done: number; total: number; finished: boolean; failed: number; error?: string }
export interface SiteInfo { id: number; name: string; tz: string | null; recordings: number; clocks: string[] }
export interface ClockPeriod { from: string | null; fromPath?: string | null; clock: string; note?: string | null }
export interface DeviceInfo { id: number; name: string; recordings: number; sites: string[]; periods: ClockPeriod[] }
export interface ClockShift {
    deviceId: number; device: string; from: string; shiftMin: number; clockBefore: string; clockAfter: string;
    kind: 'jump' | 'like-others' | 'set-back';
    duplicates?: number; unhashed?: boolean;
}

/** Clock periods of a recorder after accepting a detected change. */
export function periodsWithShift(current: ClockPeriod[], s: ClockShift): ClockPeriod[] {
    if (s.kind === 'like-others') return [{ from: null, clock: s.clockAfter, note: 'like the other recorders after the change' }];
    const base = current.length ? current.filter((p) => p.from !== s.from) : [{ from: null, clock: s.clockBefore }];
    const note = s.kind === 'set-back'
        ? `detected: set back ${-s.shiftMin / 60} h while recording (${s.duplicates ?? 0} files with repeated times)`
        : `detected: recording window ${s.shiftMin > 0 ? '+' : ''}${s.shiftMin / 60} h`;
    return [...base, { from: s.from, clock: s.clockAfter, note }]
        .sort((a, b) => (a.from ?? '').localeCompare(b.from ?? ''));
}

export interface ClockReport { updated: number; ambiguous: number; gap: number; fromHeader: number }

/** "UTC+01:00" for a fixed offset in minutes. */
export function fixedClockLabel(min: number): string {
    const a = Math.abs(min);
    return `UTC${min < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

export interface RootInfo { id: number; name: string; kind: string; path: string | null; assets: number }

/** Named fields of path templates, in first-seen order (`{*}` and duplicates skipped). */
export function templateFields(patterns: string[]): { name: string; isTime: boolean }[] {
    const out: { name: string; isTime: boolean }[] = [];
    for (const p of patterns) {
        for (const m of p.matchAll(/\{\s*([A-Za-z0-9_]+)\s*(?::([^}]*))?\}/g)) {
            if (out.some((f) => f.name === m[1])) continue;
            out.push({ name: m[1], isTime: !!m[2]?.includes('%') });
        }
    }
    return out;
}

/** Keep mappings of fields still present; add a default role for new fields. */
export function syncMappings(patterns: string[], mappings: MappingSpec[]): MappingSpec[] {
    return templateFields(patterns).map(({ name, isTime }) => mappings.find((m) => m.field === name)
        ?? { field: name, role: guessRole(name, isTime) });
}

/** Default role from the field name (German and English hints). */
export function guessRole(name: string, isTime: boolean): FieldRole {
    const n = name.toLowerCase();
    if (isTime) {
        if (/^(date|datum|day|tag)$/.test(n)) return 'date';
        if (/^(time|zeit|uhrzeit|clock)$/.test(n)) return 'time';
        return 'start';
    }
    if (/^(site|loc|location|standort|ort|plot)$/.test(n)) return 'site';
    if (/^(rec|recorder|rekorder|device|dev|geraet|gerät|unit|sn|serial)$/.test(n)) return 'device';
    return `meta:${name}`;
}

/** Local wall clock of a row (start + stored offset) as 'YYYY-MM-DD HH:MM:SS'. */
export function localTime(row: Pick<CatalogRow, 'startMs' | 'localOffsetMin'>): string {
    if (row.startMs == null) return '';
    const d = new Date(row.startMs + (row.localOffsetMin ?? 0) * 60_000);
    return d.toISOString().slice(0, 19).replace('T', ' ');
}

export function formatBytes(n: number): string {
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
    return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

export function emptyProfile(name = 'default'): ProfileSpec {
    return { name, patterns: [], mappings: [], utcOffsetMin: 0, tz: null, derivedDirs: [] };
}

export const PROFILE_FILE_KIND = 'signavis-import-profile/1';

/** JSON file content for sharing a profile. */
export function profileToFile(p: ProfileSpec): string {
    return JSON.stringify({ kind: PROFILE_FILE_KIND, profile: p }, null, 2);
}

/** Parse a shared profile; throws with a readable message for foreign files. */
export function profileFromFile(text: string): ProfileSpec {
    let j: any;
    try { j = JSON.parse(text); } catch { throw new Error('Not a JSON file.'); }
    const p = j?.kind === PROFILE_FILE_KIND ? j.profile : null;
    if (!p || typeof p.name !== 'string' || !Array.isArray(p.patterns) || !p.patterns.every((x: unknown) => typeof x === 'string')) {
        throw new Error('Not a SignaVis import profile.');
    }
    const mappings = Array.isArray(p.mappings) ? p.mappings.filter((m: any) => typeof m?.field === 'string' && typeof m?.role === 'string') : [];
    return {
        name: p.name, patterns: p.patterns, mappings,
        utcOffsetMin: Number.isFinite(p.utcOffsetMin) ? p.utcOffsetMin : 0,
        tz: typeof p.tz === 'string' && p.tz ? p.tz : null,
        derivedDirs: Array.isArray(p.derivedDirs) ? p.derivedDirs.filter((d: unknown) => typeof d === 'string') : [],
    };
}

// ── Phase 2: sites, recorders, deployments, bulk edit, statistics ──────────

export interface SiteFields {
    name: string; lat?: number | null; lon?: number | null; elevation?: number | null;
    habitat?: string | null; notes?: string | null; photo?: string | null;
}
export interface DeviceFields { name: string; model?: string | null; serial?: string | null; notes?: string | null }
export interface DeploymentInfo {
    id: number; siteId: number | null; site: string | null; deviceId: number | null; device: string | null;
    startMs: number | null; endMs: number | null; recordings: number; notes: string | null;
}
export interface DeriveReport { deployments: number; recordings: number; keptNotes: number }
export interface TagInfo { id: number; name: string; recordings: number }
export interface Selection { ids?: number[] | null; filter?: CatalogFilter | null }
export interface BulkEdit {
    /** Absent = keep, null = clear. */
    siteId?: number | null; deviceId?: number | null;
    addTags?: string[]; removeTags?: string[];
    /** [key, value]; value null removes the key. */
    meta?: [string, string | null][];
    /** Own position [lat, lon] by hand; null clears it. */
    position?: [number, number] | null;
}
export interface BulkReport {
    recordings: number; siteChanged: number; deviceChanged: number; tagsAdded: number; tagsRemoved: number; metaSet: number; reclocked: number;
    positioned?: number;
}
export interface RecordingDetail {
    id: number; path: string | null; siteId: number | null; deviceId: number | null; deploymentId: number | null;
    sampleRate: number | null; channels: number | null; tz: string | null; quickHash: string | null; fullHash: string | null;
    lat: number | null; lon: number | null; alt: number | null; posOrigin: 'manual' | 'header' | 'track' | null;
    /** [key, value, origin] */
    meta: [string, string, string][]; tags: string[];
}
export interface ClassCount { class: string; count: number; recordings: number }
export interface WeekCell { siteId: number | null; week: string; recordings: number; seconds: number; days: number }
export interface DeviceStat {
    deviceId: number | null; device: string | null; recordings: number; seconds: number;
    firstDay: string | null; lastDay: string | null; days: number; missingDays: string[];
}
export interface CatalogStats {
    totals: {
        recordings: number; bytes: number; seconds: number; withDuration: number; firstMs: number | null; lastMs: number | null;
        sites: number; devices: number; noStart: number; unassigned: number;
    };
    integrity: { ok: number; missing: number; changed: number; hashed: number; fullHashed: number; headerRead: number };
    sites: [number | null, string][];
    weeks: WeekCell[];
    devices: DeviceStat[];
    labeledRecordings: number;
    labels: ClassCount[];
    runs: { runId: number; model: string; covered: number; detections: number; classes: ClassCount[] }[];
}

/**
 * Row picking like a file manager: click = only this row, Ctrl/Cmd = toggle,
 * Shift = range from the anchor (added to the picked rows when Ctrl is held too).
 */
export function pickRows(ids: number[], picked: Set<number>, anchor: number | null, index: number,
    mods: { ctrl?: boolean; shift?: boolean }): { picked: Set<number>; anchor: number } {
    const id = ids[index];
    if (id == null) return { picked, anchor: anchor ?? index };
    if (mods.shift && anchor != null) {
        const out = mods.ctrl ? new Set(picked) : new Set<number>();
        const [a, b] = anchor < index ? [anchor, index] : [index, anchor];
        for (let i = a; i <= b; i++) if (ids[i] != null) out.add(ids[i]);
        return { picked: out, anchor };
    }
    if (mods.ctrl) {
        const out = new Set(picked);
        if (out.has(id)) out.delete(id); else out.add(id);
        return { picked: out, anchor: index };
    }
    return { picked: new Set([id]), anchor: index };
}

/** "52.1234, 8.5678" or "52.1234 8.5678" (as copied from a map) → coordinates. */
export function parseCoords(text: string): { lat: number; lon: number } | null {
    const m = text.trim().match(/^(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)$/);
    if (!m) return null;
    // A decimal comma only when the separator is something else.
    const num = (s: string) => Number(s.replace(',', '.'));
    const lat = num(m[1]), lon = num(m[2]);
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
    return { lat, lon };
}

/** Consecutive ISO days as ranges: ["2023-03-15", "2023-03-16", "2023-03-20"] → ["03-15–03-16", "03-20"]. */
export function dayRanges(days: string[]): string[] {
    const out: string[] = [];
    let start: string | null = null, prev: string | null = null;
    const next = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const flush = () => { if (start) out.push(start === prev ? start.slice(5) : `${start.slice(5)}–${prev!.slice(5)}`); };
    for (const d of [...days].sort()) {
        if (prev && next(prev) === d) { prev = d; continue; }
        flush();
        start = prev = d;
    }
    flush();
    return out;
}

/** Site × week matrix with every week from the first to the last (empty weeks stay visible). */
/**
 * Site × week matrix with every week from the first to the last (empty weeks stay visible).
 * At most `maxWeeks` columns: the most recent ones; `hiddenWeeks` says how many earlier weeks are left out.
 */
export function coverageMatrix(stats: Pick<CatalogStats, 'sites' | 'weeks'>, maxWeeks = 1000): {
    weeks: string[]; hiddenWeeks: number; rows: { siteId: number | null; name: string; cells: (WeekCell | null)[] }[];
} {
    const all = [...new Set(stats.weeks.map((w) => w.week))].sort();
    let weeks: string[] = [];
    if (all.length) {
        const end = Date.parse(`${all[all.length - 1]}T00:00:00Z`);
        for (let t = Date.parse(`${all[0]}T00:00:00Z`); t <= end; t += 7 * 86_400_000) {
            weeks.push(new Date(t).toISOString().slice(0, 10));
        }
    }
    const hiddenWeeks = Math.max(0, weeks.length - maxWeeks);
    if (hiddenWeeks) weeks = weeks.slice(hiddenWeeks);
    const byKey = new Map(stats.weeks.map((c) => [`${c.siteId}|${c.week}`, c]));
    const rows = stats.sites.map(([siteId, name]) => ({
        siteId, name: name || '(no site)',
        cells: weeks.map((w) => byKey.get(`${siteId}|${w}`) ?? null),
    })).filter((r) => r.siteId != null || r.cells.some(Boolean)); // recordings without site and time: nothing to show
    return { weeks, hiddenWeeks, rows };
}

export function bulkReportText(r: BulkReport): string {
    const parts = [
        r.siteChanged && `${r.siteChanged.toLocaleString()} moved to another site`,
        r.deviceChanged && `${r.deviceChanged.toLocaleString()} to another recorder`,
        r.reclocked && `${r.reclocked.toLocaleString()} times recomputed from the recorder clock`,
        r.tagsAdded && `${r.tagsAdded.toLocaleString()} tags added`,
        r.tagsRemoved && `${r.tagsRemoved.toLocaleString()} tags removed`,
        r.metaSet && `${r.metaSet.toLocaleString()} metadata values changed`,
        r.positioned && `${r.positioned.toLocaleString()} positions set`,
    ].filter(Boolean);
    return `${r.recordings.toLocaleString()} recordings: ${parts.length ? parts.join(', ') : 'nothing changed'}`;
}

// ── Positions, tracks, map ─────────────────────────────────────────────────

export interface MapSite { id: number; name: string; lat: number; lon: number; recordings: number }
export interface MapCell { lat: number; lon: number; recordings: number; firstMs: number | null; lastMs: number | null }
export interface MapData { sites: MapSite[]; cells: MapCell[]; cellDeg: number; withoutPosition: number; withOwnPosition: number }
export interface TrackInfo { id: number; name: string; device: string | null; startMs: number; endMs: number; nPoints: number; recordings: number }
export interface MatchReport { candidates: number; positioned: number; kept: number; tooFar: number }
export interface TrackImport { trackId: number; points: number; untimed: number; invalid?: number; match: MatchReport }

/** Grid cell in degrees for a map zoom level: about `px` screen pixels per cell. */
export function cellDegForZoom(zoom: number, px = 12): number {
    return (360 / (256 * 2 ** zoom)) * px;
}

/** Bounding box [south, west, north, east] as a short label. */
/** A stored colour as CSS, or null: only #rgb/#rgba/#rrggbb/#rrggbbaa (it ends up in style attributes). */
export function safeColor(c: unknown): string | null {
    return typeof c === 'string' && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c.trim()) ? c.trim() : null;
}

export function bboxLabel(b: [number, number, number, number]): string {
    const f = (v: number) => v.toFixed(3);
    return `${f(b[0])}…${f(b[2])}° N, ${f(b[1])}…${f(b[3])}° E`;
}

export function matchReportText(m: MatchReport): string {
    if (!m.candidates) return 'No recordings in the time span of the track.';
    return [
        `${m.positioned.toLocaleString()} of ${m.candidates.toLocaleString()} recordings in the track's time span got a position`,
        m.kept && `${m.kept.toLocaleString()} kept their position from the recorder or set by hand`,
        m.tooFar && `${m.tooFar.toLocaleString()} had no track point near enough in time`,
    ].filter(Boolean).join('; ') + '.';
}

// ── Sun windows ──────────────────────────────────────────────────────────

export type SunEvent = 'sunrise' | 'sunset' | 'dawn' | 'dusk';
export interface SunRef { event: SunEvent; offsetMin?: number }
/** From one sun reference to the next occurrence of the other (wraps over midnight). */
export interface SunWindow { from: SunRef; to: SunRef }

export const SUN_EVENTS: { v: SunEvent; label: string }[] = [
    { v: 'dawn', label: 'civil dawn' }, { v: 'sunrise', label: 'sunrise' },
    { v: 'sunset', label: 'sunset' }, { v: 'dusk', label: 'civil dusk' },
];
export const SUN_PRESETS: { label: string; w: SunWindow }[] = [
    { label: 'Night (sunset − 1 h → sunrise)', w: { from: { event: 'sunset', offsetMin: -60 }, to: { event: 'sunrise', offsetMin: 0 } } },
    { label: 'Dark (civil dusk → civil dawn)', w: { from: { event: 'dusk', offsetMin: 0 }, to: { event: 'dawn', offsetMin: 0 } } },
    { label: 'Evening (sunset − 1 h → + 3 h)', w: { from: { event: 'sunset', offsetMin: -60 }, to: { event: 'sunset', offsetMin: 180 } } },
    { label: 'Dawn chorus (sunrise − 1 h → + 2 h)', w: { from: { event: 'sunrise', offsetMin: -60 }, to: { event: 'sunrise', offsetMin: 120 } } },
    { label: 'Day (sunrise → sunset)', w: { from: { event: 'sunrise', offsetMin: 0 }, to: { event: 'sunset', offsetMin: 0 } } },
];

function sunRefLabel(r: SunRef): string {
    const name = SUN_EVENTS.find((e) => e.v === r.event)?.label ?? r.event;
    const m = r.offsetMin ?? 0;
    if (!m) return name;
    const a = Math.abs(m);
    const amount = a % 60 === 0 ? `${a / 60} h` : a > 60 ? `${Math.floor(a / 60)} h ${a % 60} min` : `${a} min`;
    return `${name} ${m < 0 ? '−' : '+'} ${amount}`;
}
export function sunWindowLabel(w: SunWindow): string { return `${sunRefLabel(w.from)} → ${sunRefLabel(w.to)}`; }
export function sameSunWindow(a: SunWindow | null | undefined, b: SunWindow | null | undefined): boolean {
    if (!a || !b) return !a && !b;
    return a.from.event === b.from.event && (a.from.offsetMin ?? 0) === (b.from.offsetMin ?? 0)
        && a.to.event === b.to.event && (a.to.offsetMin ?? 0) === (b.to.offsetMin ?? 0);
}

// ── Datasets ─────────────────────────────────────────────────────────────

export interface DatasetInfo {
    id: number; uid: string; name: string; description: string | null;
    kind: 'static' | 'filter'; filter: CatalogFilter | null; color: string | null;
    recordings: number; ranges: number; seconds: number | null;
    createdAt: number; updatedAt: number; error: string | null;
}
export interface DatasetEdit { name?: string; description?: string | null; color?: string | null; filter?: CatalogFilter }
export interface Membership { datasetId: number; name: string; kind: 'static' | 'filter'; color: string | null; ranges: [number, number][] }

/** Flags where false is the default (no restriction); for the others false is a choice (hasPosition: false = without). */
const DEFAULT_FALSE = new Set(['unassigned', 'noStart', 'noSite']);

/** Filter without empty parts, keys sorted: two filters that select the same thing compare equal. */
export function normalizeFilter(f: CatalogFilter): CatalogFilter {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(f).sort()) {
        const v = (f as Record<string, unknown>)[k];
        if (v == null || (v === false && DEFAULT_FALSE.has(k)) || v === '' || (Array.isArray(v) && !v.length)) continue;
        out[k] = Array.isArray(v) && k.endsWith('Ids') ? [...v].sort((a, b) => a - b) : v;
    }
    if (out.sun) {
        const w = out.sun as SunWindow;
        out.sun = { from: { event: w.from.event, offsetMin: w.from.offsetMin ?? 0 }, to: { event: w.to.event, offsetMin: w.to.offsetMin ?? 0 } };
    }
    if (out.detection) {
        const d = out.detection as NonNullable<CatalogFilter['detection']>;
        out.detection = { class: d.class, minScore: d.minScore, runId: d.runId ?? null };   // fixed field order
    }
    return out as CatalogFilter;
}
export function sameFilter(a: CatalogFilter, b: CatalogFilter): boolean {
    return JSON.stringify(normalizeFilter(a)) === JSON.stringify(normalizeFilter(b));
}
export function isEmptyFilter(f: CatalogFilter): boolean { return !Object.keys(normalizeFilter(f)).length; }

/** One line for a dataset list entry: "1 234 recordings · 12 ranges". */
export function datasetCountText(d: DatasetInfo): string {
    if (d.error) return 'filter refers to a deleted dataset';
    return `${d.recordings.toLocaleString()} recording${d.recordings === 1 ? '' : 's'}${d.ranges ? ` · ${d.ranges.toLocaleString()} range${d.ranges === 1 ? '' : 's'}` : ''}`;
}

/** Suggested name for a copy that does not clash ("Night (copy)", "Night (copy 2)"). */
export function copyName(name: string, taken: string[], frozen = false): string {
    const base = `${name} (${frozen ? 'snapshot' : 'copy'}`;
    const low = new Set(taken.map((t) => t.toLowerCase()));
    if (!low.has(`${base})`.toLowerCase())) return `${base})`;
    for (let i = 2; ; i++) if (!low.has(`${base} ${i})`.toLowerCase())) return `${base} ${i})`;
}

// ── Time ranges in a recording ───────────────────────────────────────────

/** "m:ss.s" (or "h:mm:ss") for range fields; tenths only when needed. */
export function fmtClock(s: number): string {
    const t = Math.round(s * 10) / 10;
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    const ss = (Number.isInteger(sec) ? String(sec) : sec.toFixed(1)).padStart(Number.isInteger(sec) ? 2 : 4, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
/** Seconds from "83", "83.5", "1:23", "1:23.5", "0:01:23" (comma as decimal mark too); null if not a time. */
export function parseClock(v: string): number | null {
    const t = v.trim().replace(',', '.');
    if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(t)) return null;
    const parts = t.split(':').map(Number);
    if (parts.slice(1).some((p) => p >= 60)) return null;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
}
/** Range from a drag over a spectrogram of `width` px showing `duration` s: ordered, clamped, 0.1 s steps; null if too short. */
/**
 * A typed range (seconds) as it will be stored, or null when it is not valid:
 * 0 ≤ start < end ≤ duration. An end up to 0.05 s past the duration (a rounded
 * display value) means the end of the recording.
 */
export function typedRange(a: number | null, b: number | null, duration: number | null | undefined): [number, number] | null {
    if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
    const d = duration != null && duration > 0 ? duration : Infinity;
    if (b > d + 0.05) return null;
    const end = Math.min(b, d);
    return a >= 0 && a < end ? [a, end] : null;
}

export function rangeFromDrag(x0: number, x1: number, width: number, duration: number, minS = 0.2): [number, number] | null {
    if (!(width > 0) || !(duration > 0)) return null;
    // Rounded to 0.1 s, then clamped again: rounding may not pass the end (60.06 s → 60.1).
    const at = (x: number) => Math.min(duration, Math.round(Math.max(0, (x / width) * duration) * 10) / 10);
    const [a, b] = [at(Math.min(x0, x1)), at(Math.max(x0, x1))];
    return b - a >= minS - 1e-9 ? [a, b] : null;   // 15.2 − 15 is just below 0.2 in floating point
}
