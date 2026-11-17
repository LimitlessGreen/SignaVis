// adopt-detection.ts — what "✓ copy into my labels" copies for a machine detection
//
// BirdNET knows the species but not where the call is (3 s window, full band);
// BirdBox knows the call's box but not the species. Adopting one of them takes
// the missing half from the other when they overlap:
// - BirdNET detection → the call box(es) inside its window, named after the species;
// - BirdBox box       → the species of the BirdNET detection it lies in, else the
//                       label template's species, else it still needs a name.
// The results are sources for adoptLabels() (annotation-sets.ts); `adoptBox` records
// the box as detected and the name it is copied under, so a later edit of the copy
// does not make it look new, and the same box can still be copied as another species.

import { adoptBoxKey } from './annotation-sets.ts';

export const SPECIES_ORIGIN = 'BirdNET';
export const BOX_ORIGIN = 'BirdBox';

export interface AdoptTemplate { name?: string; color?: string; scientificName?: string; tags?: Record<string, string> }
export interface AdoptionPlan {
    /** Labels to hand to adoptLabels(). */
    sources: any[];
    /** Call boxes found for a species detection (0: copied as it is). */
    candidates: number;
    /** A call box without a species: ask for a name after copying. */
    needsName: boolean;
}

const span = (l: any) => Math.max(0, (l?.end ?? 0) - (l?.start ?? 0));
const overlap = (a: any, b: any) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
/** At least half of the box lies in the detection's time window. */
const inside = (box: any, det: any) => span(box) > 0 && overlap(box, det) >= 0.5 * span(box);
const sameSpecies = (a: any, b: any) => {
    const sa = String(a?.scientificName || '').trim().toLowerCase(), sb = String(b?.scientificName || '').trim().toLowerCase();
    if (sa && sb) return sa === sb;
    return String(a?.label ?? a?.name ?? '').trim().toLowerCase() === String(b?.label ?? b?.name ?? '').trim().toLowerCase();
};

/** Call boxes inside a species detection's window, most confident first. */
export function boxesIn(det: any, labels: any[]): any[] {
    return (labels || []).filter((l) => l?.origin === BOX_ORIGIN && inside(l, det))
        .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0) || a.start - b.start);
}

/** The most confident species detection whose window holds the box. */
export function speciesFor(box: any, labels: any[]): any | null {
    let best: any = null;
    for (const l of labels || []) {
        if (l?.origin !== SPECIES_ORIGIN || !inside(box, l)) continue;
        if (!best || (l.confidence ?? 0) > (best.confidence ?? 0)) best = l;
    }
    return best;
}

/**
 * What adopting `lbl` copies. `all`: the labels of the same recording.
 * `mode`: 'best' takes the most confident call box of a species detection, 'all' every one.
 */
export function adoptionPlan(lbl: any, all: any[], { mode = 'best', template = null }: { mode?: 'best' | 'all'; template?: AdoptTemplate | null } = {}): AdoptionPlan {
    const tplTags = template?.tags && Object.keys(template.tags).length ? template.tags : null;
    // Template tags go onto its own species, or onto any when it names none
    const withTags = (l: any) => (tplTags && (!template?.name || sameSpecies(template, l))
        ? { ...l, tags: { ...(l.tags || {}), ...tplTags } } : l);
    const asBox = (l: any, box: any) => ({
        ...l, start: box.start, end: box.end, freqMin: box.freqMin, freqMax: box.freqMax, fullBand: false,
        adoptBox: { start: box.start, end: box.end, freqMin: box.freqMin, freqMax: box.freqMax, label: l.label },
    });

    if (lbl?.origin === SPECIES_ORIGIN) {
        const boxes = boxesIn(lbl, all);
        if (!boxes.length) return { sources: [withTags(lbl)], candidates: 0, needsName: false };
        const chosen = mode === 'all' ? boxes : boxes.slice(0, 1);
        return { sources: chosen.map((b) => withTags(asBox(lbl, b))), candidates: boxes.length, needsName: false };
    }
    if (lbl?.origin === BOX_ORIGIN) {
        const det = speciesFor(lbl, all);
        const named = det
            ? { label: det.label, scientificName: det.scientificName || '', commonName: det.commonName }
            : template?.name
                ? { label: template.name, scientificName: template.scientificName || '', ...(template.color ? { color: template.color } : {}) }
                : null;
        return { sources: [withTags(asBox({ ...lbl, ...(named || {}) }, lbl))], candidates: 0, needsName: !named };
    }
    return { sources: [lbl], candidates: 0, needsName: false };
}

/**
 * Drop sources whose call box (time, frequency) is already in `targetSetId` under the same name, or
 * twice in `sources`: overlapping detections of one species share their boxes, and
 * a box's id changes when the detector's sliders move.
 */
export function withoutKnownBoxes(sources: any[], existing: any[], targetSetId: string): any[] {
    const known = new Set<string>();
    for (const l of existing || []) {
        if (l?.setId === targetSetId && l.adoptedFrom?.box) known.add(adoptBoxKey(l.adoptedFrom.box));
    }
    return (sources || []).filter((s) => {
        if (!s?.adoptBox) return true;
        const k = adoptBoxKey(s.adoptBox);
        if (known.has(k)) return false;
        known.add(k);
        return true;
    });
}
