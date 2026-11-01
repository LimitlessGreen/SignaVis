// label-sources.ts — where a label comes from, independent of any upload set
//
// Labels belong to their recording (entry.annotations). Their source is
// - 'own'          own labels (editable), registry entry with the fixed id OWN_SOURCE_ID;
// - 'birdnet'      BirdNET results;
// - 'xc-set:<id>'  an annotation set imported from Xeno-canto (read-only);
// - 'file:<id>'    a set imported from a file (read-only).
// Imported sources stay in the `labelSets` registry and labels point at them via `setId`.
//
// Own labels carry a `layer` (default DEFAULT_LAYER_ID). Layers are optional: as long as
// only the default layer exists the UI does not show them. The layer list lives on the
// own registry entry (`layers`, `activeLayerId`).
//
// Until the upload tab builds sets from a selection (plan phase 4), the own entry also
// carries the upload metadata (name, license, status …) of the next XC upload.

import { isOwnSet } from './annotation-sets.ts';

export const OWN_SOURCE_ID = 'own';
export const DEFAULT_LAYER_ID = 'default';
export const DEFAULT_LAYER = Object.freeze({ id: DEFAULT_LAYER_ID, name: 'Default' });

export type LabelSource = 'own' | 'birdnet' | `xc-set:${string}` | `file:${string}`;

export interface Layer { id: string; name: string; annotator?: string; annotatorXcId?: string; color?: string }

/** Own label: points at the own source, or has no source at all and is manual. */
export function isOwnLabel(l: any) {
    if (!l) return false;
    if (l.setId) return l.setId === OWN_SOURCE_ID;
    return !l.readonly && (!l.origin || l.origin === 'manual');
}

/** Source of a label, derived from its registry entry. */
export function labelSource(l: any, sets?: Map<string, any>): LabelSource {
    if (isOwnLabel(l)) return 'own';
    const set = l?.setId ? sets?.get(l.setId) : null;
    const origin = set?.origin || l?.origin;
    if (origin === 'BirdNET' || origin === 'birdnet') return 'birdnet';
    if (origin === 'xeno-canto') return `xc-set:${l?.setId ?? ''}`;
    return `file:${l?.setId ?? ''}`;
}

export const labelLayer = (l: any) => (isOwnLabel(l) ? (l?.layer || DEFAULT_LAYER_ID) : null);

/** Layer list of the own entry; always contains the default layer first. */
export function ownLayers(sets: Map<string, any>): Layer[] {
    const list: Layer[] = Array.isArray(sets.get(OWN_SOURCE_ID)?.layers) ? sets.get(OWN_SOURCE_ID).layers : [];
    const rest = list.filter((x) => x && x.id && x.id !== DEFAULT_LAYER_ID);
    const def = list.find((x) => x?.id === DEFAULT_LAYER_ID) || { ...DEFAULT_LAYER };
    return [def, ...rest];
}

export function activeLayerId(sets: Map<string, any>) {
    const id = sets.get(OWN_SOURCE_ID)?.activeLayerId;
    return ownLayers(sets).some((x) => x.id === id) ? id : DEFAULT_LAYER_ID;
}

/** Turn a label into an own label on the active layer (keeps an existing own layer). */
export function asOwnLabel(l: any, sets: Map<string, any>) {
    const layer = isOwnLabel(l) && l.layer ? l.layer : activeLayerId(sets);
    return { ...l, setId: OWN_SOURCE_ID, layer };
}

/**
 * Bring the registry and labels to the source model (idempotent).
 * - The own set (preferred id, else the first own set) moves to OWN_SOURCE_ID; its old id is kept
 *   in `legacyIds`, so labels restored later from older storage still find it.
 * - Further own (manual, unlocked) sets become layers of the own source.
 * - Own labels get setId OWN_SOURCE_ID and a layer; manual labels without a set count as own.
 * `create` builds the own entry when there is none (gets id OWN_SOURCE_ID).
 * Label lists are changed in place; returns true when anything changed.
 */
