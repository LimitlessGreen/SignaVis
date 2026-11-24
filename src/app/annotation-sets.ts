// annotation-sets.ts — data model for annotation sets in a labeling session
//
// Registry entries of a session:
// - the own source (label-sources.ts, origin 'manual', unlocked): own labels + upload metadata,
//   status draft → ready from the local check; uploads are snapshots (upload-selection.ts);
// - imported sets (xeno-canto, BirdNET, file): locked, labels can be copied into the own source.
import { prefsStorage } from '../infrastructure/storage/prefs.ts';

export type SetStatus = 'draft' | 'ready';

export function isOwnSet(set: any) {
    return !!set && (set.origin || 'manual') === 'manual' && !set.locked;
}

/** Fill in fields added by the set model (status, upload date) and lock imported sets. */
export function normalizeSet(set: any) {
    const s = { ...set };
    if (!s.origin) s.origin = 'manual';
    if (s.origin !== 'manual') s.locked = true;
    if (!['draft', 'ready'].includes(s.status)) s.status = 'draft';
    return s;
}

/** Status after a local check: 'ready' without errors, else 'draft'. */
export function setStatusFromValidation(set: any, validation: { ok: boolean }) {
    if (!set) return 'draft';
    set.status = validation?.ok ? 'ready' : 'draft';
    return set.status;
}

