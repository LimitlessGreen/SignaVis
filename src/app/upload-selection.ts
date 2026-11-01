// upload-selection.ts — build an XC annotation set from a selection (pure, no DOM)
//
// Labels belong to recordings; a set only exists at upload time. The user picks
// recordings, species, layers and sources; recordings without an XC ID cannot be part
// of an XC set ("local only"). After an upload a snapshot remembers which labels went
// out and a hash of their content, so the app can show "changed since upload"
// (XC sets cannot be edited — delete on XC and upload again).

import { toXcId } from '../domain/xc/xcId.ts';
import { OWN_SOURCE_ID, DEFAULT_LAYER_ID } from './label-sources.ts';

export type UploadSource = 'own' | 'birdnet';

export interface UploadSelection {
    /** Excluded recording ids (new recordings are included by default). */
    excludedRecordings: string[];
    /** Excluded species keys. */
    excludedSpecies: string[];
    /** Excluded own layers. */
    excludedLayers: string[];
    sources: UploadSource[];
}

export const defaultUploadSelection = (): UploadSelection => ({
    excludedRecordings: [], excludedSpecies: [], excludedLayers: [], sources: ['own'],
});

export function normalizeUploadSelection(sel: any): UploadSelection {
    const arr = (v: any) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
    const sources = arr(sel?.sources).filter((s) => s === 'own' || s === 'birdnet') as UploadSource[];
    return {
        excludedRecordings: arr(sel?.excludedRecordings),
        excludedSpecies: arr(sel?.excludedSpecies),
        excludedLayers: arr(sel?.excludedLayers),
        sources: sources.length ? sources : ['own'],
    };
}

export const speciesKey = (l: any) => String(l?.scientificName || l?.label || '').trim() || '(no species)';

/** Upload source of a label, or null when it can never be uploaded (imported XC/file sets). */
export function uploadSourceOf(l: any, sets?: Map<string, any>): UploadSource | null {
    if (!l) return null;
    if (l.setId === OWN_SOURCE_ID) return 'own';
    const origin = (l.setId && sets?.get(l.setId)?.origin) || l.origin;
    if (origin === 'BirdNET' || origin === 'birdnet') return 'birdnet';
    if (!l.setId && !l.readonly && (!l.origin || l.origin === 'manual')) return 'own';
    return null;
}

export interface CandidateRecording {
    id: string; name: string; xcId: string | null;
    own: number; birdnet: number; included: boolean;
}
export interface UploadCandidates {
    recordings: CandidateRecording[];
    /** species key → label count over recordings with XC ID */
    species: Map<string, number>;
    /** layer id → label count over recordings with XC ID */
    layers: Map<string, number>;
}

/** What could go into a set: counts per recording / species / layer for the selection UI. */
export function uploadCandidates(entries: any[], sel: UploadSelection, sets?: Map<string, any>): UploadCandidates {
    const recordings: CandidateRecording[] = [];
    const species = new Map<string, number>();
    const layers = new Map<string, number>();
    for (const e of entries || []) {
        const labels = (e?.annotations || []) as any[];
        let own = 0, birdnet = 0;
        const xcId = toXcId(e?.xcId);
        for (const l of labels) {
            const src = uploadSourceOf(l, sets);
            if (src === 'own') own++;
            else if (src === 'birdnet') birdnet++;
            else continue;
            if (!xcId || !sel.sources.includes(src)) continue;
            const k = speciesKey(l);
            species.set(k, (species.get(k) || 0) + 1);
            if (src === 'own') {
                const layer = l.layer || DEFAULT_LAYER_ID;
                layers.set(layer, (layers.get(layer) || 0) + 1);
            }
        }
        if (!own && !birdnet) continue;
        recordings.push({
            id: e.id, name: e.filename || xcId || 'Untitled', xcId, own, birdnet,
            included: !!xcId && !sel.excludedRecordings.includes(e.id),
        });
    }
    return { recordings, species, layers };
}

/**
 * Labels of the selection with the recording entry they belong to.
 * `skipped` = recordings with selected labels but without XC ID (local only).
 */
export function selectUploadLabels(entries: any[], sel: UploadSelection, sets?: Map<string, any>) {
    const out: { label: any; entry: any }[] = [];
    const skipped: any[] = [];
    for (const e of entries || []) {
        if (sel.excludedRecordings.includes(e?.id)) continue;
        const picked = ((e?.annotations || []) as any[]).filter((l) => {
            const src = uploadSourceOf(l, sets);
            if (!src || !sel.sources.includes(src)) return false;
            if (sel.excludedSpecies.includes(speciesKey(l))) return false;
            if (src === 'own' && sel.excludedLayers.includes(l.layer || DEFAULT_LAYER_ID)) return false;
            return true;
        });
        if (!picked.length) continue;
        if (!toXcId(e.xcId)) { skipped.push(e); continue; }
        for (const label of picked) out.push({ label, entry: e });
    }
    return { items: out, skipped };
}

// ── Snapshots ─────────────────────────────────────────────────────────

const HASH_FIELDS = ['start', 'end', 'freqMin', 'freqMax', 'scientificName', 'label', 'tags', 'remarks', 'comment'];

function stable(v: any): string {
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${k}:${stable(v[k])}`).join(',')}}`;
    return JSON.stringify(v ?? null);
}

/** Content hash of the uploaded fields (FNV-1a over a stable serialisation). */
export function labelsHash(labels: any[]) {
    const rows = labels
        .map((l) => stable([String(l?.id ?? ''), ...HASH_FIELDS.map((f) => l?.[f])]))
        .sort();
    let h = 0x811c9dc5;
    for (const ch of rows.join('\n')) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
}

export interface UploadSnapshot {
    id: string;
    uploadedAt: string;
    name: string;
    license: string;
    env: string;
    recordings: string[];      // XC IDs
    labelIds: string[];
    hash: string;
}

export function makeUploadSnapshot(labels: any[], entries: any[], meta: { name?: string; license?: string; env?: string }, now = new Date()): UploadSnapshot {
    const recs = [...new Set(entries.map((e) => toXcId(e?.xcId)).filter(Boolean) as string[])].sort();
    return {
        id: `up_${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        uploadedAt: now.toISOString(),
        name: meta.name || '',
        license: meta.license || '',
        env: meta.env || 'live',
        recordings: recs,
        labelIds: labels.map((l) => String(l?.id ?? '')).sort(),
        hash: labelsHash(labels),
    };
}

export type SnapshotState = 'current' | 'changed';

/** Compare a snapshot with the labels that exist now (by id): edited or deleted labels → 'changed'. */
export function snapshotState(snap: UploadSnapshot, allLabels: any[]): { state: SnapshotState; missing: number } {
    const byId = new Map(allLabels.map((l) => [String(l?.id ?? ''), l]));
    const now = snap.labelIds.map((id) => byId.get(id)).filter(Boolean);
    const missing = snap.labelIds.length - now.length;
    const same = !missing && labelsHash(now) === snap.hash;
    return { state: same ? 'current' : 'changed', missing };
}