export function migrateToOwnSource(
    sets: Map<string, any>,
    labelLists: any[][],
    { preferredId = null as string | null, create = null as null | (() => any) } = {},
) {
    let changed = false;
    const layerOf = new Map<string, string>();   // old set id → layer id
    let own = sets.get(OWN_SOURCE_ID);

    const legacyOwn = [...sets.entries()].filter(([id, s]) => id !== OWN_SOURCE_ID && isOwnSet(s));
    if (!own && legacyOwn.length) {
        const pick = legacyOwn.find(([id]) => id === preferredId) || legacyOwn[0];
        own = { ...pick[1], id: OWN_SOURCE_ID, legacyIds: [...(pick[1].legacyIds || []), pick[0]] };
        sets.delete(pick[0]);
        sets.set(OWN_SOURCE_ID, own);
        changed = true;
    }
    if (!own && create) {
        const made = create();
        if (made?.id && made.id !== OWN_SOURCE_ID) sets.delete(made.id);
        own = { ...made, id: OWN_SOURCE_ID };
        sets.set(OWN_SOURCE_ID, own);
        changed = true;
    }
    if (!own) return changed;
    if (sets.get(OWN_SOURCE_ID) !== own) sets.set(OWN_SOURCE_ID, own);

    for (const id of own.legacyIds || []) layerOf.set(id, DEFAULT_LAYER_ID);
    const layers = ownLayers(sets);
    for (const [id, s] of [...sets.entries()]) {
        if (id === OWN_SOURCE_ID || !isOwnSet(s)) continue;
        if (!layers.some((x) => x.id === id)) layers.push({ id, name: s.name || id });
        layerOf.set(id, id);
        sets.delete(id);
        changed = true;
    }
    if (JSON.stringify(own.layers) !== JSON.stringify(layers)) { own.layers = layers; changed = true; }

    for (const list of labelLists) {
        for (const l of list || []) {
            if (!l) continue;
            if (l.setId && layerOf.has(l.setId)) {
                if (!l.layer || l.layer === DEFAULT_LAYER_ID) l.layer = layerOf.get(l.setId);
                l.setId = OWN_SOURCE_ID;
                changed = true;
            } else if (!l.setId && isOwnLabel(l)) {
                l.setId = OWN_SOURCE_ID;
                changed = true;
            }
            if (l.setId === OWN_SOURCE_ID && !l.layer) { l.layer = DEFAULT_LAYER_ID; changed = true; }
        }
    }
    return changed;
}

// ── Layer editing (own source) ─────────────────────────────────────────

function ownEntry(sets: Map<string, any>) {
    const own = sets.get(OWN_SOURCE_ID);
    if (own) own.layers = ownLayers(sets);
    return own;
}

/** Add a layer and make it the active one. Returns the new layer (null without own entry). */
export function addLayer(sets: Map<string, any>, name: string): Layer | null {
    const own = ownEntry(sets);
    if (!own) return null;
    const base = String(name || '').trim() || `Layer ${own.layers.length + 1}`;
    let id = `layer_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    while (own.layers.some((l: Layer) => l.id === id)) id += 'x';
    const layer = { id, name: base };
    own.layers.push(layer);
    own.activeLayerId = id;
    return layer;
}

export function renameLayer(sets: Map<string, any>, id: string, name: string) {
    const own = ownEntry(sets);
    const l = own?.layers.find((x: Layer) => x.id === id);
    if (!l || !String(name || '').trim()) return false;
    l.name = String(name).trim();
    return true;
}

/** Annotator of a layer (name + optional XC user id); empty name = use the profile again. */
export function setLayerAnnotator(sets: Map<string, any>, id: string, annotator: string, annotatorXcId = '') {
    const own = ownEntry(sets);
    const l = own?.layers.find((x: Layer) => x.id === id);
    if (!l) return false;
    const name = String(annotator || '').trim();
    if (name) { l.annotator = name; l.annotatorXcId = String(annotatorXcId || '').trim(); }
    else { delete l.annotator; delete l.annotatorXcId; }
    return true;
}

/**
 * Upload fields of an own label whose layer has an annotator: `author` + `annotatorXcId`
 * (see buildAnnotaAnnotation). null for other labels — they keep the profile as annotator.
 */
export function layerAnnotatorFields(sets: Map<string, any>, l: any) {
    if (l?.setId !== OWN_SOURCE_ID) return null;
    const layer = ownLayers(sets).find((x) => x.id === (l.layer || DEFAULT_LAYER_ID));
    if (!layer?.annotator) return null;
    return { author: layer.annotator, annotatorXcId: layer.annotatorXcId || '' };
}

export function setActiveLayer(sets: Map<string, any>, id: string) {
    const own = ownEntry(sets);
    if (!own || !own.layers.some((x: Layer) => x.id === id)) return false;
    own.activeLayerId = id;
    return true;
}

/**
 * Remove a layer; its labels move to the default layer (labels are never deleted here).
 * The default layer cannot be removed. Label lists are changed in place; returns moved count.
 */
export function removeLayer(sets: Map<string, any>, id: string, labelLists: any[][]) {
    const own = ownEntry(sets);
    if (!own || id === DEFAULT_LAYER_ID || !own.layers.some((x: Layer) => x.id === id)) return -1;
    own.layers = own.layers.filter((x: Layer) => x.id !== id);
    if (own.activeLayerId === id) own.activeLayerId = DEFAULT_LAYER_ID;
    let moved = 0;
    for (const list of labelLists) for (const l of list || []) {
        if (l?.setId === OWN_SOURCE_ID && l.layer === id) { l.layer = DEFAULT_LAYER_ID; moved++; }
    }
    return moved;
}
