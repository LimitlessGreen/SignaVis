// annotation-sets.ts — data model for annotation sets in a labeling session
//
// Registry entries of a session:
// - the own source (label-sources.ts, origin 'manual', unlocked): own labels + upload metadata,
//   status draft → ready from the local check; uploads are snapshots (upload-selection.ts);
// - imported sets (xeno-canto, BirdNET, file): locked, labels can be copied into the own source.

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
 */
export function adoptLabels(labels: any[], targetSetId: string, now = new Date(), layer?: string) {
    return (labels || []).map((l) => {
        const { readonly, annotationSet, ...rest } = l || {};
        return {
            ...rest,
            id: newLabelId(),
            setId: targetSetId,
            origin: 'manual',
            readonly: false,
            createdAt: now.toISOString(),
            adoptedFrom: { id: l?.id ?? null, setId: l?.setId ?? null, origin: l?.origin ?? null },
            ...(layer ? { layer } : {}),
        };
    });
}

const LEGACY_MODE_KEY = 'audio-workbench.mode.v1';

/**
 * Migrate stored session data to the set model:
 * drops the old multi-file/standalone mode, normalizes every set.
 */
export function migrateSessionState(state: any, storage: any = (globalThis as any).localStorage) {
    try { storage?.removeItem?.(LEGACY_MODE_KEY); } catch { /* ignore */ }
    delete state.mode;
    const sets = state.labelSets instanceof Map ? state.labelSets : new Map();
    for (const [id, s] of sets) sets.set(id, normalizeSet(s));
    state.labelSets = sets;
    return state;
}
