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
    fromMs?: number | null;
    toMs?: number | null;
    hourFrom?: number | null;
    hourTo?: number | null;
    pathContains?: string | null;
    hasLabels?: boolean | null;
    detection?: { runId?: number | null; class: string; minScore: number } | null;
    noStart?: boolean;
    status?: 'ok' | 'missing' | 'changed' | null;
}
export type CatalogSort = 'start' | 'path';
export interface CatalogCursor { key: number | string | null; id: number }
export interface CatalogRow {
    id: number; rootId: number | null; path: string | null; size: number | null; startMs: number | null;
    localOffsetMin: number | null; durationS: number | null; site: string | null; device: string | null; labels: number;
    status: 'ok' | 'missing' | 'changed' | null;
}
export interface CatalogPage { rows: CatalogRow[]; next: CatalogCursor | null }
export interface FacetValue { id: number; name: string; count: number }
export interface Facets {
    total: number; bytes: number; seconds: number | null; firstMs: number | null; lastMs: number | null;
    noStart: number; sites: FacetValue[]; devices: FacetValue[];
}
export interface HeatCell { day: string; hour: number; count: number }
export interface DuplicateGroup { hash: string; size: number; paths: string[]; verified: boolean }
export interface Integrity {
    hashed: number; unhashed: number; noHeader: number; fullHashed: number; fullUnhashed: number; bytesWithoutChecksum: number;
    missing: number; changed: number;
    duplicateGroups: number; duplicates: DuplicateGroup[]; hashing: boolean;
}
export interface HashProgress { projectRoot: string; kind: 'header' | 'quick' | 'full'; done: number; total: number; finished: boolean; failed: number }
export interface SiteInfo { id: number; name: string; tz: string | null; recordings: number; clocks: string[] }
export interface ClockPeriod { from: string | null; clock: string; note?: string | null }
export interface DeviceInfo { id: number; name: string; recordings: number; sites: string[]; periods: ClockPeriod[] }
export interface ClockShift {
    deviceId: number; device: string; from: string; shiftMin: number; clockBefore: string; clockAfter: string;
    kind: 'jump' | 'like-others';
}

/** Clock periods of a recorder after accepting a detected change. */
export function periodsWithShift(current: ClockPeriod[], s: ClockShift): ClockPeriod[] {
    if (s.kind === 'like-others') return [{ from: null, clock: s.clockAfter, note: 'like the other recorders after the change' }];
    const base = current.length ? current.filter((p) => p.from !== s.from) : [{ from: null, clock: s.clockBefore }];
    const note = `detected: recording window ${s.shiftMin > 0 ? '+' : ''}${s.shiftMin / 60} h`;
    return [...base, { from: s.from, clock: s.clockAfter, note }]
        .sort((a, b) => (a.from ?? '').localeCompare(b.from ?? ''));
}

export interface ClockReport { updated: number; ambiguous: number; gap: number }

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
