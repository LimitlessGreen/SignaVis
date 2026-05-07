// ═══════════════════════════════════════════════════════════════════════
// shared/labelNormalize.ts — String-field normalisation for labels
// ═══════════════════════════════════════════════════════════════════════

import type { LabelCore } from './label.types.ts';

/**
 * Normalise the string metadata fields shared by all label variants.
 *
 * - Coerces each field to string, trims whitespace, falls back to ''
 * - `tags` is defensively shallow-copied; non-object values become {}
 * - `label` falls back to `species` when both are provided (BirdNET convention)
 * - `color` is preserved as-is; callers must supply a fallback color if needed
 */
export function normalizeLabelStrings(
    raw: Partial<Pick<LabelCore, 'label' | 'species' | 'color' | 'scientificName' | 'commonName' | 'origin' | 'author' | 'tags'>>,
): Required<Pick<LabelCore, 'label' | 'species' | 'color' | 'scientificName' | 'commonName' | 'origin' | 'author' | 'tags'>> {
    return {
        label:          String(raw?.label   || raw?.species || '').trim(),
        species:        String(raw?.species || '').trim(),
        color:          String(raw?.color   || '').trim(),
        scientificName: String(raw?.scientificName || '').trim(),
        commonName:     String(raw?.commonName     || '').trim(),
        origin:         String(raw?.origin         || '').trim(),
        author:         String(raw?.author         || '').trim(),
        tags:           (raw?.tags && typeof raw.tags === 'object') ? { ...raw.tags } : {},
    };
}
