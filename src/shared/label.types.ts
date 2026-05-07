// ═══════════════════════════════════════════════════════════════════════
// shared/label.types.ts — Canonical label type hierarchy
//
// Single source of truth for label data shapes.  All domain types
// (AnnotationRegion, SpectrogramLabel, LinkedLabel, …) are aliases or
// extensions of the base types defined here.
// ═══════════════════════════════════════════════════════════════════════

/** Metadata fields shared by every label variant. */
export interface LabelCore {
    id: string;
    start: number;
    end: number;
    label?: string;
    species?: string;
    color?: string;
    scientificName?: string;
    commonName?: string;
    origin?: string;
    author?: string;
    tags?: Record<string, string>;
}

/** Full spectrogram label — adds frequency bounds and optional AI/provenance fields. */
export interface SpectrogramLabel extends LabelCore {
    freqMin?: number;
    freqMax?: number;
    confidence?: number;
    readonly?: boolean;
    aiSuggested?: { model?: string; version?: string } | null;
    recordingId?: string | null;
}

/**
 * Annotation region — time-only label (no frequency bounds).
 * Kept as a distinct alias so callers that never deal with frequency
 * can express their intent clearly.
 */
export type AnnotationRegion = LabelCore & { confidence?: number };

/**
 * LinkedLabel — external-API label shape; `tags` values may be unknown at
 * ingest time and are normalised to `string` before storage.
 */
export interface LinkedLabel extends Omit<SpectrogramLabel, 'tags'> {
    tags?: Record<string, unknown>;
}

// ── Event-payload aliases ────────────────────────────────────────────────
// These mirror the shapes that CustomEvents carry.  They are strict subsets
// of the domain types above and exist so event consumers don't need to pull
// in the full domain model.

/** Event payload for annotation (time-only) events. */
export type AnnotationEntry = AnnotationRegion;

/** Event payload for spectrogram-label events (without AI provenance fields). */
export type SpectrogramLabelEntry = LabelCore & {
    freqMin?: number;
    freqMax?: number;
};
