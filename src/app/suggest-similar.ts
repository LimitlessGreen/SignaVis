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
    /** Box as suggested (BirdBox may have refined the hit); base for carrying corrections over. */
    found?: Box;
    /** Box as last shown (found, or moved by carried-over corrections); differs once the user edits it. */
    shown?: Box;
    /** The correlation hit itself: re-ranking measures where a corrected call sits from here. */
    hit?: Box;
    /** The suggestion under review: highlighted and resizable. */
    active?: boolean;
}

/** Edge moves of one box against another. */
export interface BoxCorrection { start: number; end: number; freqMin: number; freqMax: number }
const diff = (l: Box, f: Box): BoxCorrection => ({ start: l.start - f.start, end: l.end - f.end, freqMin: l.freqMin - f.freqMin, freqMax: l.freqMax - f.freqMax });
const moved = (d: BoxCorrection) => Object.values(d).some((v) => Math.abs(v) > 1e-6);

/** The user edited this suggestion: its box differs from the one shown (carried-over moves are not edits). */
export function userEdited(l: any): boolean {
    const shown = l?.similar?.shown || l?.similar?.found;
    return !!shown && moved(diff(l, shown));
}

/** The user's correction against the box as found (null: not edited by the user). */
export function correctionOf(l: any): BoxCorrection | null {
    const f = l?.similar?.found;
    return f && userEdited(l) ? diff(l, f) : null;
}

/** For re-ranking: how far the centre of a user-corrected box is from its correlation hit (undefined: not edited). */
export function hitMove(l: any): { dt: number; df: number } | undefined {
    const h = l?.similar?.hit || l?.similar?.found;
    if (!h || !userEdited(l)) return undefined;
    return { dt: (l.start + l.end - h.start - h.end) / 2, df: (l.freqMin + l.freqMax - h.freqMin - h.freqMax) / 2 };
}

/** Mean of corrections; applied to suggestions not looked at yet (the same systematic offset). */
export function meanCorrection(list: BoxCorrection[]): BoxCorrection | null {
    if (!list.length) return null;
    const m = { start: 0, end: 0, freqMin: 0, freqMax: 0 };
    for (const d of list) for (const k of Object.keys(m) as (keyof BoxCorrection)[]) m[k] += d[k] / list.length;
    return m;
}

const MIN_DUR = 0.01, MIN_BAND = 10;

/** `box` moved by `d`, kept inside the recording (0..duration, 0..nyquist) with a minimum size. */
export function applyCorrection(box: Box, d: BoxCorrection, nyquist = Infinity, duration = Infinity): Box {
    const fit = (lo: number, hi: number, max: number, min: number) => {
        const top = Math.max(min, max);
        lo = Math.min(Math.max(0, lo), top - min);
        hi = Math.min(top, Math.max(lo + min, hi));
        return [lo, hi];
    };
    const [start, end] = fit(box.start + d.start, box.end + d.end, duration, MIN_DUR);
    const [freqMin, freqMax] = fit(box.freqMin + d.freqMin, box.freqMax + d.freqMax, nyquist, MIN_BAND);
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
                found: { start: box.start, end: box.end, freqMin: box.freqMin, freqMax: box.freqMax },
                hit: { start: h.start, end: h.end, freqMin: h.freqMin, freqMax: h.freqMax } } satisfies SimilarRecord,
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
