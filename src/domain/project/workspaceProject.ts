// ═══════════════════════════════════════════════════════════════════════
// domain/project/workspaceProject.ts — labeling project file format
//
// One project = 1…n recordings + all annotation sets (a set may span
// several recordings). This is the content of `project.signavis.json`
// in a project folder and of the browser (OPFS) project.
//
// The older `Project` type (types.ts) describes a single audio source and
// stays for the desktop app; an adapter can map between both later.
//
// Pure functions only — no storage, no DOM. See tests/workspace-project.test.mjs.
// ═══════════════════════════════════════════════════════════════════════

import { toXcId, xcNumber } from '../xc/xcId.ts';

export const PROJECT_SCHEMA = 'signavis-project/1';
export const PROJECT_FILE_NAME = 'project.signavis.json';

export type RecordingSource = 'xc' | 'file' | 'sample' | 'url';

export interface ProjectRecording {
    id: string;
    source: RecordingSource;
    filename: string;
    /** XC ID with prefix, 'XC123' (also set for local copies linked to XC). Older files: bare number, migrated on load. */
    xcId: string | null;
    /** Path relative to the project root ('xc/XC123.mp3', 'audio/a.wav'); null = not stored in the project. */
    path: string | null;
    /** Only for source 'sample' / 'url' — never a blob: URL. */
    url: string | null;
    sampleRate: number | null;
    xcRecordingMeta: unknown;
    annotations: unknown[];
    needsXcImport: boolean;
    context?: unknown;
    /** false: opened folder file not kept yet (see keepRecording). */
    pinned?: boolean;
    guano?: unknown;
}

export interface WorkspaceProject {
    schema: typeof PROJECT_SCHEMA;
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    recordings: ProjectRecording[];
    activeRecordingId: string | null;
    sets: any[];
    ownSetId: string | null;
    activeSetId: string | null;
    settings: Record<string, unknown>;
}

/** In-memory session state that a project is built from / restored into. */
export interface SessionSnapshot {
    entries: any[];                 // RecordingManager entries
    activeId: string | null;
    labelSets: Map<string, any>;
    ownSetId: string | null;
    activeSetId: string | null;
    settings?: Record<string, unknown>;
}

const isBlobUrl = (u: unknown) => typeof u === 'string' && u.startsWith('blob:');
const isXcUrl = (u: unknown) => typeof u === 'string' && /xeno-canto\.org/i.test(u);

/** Derive the source of a RecordingManager entry (older entries have no `source`). */
export function inferSource(entry: any): RecordingSource {
    if (['xc', 'file', 'sample', 'url'].includes(entry?.source)) return entry.source;
    if (entry?.isBlobUrl || isBlobUrl(entry?.audioUrl)) return 'file';
    if (entry?.xcId && (!entry.audioUrl || isXcUrl(entry.audioUrl))) return 'xc';
    if (typeof entry?.audioUrl === 'string' && entry.audioUrl.startsWith('./samples/')) return 'sample';
    if (entry?.audioUrl) return 'url';
    return 'file';
}

/** Default project path for an XC download. */
export const xcRecordingPath = (xcId: string) => `xc/${toXcId(xcId)}.mp3`;

export function toProjectRecording(entry: any): ProjectRecording {
    const source = inferSource(entry);
    const rec: ProjectRecording = {
        id: String(entry.id),
        source,
        filename: entry.filename || 'Untitled',
        xcId: toXcId(entry.xcId),
        path: entry.path ?? null,
        url: (source === 'sample' || source === 'url') && !isBlobUrl(entry.audioUrl) ? entry.audioUrl ?? null : null,
        sampleRate: Number.isFinite(entry.sampleRate) ? entry.sampleRate : null,
        xcRecordingMeta: entry.xcRecordingMeta ?? null,
        annotations: Array.isArray(entry.annotations) ? entry.annotations.map((a: any) => ({ ...a })) : [],
        needsXcImport: !!entry.needsXcImport,
    };
    if (entry.context !== undefined) rec.context = entry.context;
    if (entry.pinned === false) rec.pinned = false;
    if (entry.guano !== undefined) rec.guano = entry.guano;
    return rec;
}

/**
 * Inverse of toProjectRecording: a partial RecordingManager entry.
 * Audio of 'file' recordings without `path` is session-only → audioUrl null
 * (the user has to pick the file again); XC recordings get their download URL.
 */
export function fromProjectRecording(rec: ProjectRecording): any {
    const audioUrl = rec.source === 'xc' && rec.xcId ? `https://xeno-canto.org/${xcNumber(rec.xcId)}/download`
        : rec.url ?? null;
    const entry: any = {
        id: rec.id,
        source: rec.source,
        filename: rec.filename,
        xcId: toXcId(rec.xcId),
        path: rec.path,
        audioUrl,
        isBlobUrl: false,
        sampleRate: rec.sampleRate,
        xcRecordingMeta: rec.xcRecordingMeta,
        annotations: (rec.annotations || []).map((a: any) => ({ ...a })),
        needsXcImport: rec.needsXcImport,
    };
    if (rec.context !== undefined) entry.context = rec.context;
    if (rec.pinned === false) entry.pinned = false;
    if (rec.guano !== undefined) entry.guano = rec.guano;
    return entry;
}

