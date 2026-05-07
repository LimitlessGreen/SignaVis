// ═══════════════════════════════════════════════════════════════════════
// events.ts — TypeScript interface declarations for all CustomEvent details
//
// Single source of truth for event contracts across AudioEngine,
// SpectrogramController, PlayerState and BirdNETPlayer.
// ═══════════════════════════════════════════════════════════════════════

// ── Transport state ─────────────────────────────────────────────────

export type TransportState =
    | 'idle' | 'loading' | 'ready' | 'rendering'
    | 'playing' | 'playing_loop' | 'playing_segment'
    | 'paused' | 'paused_segment' | 'stopped' | 'error';

export interface TransportStateChangeDetail {
    state: TransportState;
    reason: string;
}

// ── AudioEngine events ───────────────────────────────────────────────

export interface AudioEngineReadyDetail {
    duration: number;
    sampleRate: number;
}

export interface AudioEngineUiUpdateDetail {
    time: number;
    fromPlayback: boolean;
    centerView?: boolean;
    emitSeek?: boolean;
    immediate?: boolean;
}

export interface AudioEngineTimeUpdateDetail {
    currentTime: number;
    duration: number;
}

export interface AudioEngineSegmentStartDetail {
    start: number;
    end: number;
    loop?: boolean;
    filter?: { type: 'bandpass'; freqMinHz: number; freqMaxHz: number };
}

export interface AudioEngineSegmentEndDetail {
    end: number;
}

export interface AudioEngineSegmentLoopDetail {
    start: number;
    end: number;
    filter: string;
}

// ── SpectrogramController events ────────────────────────────────────

export interface SpectrogramReadyDetail {
    duration: number;
    sampleRate: number;
    nFrames: number;
    nMels: number;
    fromCache?: boolean;
    external?: boolean;
    externalImage?: boolean;
    freqRange?: number[] | null;
    freqScale?: string | null;
}

export interface SpectrogramProgressDetail {
    chunk: number;
    totalChunks: number;
    percent: number;
}

export interface SpectrogramComputeTimeDetail {
    durationMs: number;
}

export interface SpectrogramScaleChangeDetail {
    maxFreq: number;
}

export interface SpectrogramErrorDetail {
    message: string;
    source: string;
}

// ── PlayerState events ───────────────────────────────────────────────

export interface PlayerSeekDetail {
    time: number;
    fromPlayback: boolean;
}

export interface PlayerZoomChangeDetail {
    pixelsPerSecond: number;
}

export interface PlayerSelectionDetail {
    start: number;
    end: number;
}

export interface PlayerViewResizeDetail {
    waveformHeight: number;
    spectrogramHeight: number;
}

export interface PlayerFollowModeChangeDetail {
    mode: string;
}

export interface PlayerSegmentPlayEndDetail {
    end: number;
}

export interface PlayerTransportTransitionBlockedDetail {
    from: string;
    to: string;
    reason: string;
}

export interface PlayerErrorDetail {
    message: string;
    source: string;
}

// ── BirdNETPlayer domain events ──────────────────────────────────────

export interface PlayerReadyDetail {
    phase: string;
}

export interface LabelFocusDetail {
    id: string | null;
    source: string;
    interaction: string;
}

export interface UndoChangeDetail {
    canUndo: boolean;
    canRedo: boolean;
}

export interface TaxonomyEntry {
    name: string;
    color: string;
    shortcut: string;
}

export interface LabelTaxonomyApplyDetail {
    id: string;
    taxonomy: TaxonomyEntry;
}

export interface SpeciesBarItem {
    name: string;
    color: string;
    scientificName: string;
}

export interface SpeciesBarChangeDetail {
    selection: SpeciesBarItem | null;
}

export interface StampModeChangeDetail {
    active: boolean;
}

// ── Annotation / label domain events ────────────────────────────────

import type { AnnotationEntry, SpectrogramLabelEntry } from './label.types.ts';
export type { AnnotationEntry, SpectrogramLabelEntry };

export interface AnnotationEventDetail {
    annotation: AnnotationEntry;
}

export interface SpectrogramLabelEventDetail {
    label: SpectrogramLabelEntry;
}
