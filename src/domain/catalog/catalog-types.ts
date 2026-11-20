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
    hashed: number; unhashed: number; fullHashed: number; fullUnhashed: number; bytesWithoutChecksum: number;
    missing: number; changed: number;
    duplicateGroups: number; duplicates: DuplicateGroup[]; hashing: boolean;
}
export interface HashProgress { projectRoot: string; kind: 'quick' | 'full'; done: number; total: number; finished: boolean; failed: number }
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
