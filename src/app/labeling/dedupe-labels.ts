// Remove duplicate labels while preserving order. Keys by `id` when present,
// otherwise by setId/start/end/scientificName.

interface LabelKeyFields { id?: string | number | null; setId?: string | null; start?: number; end?: number; scientificName?: string }

export function dedupeLabels<T extends LabelKeyFields>(labels: readonly T[] | null | undefined): T[] {
    if (!Array.isArray(labels)) return [];
    const seen = new Set<unknown>();
    const out: T[] = [];
    for (const l of labels) {
        const key = l && (l.id || `${l.setId || ''}:${l.start || ''}:${l.end || ''}:${l.scientificName || ''}`);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(l);
    }
    return out;
}
