// Remove duplicate labels while preserving order. Keys by `id` when present (0 included),
// otherwise by setId/start/end/scientificName. Empty entries are dropped.

interface LabelKeyFields { id?: string | number | null; setId?: string | null; start?: number; end?: number; scientificName?: string }

/** Identity of a label for de-duplication. Id keys and composite keys can never collide. */
export function labelKey(l: LabelKeyFields): string {
    if (l.id != null && l.id !== '') return `id:${l.id}`;
    return `k:${JSON.stringify([l.setId ?? null, l.start ?? null, l.end ?? null, l.scientificName ?? null])}`;
}

/** Items whose label (via `labelOf`) was not seen before, in order. */
export function dedupeBy<T>(items: readonly T[] | null | undefined, labelOf: (item: T) => LabelKeyFields | null | undefined): T[] {
    if (!Array.isArray(items)) return [];
    const seen = new Set<string>();
    const out: T[] = [];
    for (const item of items) {
        const l = labelOf(item);
        if (!l) continue;
        const key = labelKey(l);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}

export function dedupeLabels<T extends LabelKeyFields>(labels: readonly T[] | null | undefined): T[] {
    return dedupeBy(labels, (l) => l);
}
