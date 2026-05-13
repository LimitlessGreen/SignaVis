// ═══════════════════════════════════════════════════════════════════════
// domain/corpus/types.ts — Signavis v2 data model
//
// Core concepts (FiftyOne-inspired, bioacoustic-adapted):
//   Dataset    → Dataset (top-level container)
//   Recording  → Sample (one document per audio file)
//   Field      → Field (typed property)
//   Tag        → string label for workflow states
//   View       → lazy query pipeline (list of ViewStages)
//   AnalysisRun→ compute tracking (inference, embedding, clustering)
// ═══════════════════════════════════════════════════════════════════════

// ── Audio metadata ───────────────────────────────────────────────────

export interface AudioMetadata {
    /** Duration in seconds. */
    duration: number;
    /** Sample rate in Hz. */
    sampleRate: number;
    /** Number of channels. */
    numChannels: number;
    /** File size in bytes. */
    sizeBytes: number;
    /** MIME type, e.g. "audio/wav". */
    mimeType: string;
}

// ── Annotation fields (embedded objects on Recording) ───────────────

/** Single species identification. */
export interface Classification {
    label: string;
    confidence: number;
    logits?: number[];
    tags?: string[];
}

/** Multiple species identifications (multi-label). */
export interface Classifications {
    classifications: Classification[];
    tags?: string[];
}

/** Time range + species label (BirdNET result / manual segment). */
export interface SoundEvent {
    label: string;
    confidence: number;
    /** [start_s, end_s] */
    support: [number, number];
    /** Frequency range in Hz [low, high] (optional). */
    freqRange?: [number, number];
    tags?: string[];
}

/** List of SoundEvents (typically: BirdNET results for a recording). */
export interface SoundEvents {
    soundEvents: SoundEvent[];
    tags?: string[];
}

/** Scalar regression value (e.g. species richness score). */
export interface Regression {
    value: number;
    confidence?: number;
    tags?: string[];
}

// ── Field types ──────────────────────────────────────────────────────

export type FieldKind =
    | 'string'
    | 'int'
    | 'float'
    | 'bool'
    | 'date'
    | 'string_list'
    | 'dict'
    | 'geo_location'
    | 'vector'
    | 'classification'
    | 'classifications'
    | 'sound_event'
    | 'sound_events'
    | 'regression';

export interface FieldDefinition {
    name: string;
    kind: FieldKind;
    description?: string;
    /** Optional group for UI organisation (e.g. "BirdNET", "Xeno-Canto", "Custom"). */
    group?: string;
    /** If true: not shown in the schema editor (internal). */
    system?: boolean;
}

// ── GeoLocation ──────────────────────────────────────────────────────

export interface GeoLocation {
    latitude: number;
    longitude: number;
    altitude?: number;
}

// ── Recording ────────────────────────────────────────────────────────

/**
 * Recording is one document per audio file.
 * Known required fields are typed; all additional dynamic
 * fields live in the `fields` dictionary.
 */
export interface Recording {
    /** Unique ID (UUID). */
    id: string;
    /** Owning dataset. */
    datasetId: string;
    /** Absolute path to the audio file. */
    filepath: string;
    /** Workflow tags (e.g. "train", "validated", "flagged"). */
    tags: string[];
    /** Automatically extracted audio metadata. */
    metadata: AudioMetadata;
    /** Geographic position (optional). */
    location?: GeoLocation;
    /** Recording timestamp (ISO-8601 or ms timestamp). */
    recordedAt?: string | number;
    /** SHA-256 hash of the file (for duplicate detection). */
    fileHash?: string;
    /** Import timestamp (ms). */
    importedAt: number;
    /**
     * Dynamic fields (all fields not in the base structure).
     * Contains e.g. BirdNET results, embeddings, custom metadata.
     */
    fields: Record<string, unknown>;
}