let _adoptCounter = 0;
function newLabelId() {
    _adoptCounter += 1;
    return `slabel_${Date.now().toString(36)}${_adoptCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Copy labels (e.g. from an imported XC/BirdNET set) into the own source.
 * Copies get new IDs and become editable manual labels; the source is kept in `adoptedFrom`.
 * `layer`: own layer for the copies (see label-sources.ts).
 * A source's `adoptBox` (adopt-detection.ts: the call box as detected) is kept as `adoptedFrom.box`.
 */
export function adoptLabels(labels: any[], targetSetId: string, now = new Date(), layer?: string) {
    return (labels || []).map((l) => {
        const { readonly, annotationSet, adoptBox, similar, reviewing, ...rest } = l || {};
        return {
            ...rest,
            id: newLabelId(),
            setId: targetSetId,
            origin: 'manual',
            readonly: false,
            createdAt: now.toISOString(),
            adoptedFrom: {
                id: l?.id ?? null, setId: l?.setId ?? null, origin: l?.origin ?? null,
                ...(adoptBox ? { box: { ...adoptBox } } : {}),
                // Found as a repeat of an own label (suggest-similar.ts): exemplar, score, sources
                ...(similar ? { similar: (({ active, ...rec }) => ({ ...rec, sources: [...(similar.sources || [])] }))(similar) } : {}),
            },
            ...(layer ? { layer } : {}),
        };
    });
}

/**
 * Identity of a call box copied under a name: time and frequency bounds as detected plus
 * the name it was copied as (`adoptBox` of a source, `adoptedFrom.box` of a copy).
 * The same box may be copied once per species.
 */
export function adoptBoxKey(box: any) {
    const n = (v: any, digits: number) => (Number.isFinite(Number(v)) ? Number(v).toFixed(digits) : '');
    return `${String(box?.label ?? '').trim().toLowerCase()}|${n(box?.start, 3)}|${n(box?.end, 3)}|${n(box?.freqMin, 0)}|${n(box?.freqMax, 0)}`;
}

/** Which detection (and which of its call boxes, under which name) a copy came from. */
function adoptKey(id: any, box: any) {
    return box ? `${id}|${adoptBoxKey(box)}` : String(id);
}

/**
 * Labels of `src` that have no copy in `targetSetId` yet (a copy carries adoptedFrom.id,
 * and adoptedFrom.box when it took a call box).
 * Makes "copy into my labels" idempotent: pressing it twice adds nothing.
 * A copy the user deleted again counts as not adopted, so it can be copied once more.
 */
/**
 * Ids of detections that were copied into `targetSetId` (its labels' `adoptedFrom.id`).
 * Adopting converts a detection into an own label, so these are not shown again;
 * deleting the copy (or undo) brings the detection back.
 */
export function adoptedSourceIds(existing: any[], targetSetId: string): Set<string> {
    const ids = new Set<string>();
    for (const l of existing || []) {
        if (l?.setId === targetSetId && l.adoptedFrom?.id != null) ids.add(String(l.adoptedFrom.id));
    }
    return ids;
}

/** `labels` without the detections already adopted into `targetSetId`. */
export function withoutAdopted(labels: any[], targetSetId: string): any[] {
    const ids = adoptedSourceIds(labels, targetSetId);
    if (!ids.size) return labels;
    return labels.filter((l) => l?.setId === targetSetId || !ids.has(String(l?.id)));
}

/**
 * State after the player's undo/redo (its snapshots hold only the labels it shows): labels in
 * `before` but not in `after` are deleted, except detections that `after` hides because a copy
 * in `ownSetId` converts them (a redone conversion hides its detection, it does not delete it).
 * `fill` completes labels new to the app (origin, set).
 */
export function applyPlayerRestore(labels: any[], before: any[], after: any[], ownSetId: string,
    fill: (l: any) => any = (l) => l): any[] {
    const afterIds = new Set(after.map((l) => l.id));
    const kept = labels.slice();
    const at = new Map(kept.map((l, i) => [l.id, i]));
    for (const lbl of after) {
        const i = at.get(lbl.id);
        if (i != null) kept[i] = { ...kept[i], ...lbl };
        else { at.set(lbl.id, kept.length); kept.push(fill({ ...lbl })); }
    }
    const converted = adoptedSourceIds(kept.filter((l) => afterIds.has(l.id)), ownSetId);
    const removed = new Set(before.filter((l) => !afterIds.has(l.id) && !converted.has(String(l.id))).map((l) => l.id));
    return kept.filter((l) => !removed.has(l.id));
}

export function labelsToAdopt(src: any[], existing: any[], targetSetId: string) {
    const done = new Set((existing || [])
        .filter((l) => l?.setId === targetSetId && l.adoptedFrom?.id != null)
        .map((l) => adoptKey(l.adoptedFrom.id, l.adoptedFrom.box)));
    return (src || []).filter((l) => !done.has(adoptKey(l?.id, l?.adoptBox)));
}

const LEGACY_MODE_KEY = 'audio-workbench.mode.v1';

/**
 * Migrate stored session data to the set model:
 * drops the old multi-file/standalone mode, normalizes every set.
 */
export function migrateSessionState(state: any, storage: any = prefsStorage) {
    try { storage?.removeItem?.(LEGACY_MODE_KEY); } catch { /* ignore */ }
    delete state.mode;
    const sets = state.labelSets instanceof Map ? state.labelSets : new Map();
    for (const [id, s] of sets) sets.set(id, normalizeSet(s));
    state.labelSets = sets;
    return state;
}

/** Name shown for a set: imported sets keep their original `name` (re-import matches by it). */
export function setDisplayName(set: any, fallback = ''): string {
    return (set?.displayName || set?.name || fallback) as string;
}

/**
 * Remove the labels of one set — from the recording on screen (`where: 'recording'`) or from every
 * recording (`'all'`). Labels without a setId belong to the own set. Returns the new label arrays and
 * whether other recordings still use the set (then its registry entry must stay).
 */
export function removeSetLabels(
    setId: string, where: 'recording' | 'all',
    live: any[], entries: { id: string; annotations?: any[] }[], activeId: string | null, ownSetId: string | null,
) {
    const inSet = (l: any) => (l?.setId || ownSetId) === setId;
    const liveKept = live.filter((l) => !inSet(l));
    let removed = live.length - liveKept.length;
    const changed = new Map<string, any[]>();
    let usedElsewhere = false;
    for (const e of entries) {
        if (e.id === activeId) continue;
        const anns = e.annotations || [];
        if (where === 'all') {
            const kept = anns.filter((l) => !inSet(l));
            if (kept.length !== anns.length) { changed.set(e.id, kept); removed += anns.length - kept.length; }
        } else if (anns.some(inSet)) usedElsewhere = true;
    }
    return { live: liveKept, entries: changed, removed, usedElsewhere };
}

/** "Show only this set": hide all others, or — when it is already the only one shown — show all again. */
export function soloHidden(hidden: ReadonlySet<string>, setIds: readonly string[], setId: string): Set<string> {
    const others = setIds.filter((id) => id !== setId);
    const isSolo = !hidden.has(setId) && others.length > 0 && others.every((id) => hidden.has(id));
    const next = new Set(hidden);
    if (isSolo) for (const id of others) next.delete(id);
    else { next.delete(setId); for (const id of others) next.add(id); }
    return next;
}

export function isSoloSet(hidden: ReadonlySet<string>, setIds: readonly string[], setId: string): boolean {
    const others = setIds.filter((id) => id !== setId);
    return !hidden.has(setId) && others.length > 0 && others.every((id) => hidden.has(id));
}
