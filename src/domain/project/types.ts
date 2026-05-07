// ═══════════════════════════════════════════════════════════════════════
// domain/project/types.ts — Project domain model
//
// A Project captures everything needed to restore a labeling session:
//   • audio source reference (file path, URL, or embedded blob handle)
//   • all annotations (waveform regions + spectrogram labels)
//   • viewport and DSP settings snapshot
// ═══════════════════════════════════════════════════════════════════════

import type { AnnotationRegion, SpectrogramLabel } from '../annotations.ts';

// ── Audio source ─────────────────────────────────────────────────────

export type AudioSourceRef =
    | { type: 'file'; name: string; size?: number }
    | { type: 'url'; url: string; name?: string }
    | { type: 'xeno-canto'; xcId: string; name?: string };

// ── Project ──────────────────────────────────────────────────────────

export interface Project {
    /** Stable unique identifier (UUID). */
    id: string;
    /** Human-readable display name. */
    name: string;
    createdAt: number;
    updatedAt: number;

    /** Reference to the audio source. */
    audioSource: AudioSourceRef;

    /** Waveform time-range annotations. */
    annotations: AnnotationRegion[];

    /** Spectrogram time-frequency labels. */
    labels: SpectrogramLabel[];

    /**
     * Opaque settings bag for viewport config, DSP preset name, zoom level, etc.
     * Consumers should merge this defensively — unknown keys are silently ignored.
     */
    settings?: Record<string, unknown>;
}

// ── Lightweight summary (for list views) ─────────────────────────────

export interface ProjectSummary {
    id: string;
    name: string;
    createdAt: number;
    updatedAt: number;
    audioSource: AudioSourceRef;
    labelCount: number;
    annotationCount: number;
}

export function summarize(project: Project): ProjectSummary {
    return {
        id:              project.id,
        name:            project.name,
        createdAt:       project.createdAt,
        updatedAt:       project.updatedAt,
        audioSource:     project.audioSource,
        labelCount:      project.labels.length,
        annotationCount: project.annotations.length,
    };
}
