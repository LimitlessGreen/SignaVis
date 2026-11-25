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
        // an absent copy records a rejection: the detection stays visible (as rejected)
        if (l?.setId === targetSetId && l.adoptedFrom?.id != null && l.polarity !== 'absent') ids.add(String(l.adoptedFrom.id));
    }
    return ids;
}

/** `labels` without the detections already adopted into `targetSetId`. */
export function withoutAdopted(labels: any[], targetSetId: string): any[] {
    const ids = adoptedSourceIds(labels, targetSetId);
    // absent copies of rejected detections are kept but not drawn (the detection shows the rejection)
    const rejectedCopy = (l: any) => l?.setId === targetSetId && l.polarity === 'absent' && l.adoptedFrom?.id != null;
    if (!ids.size && !labels.some(rejectedCopy)) return labels;
    return labels.filter((l) => (l?.setId === targetSetId ? !rejectedCopy(l) : !ids.has(String(l?.id))));
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
