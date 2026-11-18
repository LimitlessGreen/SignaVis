// Remove duplicate labels while preserving order. Keys by `id` when present (0 included),
// otherwise by setId/start/end/scientificName. Empty entries are dropped.

interface LabelKeyFields { id?: string | number | null; setId?: string | null; start?: number; end?: number; scientificName?: string }

export function dedupeLabels<T extends LabelKeyFields>(labels: readonly T[] | null | undefined): T[] {
    if (!Array.isArray(labels)) return [];
    const seen = new Set<unknown>();
    const out: T[] = [];
    for (const l of labels) {
        if (!l) continue;
        // id 0 is an id; only a missing or empty id falls back to the composite key
        const key = l.id != null && l.id !== '' ? `id:${l.id}` : `${l.setId || ''}:${l.start ?? ''}:${l.end ?? ''}:${l.scientificName || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(l);
    }
    return out;
}
