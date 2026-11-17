// app/suggest-similar.ts — turn correlation hits into suggestion labels
//
// Suggestions live in a locked machine set (origin 'Similar'), like BirdBox's boxes, so they
// show, hide and copy (✓) like any detection. Each carries the exemplar's species and a
// `similar` record: which label it was found from, the score, and which sources found it.
// Copying keeps that record in `adoptedFrom.similar`.
//
// - Places already labelled with the species (own labels) are left out.
// - A BirdBox box over the hit (same time, overlapping band) gives the bounds: its boxes sit
//   better when present; the correlation box (exemplar size) is kept otherwise.
// - Rejected suggestions (key: species + rounded time) are not proposed again.

import { timeIoU, type Box, type SimilarHit } from '../domain/similar/ncc.ts';

export const SIMILAR_ORIGIN = 'Similar';

export interface SimilarRecord { sourceLabelId: string; score: number; sources: string[] }

const name = (l: any) => String(l?.scientificName || l?.label || '').trim().toLowerCase();
const freqOverlap = (a: Box, b: Box) => Math.max(0, Math.min(a.freqMax, b.freqMax) - Math.max(a.freqMin, b.freqMin));

/** Identity of a suggestion for "rejected, don't propose again". */
export function suggestionKey(species: string, start: number): string {
    return `${String(species || '').trim().toLowerCase()}|${(Math.round(start * 10) / 10).toFixed(1)}`;
}

/** The labels (own or copied) that count as "already labelled". */
const labelled = (l: any) => l && l.origin !== SIMILAR_ORIGIN && !l.readonly;

export interface BuildOptions {
    /** All labels of the recording (own, detections, earlier suggestions). */
    labels: any[];
    /** BirdBox's boxes of the recording. */
    boxes?: Box[];
    /** suggestionKey()s rejected before. */
    rejected?: Set<string>;
    setId: string;
    recordingId?: string | null;
    newId: () => string;
    /** Told which hit (index in `hits`) each suggestion came from. */
    onPick?: (suggestion: any, hitIndex: number) => void;
}

/** Suggestion labels for `hits` of `exemplar`, best first. */
export function buildSuggestions(exemplar: any, hits: SimilarHit[], opts: BuildOptions): any[] {
    const sp = name(exemplar);
    const own = (opts.labels || []).filter((l) => labelled(l) && name(l) === sp);
    const out: any[] = [];
    for (const [hi, h] of hits.entries()) {
        if (own.some((l) => timeIoU(h, l) >= 0.3)) continue;
        if (opts.rejected?.has(suggestionKey(sp, h.start))) continue;
        let box: Box = h;
        const sources = ['correlation'];
        let best = 0;
        for (const b of opts.boxes || []) {
            const v = timeIoU(h, b);
            if (v >= 0.5 && v > best && freqOverlap(h, b) > 0) { best = v; box = b; }
        }
        if (best) sources.push('BirdBox');
        if (out.some((s) => timeIoU(s, box) >= 0.5)) continue;   // two hits on one BirdBox box
        const sug = {
            id: opts.newId(),
            start: box.start, end: box.end, freqMin: box.freqMin, freqMax: box.freqMax, fullBand: false,
            label: exemplar.label, scientificName: exemplar.scientificName || '', commonName: exemplar.commonName,
            ...(exemplar.color ? { color: exemplar.color } : {}),
            origin: SIMILAR_ORIGIN, readonly: true, confidence: Math.round(h.score * 1000) / 1000,
            setId: opts.setId, ...(opts.recordingId ? { recordingId: opts.recordingId } : {}),
            similar: { sourceLabelId: exemplar.id, score: h.score, sources } satisfies SimilarRecord,
        };
        out.push(sug);
        opts.onPick?.(sug, hi);
    }
    return out;
}

/** Rows computed for the search: the exemplar's band plus room for the margin and frequency shift. */
export function searchBand(exemplar: Box, sampleRate: number): [number, number] {
    const pad = Math.max(500, 0.25 * (exemplar.freqMax - exemplar.freqMin));
    return [Math.max(0, exemplar.freqMin - pad), Math.min(sampleRate / 2, exemplar.freqMax + pad)];
}