/**
 * Folder files that were only looked at (`pinned === false`, no labels, not active) are not kept:
 * they reappear as unopened files of the folder. A label or the "+" in the explorer keeps them.
 */
export function keepRecording(entry: any, activeId: string | null = null) {
    if (entry?.pinned !== false) return true;
    return entry.id === activeId || (Array.isArray(entry.annotations) && entry.annotations.length > 0);
}

export function serializeProject(
    snap: SessionSnapshot,
    meta: { id: string; name: string; createdAt?: string },
    now = new Date(),
): WorkspaceProject {
    return {
        schema: PROJECT_SCHEMA,
        id: meta.id,
        name: meta.name,
        createdAt: meta.createdAt || now.toISOString(),
        updatedAt: now.toISOString(),
        recordings: snap.entries.filter((e) => keepRecording(e, snap.activeId)).map(toProjectRecording),
        activeRecordingId: snap.activeId,
        sets: [...snap.labelSets.values()].map((s) => ({ ...s })),
        ownSetId: snap.ownSetId,
        activeSetId: snap.activeSetId,
        settings: { ...(snap.settings || {}) },
    };
}

export class ProjectFormatError extends Error {}

/** Validate + migrate parsed JSON. Throws ProjectFormatError for foreign/broken files. */
export function parseProject(json: unknown): WorkspaceProject {
    const p: any = typeof json === 'string' ? JSON.parse(json) : json;
    if (!p || typeof p !== 'object') throw new ProjectFormatError('Project file is empty or not an object.');
    if (p.schema !== PROJECT_SCHEMA) {
        throw new ProjectFormatError(`Unsupported project format: ${p.schema ?? 'missing schema'}.`);
    }
    if (!Array.isArray(p.recordings)) throw new ProjectFormatError('Project has no recordings list.');
    const ids = new Set<string>();
    const recordings: ProjectRecording[] = [];
    for (const r of p.recordings) {
        if (!r || typeof r.id !== 'string' || ids.has(r.id)) continue;   // skip broken/duplicate rows
        ids.add(r.id);
        recordings.push(toProjectRecording({ ...r, audioUrl: r.url }));
    }
    const sets = Array.isArray(p.sets) ? p.sets.filter((s: any) => s && typeof s.id === 'string') : [];
    const setIds = new Set(sets.map((s: any) => s.id));
    return {
        schema: PROJECT_SCHEMA,
        id: String(p.id || ''),
        name: String(p.name || 'Untitled project'),
        createdAt: String(p.createdAt || ''),
        updatedAt: String(p.updatedAt || ''),
        recordings,
        activeRecordingId: ids.has(p.activeRecordingId) ? p.activeRecordingId : null,
        sets,
        ownSetId: setIds.has(p.ownSetId) ? p.ownSetId : null,
        activeSetId: setIds.has(p.activeSetId) ? p.activeSetId : null,
        settings: p.settings && typeof p.settings === 'object' ? p.settings : {},
    };
}

export function deserializeProject(project: WorkspaceProject): SessionSnapshot {
    return {
        entries: project.recordings.map(fromProjectRecording),
        activeId: project.activeRecordingId,
        labelSets: new Map(project.sets.map((s) => [s.id, { ...s }])),
        ownSetId: project.ownSetId,
        activeSetId: project.activeSetId,
        settings: { ...project.settings },
    };
}

export const stringifyProject = (p: WorkspaceProject) => JSON.stringify(p, null, 2) + '\n';

/** Metadata file stored next to an XC download (license / recordist must travel with the audio). */
export const xcMetaPath = (xcId: string) => `xc/${toXcId(xcId)}.json`;

/**
 * New RecordingManager entry for an audio file of the project folder.
 * 'xc/XC123.mp3' is an XC download (e.g. copied from another project): it keeps its XC number,
 * shows under "Xeno-canto" and fetches the XC labels when opened.
 */
export function folderFileEntry(path: string, extra: Record<string, unknown> = {}): any {
    const filename = path.split('/').pop() || path;
    const m = /^xc\/(XC\d+)\.mp3$/i.exec(path);
    const base = m
        ? { source: 'xc', xcId: toXcId(m[1]), needsXcImport: true }
        : { source: 'file' };
    return { ...base, path, filename, audioUrl: null, isBlobUrl: false, ...extra };
}

/**
 * Audio files in the project folder that no recording refers to yet,
 * excluding XC downloads that belong to an existing XC recording.
 */
export function filesNotInProject<T extends { path: string }>(files: T[], entries: any[]): T[] {
    const used = new Set(entries.map((e) => e?.path).filter(Boolean));
    const xcIds = new Set(entries.map((e) => toXcId(e?.xcId)).filter(Boolean));
    return files.filter((f) => {
        if (used.has(f.path)) return false;
        const m = /^xc\/(XC\d+)\.mp3$/i.exec(f.path);
        return !(m && xcIds.has(toXcId(m[1])));
    });
}
