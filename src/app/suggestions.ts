// suggestions.ts — BirdNET detections of one recording as suggestions to review (Annotate v2, B4)
//
// A suggestion is one decision: a single 3 s window, or a call run (adjacent windows of the
// same species, joined unless `join` is off). Its state comes from the detections it holds:
// - accepted: a window was copied into the own labels (adoptedFrom.id, see annotation-sets.ts);
// - rejected / unsure: `review` on the detection (set by setReview);
// - open: none of these.
// Groups are per species, unexpected species (low geo score) first, then by best confidence.

export type ReviewState = 'open' | 'accepted' | 'rejected' | 'unsure';

export interface Suggestion {
    key: string;
    species: string;
    scientificName: string;
    start: number;
    end: number;
    /** Highest window confidence. */
    confidence: number;
    windows: any[];
    state: ReviewState;
}

export interface SuggestionGroup {
    species: string;
    scientificName: string;
    unexpected: boolean;
    best: number;
    windows: number;
    suggestions: Suggestion[];
}

export interface SuggestionOptions {
    /** Join adjacent windows of one species into a call run (default on). */
    join?: boolean;
    /** Ignore windows below this confidence. */
    minConfidence?: number;
    /** Ids of detections copied into the own labels. */
    adoptedIds?: Set<string>;
    /** Geo score per species key (scientific name, lower case); below `unexpectedBelow` = unexpected. */
    geoScore?: (speciesKey: string) => number | null | undefined;
    unexpectedBelow?: number;
    /** Max gap in seconds between windows of one run. */
    gap?: number;
}

const speciesKey = (l: any) => String(l?.scientificName || l?.label || '').trim().toLowerCase();

/** The review state of one detection on its own. */
export function windowState(det: any, adoptedIds?: Set<string>): ReviewState {
    if (det?.id != null && adoptedIds?.has(String(det.id))) return 'accepted';
    if (det?.review === 'rejected' || det?.review === 'unsure') return det.review;
    return 'open';
}

/** A run's state: any accepted window accepts it; otherwise all windows must agree, else open. */
function runState(states: ReviewState[]): ReviewState {
    if (states.includes('accepted')) return 'accepted';
    const first = states[0] ?? 'open';
    return states.every((s) => s === first) ? first : 'open';
}

export function buildSuggestions(detections: any[], opts: SuggestionOptions = {}): SuggestionGroup[] {
    const { join = true, minConfidence = 0, adoptedIds, geoScore, unexpectedBelow = 0.05, gap = 0.01 } = opts;
    const bySpecies = new Map<string, any[]>();
    for (const d of detections || []) {
        if (!d || !(d.end > d.start) || (d.confidence ?? 0) < minConfidence) continue;
        const k = speciesKey(d);
        if (!k) continue;
        if (!bySpecies.has(k)) bySpecies.set(k, []);
        bySpecies.get(k)!.push(d);
    }
    const groups: SuggestionGroup[] = [];
    for (const [k, list] of bySpecies) {
        list.sort((a, b) => a.start - b.start || a.end - b.end);
        const runs: any[][] = [];
        let runEnd = -Infinity;   // latest end in the current run (kept as it grows: long recordings have very long runs)
        for (const d of list) {
            const last = runs[runs.length - 1];
            if (join && last && d.start <= runEnd + gap) { last.push(d); runEnd = Math.max(runEnd, d.end); }
            else { runs.push([d]); runEnd = d.end; }
        }
        const suggestions = runs.map((w): Suggestion => ({
            key: `${k}|${w[0].start}`,
            species: String(w[0].label ?? w[0].commonName ?? k),
            scientificName: String(w[0].scientificName || ''),
            start: w[0].start,
            end: w.reduce((m, x) => Math.max(m, x.end), -Infinity),
            confidence: w.reduce((m, x) => Math.max(m, x.confidence ?? 0), 0),
            windows: w,
            state: runState(w.map((x) => windowState(x, adoptedIds))),
        }));
        const geo = geoScore?.(k);
        groups.push({
            species: suggestions[0].species,
            scientificName: suggestions[0].scientificName,
            unexpected: geo != null && geo < unexpectedBelow,
            best: Math.max(...suggestions.map((s) => s.confidence)),
            windows: list.length,
            suggestions: suggestions.sort((a, b) => b.confidence - a.confidence || a.start - b.start),
        });
    }
    return groups.sort((a, b) => Number(b.unexpected) - Number(a.unexpected) || b.best - a.best);
}

/** Counts for the panel head ("Reviewed 4 of 11 suggestions (23 windows)"). */
export function reviewProgress(groups: SuggestionGroup[]) {
    let total = 0, reviewed = 0, windows = 0;
    const byState: Record<ReviewState, number> = { open: 0, accepted: 0, rejected: 0, unsure: 0 };
    for (const g of groups) {
        windows += g.windows;
        for (const s of g.suggestions) {
            total += 1;
            byState[s.state] += 1;
            if (s.state !== 'open') reviewed += 1;
        }
    }
    return { total, reviewed, windows, byState };
}

/** Suggestions in review order (panel order), for ‹ › and "next after decision". */
export function reviewOrder(groups: SuggestionGroup[]): Suggestion[] {
    return groups.flatMap((g) => g.suggestions);
}

/** The next open suggestion after `key` (wrapping), or null when none is open. */
export function nextOpen(groups: SuggestionGroup[], key?: string | null): Suggestion | null {
    const order = reviewOrder(groups);
    const i = key ? order.findIndex((s) => s.key === key) : -1;
    for (let n = 1; n <= order.length; n++) {
        const s = order[(i + n + order.length) % order.length];
        if (s.state === 'open') return s;
    }
    return null;
}

/**
 * Detections with `review` set for the windows of a suggestion ('open' clears it).
 * Returns new objects; the caller writes them back. Accepting goes through adoption instead.
 */
export function setReview(s: Suggestion, state: 'open' | 'rejected' | 'unsure'): any[] {
    return s.windows.map((w) => {
        const { review, ...rest } = w;
        return state === 'open' ? rest : { ...rest, review: state };
    });
}

/** Open suggestions of a group at or above / below a threshold (bulk buttons). */
export function openAtLeast(g: SuggestionGroup | SuggestionGroup[], t: number) {
    return (Array.isArray(g) ? g : [g]).flatMap((x) => x.suggestions).filter((s) => s.state === 'open' && s.confidence >= t);
}
export function openBelow(g: SuggestionGroup | SuggestionGroup[], t: number) {
    return (Array.isArray(g) ? g : [g]).flatMap((x) => x.suggestions).filter((s) => s.state === 'open' && s.confidence < t);
}