/** Lightweight summary for list views. */
export interface RecordingSummary {
    id: string;
    datasetId: string;
    filepath: string;
    tags: string[];
    duration: number;
    importedAt: number;
    recordedAt?: string | number;
    location?: GeoLocation;
}

// ── Dataset ───────────────────────────────────────────────────────────

export interface Dataset {
    /** Unique ID. */
    id: string;
    /** Display name. */
    name: string;
    mediaType: 'audio';
    createdAt: number;
    updatedAt: number;
    /** Number of recordings (denormalised for list view). */
    recordingCount: number;
    /** Known field schema (updated by sync_dynamic_fields). */
    fieldSchema: FieldDefinition[];
    /** Saved views. */
    savedViews: SavedView[];
    /** Completed and running analysis runs. */
    analysisRuns: Record<string, AnalysisRunInfo>;
    /** Known tags (for auto-complete). */
    knownTags: string[];
    /** Optional description. */
    description?: string;
}

export interface DatasetSummary {
    id: string;
    name: string;
    mediaType: 'audio';
    createdAt: number;
    updatedAt: number;
    recordingCount: number;
    description?: string;
}

// ── View (query pipeline) ────────────────────────────────────────────

export type ViewStageKind =
    | 'match'
    | 'match_tags'
    | 'filter_annotations'
    | 'select_ids'
    | 'exclude_ids'
    | 'sort_by'
    | 'sort_by_similarity'
    | 'limit'
    | 'skip'
    | 'to_clips'
    | 'geo_near';

export interface ViewStage {
    kind: ViewStageKind;
    params: Record<string, unknown>;
}

export interface View {
    /** Dataset this view is based on. */
    datasetId: string;
    /** Ordered list of view stages. */
    stages: ViewStage[];
}

export interface SavedView {
    name: string;
    stages: ViewStage[];
    createdAt: number;
}

// ── AnalysisRun ──────────────────────────────────────────────────────

export type AnalysisRunType =
    | 'inference'
    | 'embedding'
    | 'similarity'
    | 'visualization'
    | 'clustering'
    | 'uniqueness'
    | 'hardness'
    | 'import'
    | 'export'
    | 'training';

export type AnalysisRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface AnalysisRunConfig {
    model?: string;
    version?: string;
    outputField?: string;
    [key: string]: unknown;
}

export interface AnalysisRunInfo {
    key: string;
    type: AnalysisRunType;
    config: AnalysisRunConfig;
    status: AnalysisRunStatus;
    startedAt?: number;
    completedAt?: number;
    processed?: number;
    errors?: number;
    /** If run on a view only: stored view stages. */
    viewStages?: ViewStage[];
}

// ── Import configuration ──────────────────────────────────────────────

export interface FolderImportConfig {
    datasetId: string;
    /** Absolute path to the source folder. */
    folderPath: string;
    /**
     * Folder-structure pattern for metadata extraction.
     * Example: "{recorder_id}/{site}/{week}/"
     * Placeholders {name} become fields on the recording.
     */
    pathPattern?: string;
    /** If true: copy files into the project directory (default: false = non-destructive). */
    copyFiles?: boolean;
    /** Filter by file extensions (default: all known audio extensions). */
    extensions?: string[];
}

export interface FolderImportProgress {
    total: number;
    processed: number;
    imported: number;
    skipped: number;
    errors: number;
    status: 'scanning' | 'importing' | 'done' | 'failed';
    currentFile?: string;
    errorMessages?: string[];
}

// ── Operator ─────────────────────────────────────────────────────────

export type OperatorCategory =
    | 'analysis'
    | 'labeling'
    | 'export'
    | 'import'
    | 'maintenance';

export interface OperatorDefinition {
    id: string;
    name: string;
    description: string;
    category: OperatorCategory;
    /** Dynamic input form schema (JSON Schema). */
    inputSchema?: Record<string, unknown>;
    /** If true: execution is async and creates an AnalysisRun. */
    isAsync: boolean;
}
