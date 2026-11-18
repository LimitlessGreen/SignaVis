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

export interface SimilarRecord {
    sourceLabelId: string; score: number; sources: string[];
    /** suggestionKey() of the correlation hit: recorded on reject, checked on the next search. */
    key?: string;
    /** Box as suggested; the user may correct the suggestion under review before copying it. */
    found?: Box;
    /** The suggestion under review: highlighted and resizable. */
    active?: boolean;
}

/** Edge moves of a corrected suggestion against its box as suggested (null: unchanged). */
export interface BoxCorrection { start: number; end: number; freqMin: number; freqMax: number }
export function correctionOf(l: any): BoxCorrection | null {
    const f = l?.similar?.found;
    if (!f) return null;
    const d = { start: l.start - f.start, end: l.end - f.end, freqMin: l.freqMin - f.freqMin, freqMax: l.freqMax - f.freqMax };
    return Object.values(d).some((v) => Math.abs(v) > 1e-6) ? d : null;
}

/** Centre move of a correction (for re-ranking: where the corrected call really sits). */
export function centreMove(d: BoxCorrection): { dt: number; df: number } {
    return { dt: (d.start + d.end) / 2, df: (d.freqMin + d.freqMax) / 2 };
}

/** Mean of corrections; applied to suggestions not looked at yet (the same systematic offset). */
export function meanCorrection(list: BoxCorrection[]): BoxCorrection | null {
    if (!list.length) return null;
    const m = { start: 0, end: 0, freqMin: 0, freqMax: 0 };
    for (const d of list) for (const k of Object.keys(m) as (keyof BoxCorrection)[]) m[k] += d[k] / list.length;
    return m;
}

/** `box` moved by `d`, kept valid (start < end, 0 ≤ freqMin < freqMax ≤ nyquist). */
export function applyCorrection(box: Box, d: BoxCorrection, nyquist = Infinity): Box {
    const start = Math.max(0, box.start + d.start), end = Math.max(start + 0.01, box.end + d.end);
    const freqMin = Math.max(0, box.freqMin + d.freqMin), freqMax = Math.min(nyquist, Math.max(freqMin + 10, box.freqMax + d.freqMax));
    return { start, end, freqMin, freqMax };
}

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
        const key = suggestionKey(sp, h.start);   // before BirdBox refines the start
        if (opts.rejected?.has(key)) continue;
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
            similar: { sourceLabelId: exemplar.id, score: h.score, sources, key,
                found: { start: box.start, end: box.end, freqMin: box.freqMin, freqMax: box.freqMax } } satisfies SimilarRecord,
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
