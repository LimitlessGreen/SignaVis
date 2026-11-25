// Similar panel (Lite, Annotate v2): pick hits in the tile grid and keep them as labels.
// "✓ present" makes a time-only label of the template species in each hit's window,
// "✕ absent" the same with polarity 'absent'. Pure functions; the app writes the labels.

export interface HitWindow { path: string; start: number; end: number; score: number }
export interface Template { name: string; scientificName?: string; color?: string; tags?: Record<string, unknown> }
export interface Selection { sel: Set<number>; anchor: number }

/**
 * Click on tile `i`: plain = toggle it (and make it the anchor), Shift = add the range from the anchor,
 * Ctrl = toggle too (kept for muscle memory from lists).
 */
export function clickTile(s: Selection, i: number, mod: { shift?: boolean } = {}): Selection {
    const sel = new Set(s.sel);
    if (mod.shift && s.anchor >= 0) {
        const [a, b] = s.anchor < i ? [s.anchor, i] : [i, s.anchor];
        for (let k = a; k <= b; k++) sel.add(k);
        return { sel, anchor: s.anchor };
    }
    if (sel.has(i)) sel.delete(i); else sel.add(i);
    return { sel, anchor: i };
}

/** Overlap of two time spans in seconds. */
const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) =>
    Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

/** An existing label already says this (same species, same presence, covers most of the hit). */
export function alreadyMarked(h: HitWindow, sci: string, name: string, polarity: 'present' | 'absent', existing: any[]): boolean {
    return existing.some((l) => (l.scientificName ? l.scientificName === sci : l.label === name)
        && ((l.polarity === 'absent') === (polarity === 'absent'))
        && overlap(l, h) >= 0.5 * (h.end - h.start));
}

/**
 * Labels per recording path for the picked hits. `existing(path)` returns that recording's labels
 * (hits already marked the same way are skipped). `id()` makes label ids.
 */
export function hitLabels(hits: HitWindow[], tpl: Template, polarity: 'present' | 'absent', o: {
    setId: string; layer?: string; now?: Date; id: () => string; existing: (path: string) => any[]; query?: { path: string; start: number } | null;
}): Map<string, any[]> {
    const out = new Map<string, any[]>();
    const sci = tpl.scientificName || '';
    for (const h of hits) {
        const have = [...o.existing(h.path), ...(out.get(h.path) || [])];
        if (alreadyMarked(h, sci, tpl.name, polarity, have)) continue;
        const l = {
            id: o.id(), start: h.start, end: h.end, label: tpl.name, scientificName: sci,
            ...(tpl.color ? { color: tpl.color } : {}),
            ...(tpl.tags && Object.keys(tpl.tags).length ? { tags: { ...tpl.tags } } : {}),
            origin: 'manual', setId: o.setId, readonly: false, fullBand: true,
            ...(o.layer ? { layer: o.layer } : {}),
            ...(polarity === 'absent' ? { polarity: 'absent' } : {}),
            createdAt: (o.now ?? new Date()).toISOString(),
            adoptedFrom: { id: null, setId: null, origin: 'Similar', similar: { score: h.score, ...(o.query ? { query: { ...o.query } } : {}) } },
        };
        out.set(h.path, [...(out.get(h.path) || []), l]);
    }
    return out;
}
