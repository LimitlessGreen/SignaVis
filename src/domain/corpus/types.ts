// ═══════════════════════════════════════════════════════════════════════
// domain/corpus/types.ts — Signavis v2 Datenmodell
//
// Kernkonzepte (FiftyOne-inspiriert, bioacoustic-angepasst):
//   Corpus     → Dataset (oberster Behälter)
//   Recording  → Sample (Dokument pro Audiodatei)
//   Field      → Field (typisierte Eigenschaft)
//   Tag        → string-Label für Workflow-Zustände
//   View       → lazy Abfragepipeline (ViewStage-Liste)
//   AnalysisRun→ Compute-Nachverfolgung (Inferenz, Embedding, Clustering)
// ═══════════════════════════════════════════════════════════════════════

// ── Audio-Metadaten ──────────────────────────────────────────────────

export interface AudioMetadata {
    /** Dauer in Sekunden. */
    duration: number;
    /** Abtastrate in Hz. */
    sampleRate: number;
    /** Anzahl Kanäle. */
    numChannels: number;
    /** Dateigröße in Bytes. */
    sizeBytes: number;
    /** MIME-Typ, z. B. "audio/wav". */
    mimeType: string;
}

// ── Annotation-Felder (eingebettete Objekte auf Recording) ───────────

/** Einzelne Artenbestimmung. */
export interface Classification {
    label: string;
    confidence: number;
    logits?: number[];
    tags?: string[];
}

/** Mehrere Artenbestimmungen (Multi-Label). */
export interface Classifications {
    classifications: Classification[];
    tags?: string[];
}

/** Zeitbereich + Artenlabel (BirdNET-Ergebnis / manuelles Segment). */
export interface SoundEvent {
    label: string;
    confidence: number;
    /** [start_s, end_s] */
    support: [number, number];
    /** Frequenzbereich in Hz [low, high] (optional). */
    freqRange?: [number, number];
    tags?: string[];
}

/** Liste von SoundEvents (typisch: BirdNET-Ergebnisse einer Aufnahme). */
export interface SoundEvents {
    soundEvents: SoundEvent[];
    tags?: string[];
}

/** Skalarer Regressions-Wert (z. B. Artenreichtums-Score). */
export interface Regression {
    value: number;
    confidence?: number;
    tags?: string[];
}

// ── Feldtypen ────────────────────────────────────────────────────────

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
    /** Optionale Gruppe für UI-Gliederung (z. B. "BirdNET", "Xeno-Canto", "Benutzerdefiniert"). */
    group?: string;
    /** Wenn true: wird nicht im Schema-Editor angezeigt (intern). */
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
 * Recording ist ein Dokument pro Audiodatei.
 * Bekannte Pflichtfelder sind getypt; alle weiteren dynamischen
 * Felder liegen im `fields`-Dictionary.
 */
export interface Recording {
    /** Eindeutige ID (UUID). */
    id: string;
    /** Zugehöriger Corpus. */
    corpusId: string;
    /** Absoluter Pfad zur Audiodatei. */
    filepath: string;
    /** Workflow-Tags (z. B. "train", "validated", "flagged"). */
    tags: string[];
    /** Automatisch extrahierte Audio-Metadaten. */
    metadata: AudioMetadata;
    /** Geografische Position (optional). */
    location?: GeoLocation;
    /** Aufnahmezeitpunkt (ISO-8601 oder ms-Timestamp). */
    recordedAt?: string | number;
    /** SHA-256-Hash der Datei (für Duplikaterkennung). */
    fileHash?: string;
    /** Zeitpunkt des Imports (ms). */
    importedAt: number;
    /**
     * Dynamische Felder (alle nicht in der Basisstruktur).
     * Enthält z. B. BirdNET-Ergebnisse, Embeddings, Custom-Metadaten.
     */
    fields: Record<string, unknown>;
}

/** Leichtgewichtige Zusammenfassung für Listenansichten. */
export interface RecordingSummary {
    id: string;
    corpusId: string;
    filepath: string;
    tags: string[];
    duration: number;
    importedAt: number;
    recordedAt?: string | number;
    location?: GeoLocation;
}

// ── Corpus ───────────────────────────────────────────────────────────

export interface Corpus {
    /** Eindeutige ID. */
    id: string;
    /** Anzeigename. */
    name: string;
    mediaType: 'audio';
    createdAt: number;
    updatedAt: number;
    /** Anzahl der Recordings (denormalisiert für Listenansicht). */
    recordingCount: number;
    /** Bekanntes Feldschema (wird durch sync_dynamic_fields aktualisiert). */
    fieldSchema: FieldDefinition[];
    /** Gespeicherte Views. */
    savedViews: SavedView[];
    /** Abgeschlossene und laufende Analyse-Runs. */
    analysisRuns: Record<string, AnalysisRunInfo>;
    /** Bekannte Tags (für Auto-Complete). */
    knownTags: string[];
    /** Optionale Beschreibung. */
    description?: string;
}

export interface CorpusSummary {
    id: string;
    name: string;
    mediaType: 'audio';
    createdAt: number;
    updatedAt: number;
    recordingCount: number;
    description?: string;
}

// ── View (Abfragepipeline) ───────────────────────────────────────────

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
    /** Corpus, auf dem der View basiert. */
    corpusId: string;
    /** Geordnete Liste von View-Stages. */
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
    /** Wenn nur auf einem View ausgeführt: gespeicherte View-Stages. */
    viewStages?: ViewStage[];
}

// ── Import-Konfiguration ─────────────────────────────────────────────

export interface FolderImportConfig {
    corpusId: string;
    /** Absoluter Pfad zum Quellordner. */
    folderPath: string;
    /**
     * Ordnerstruktur-Muster für Metadaten-Extraktion.
     * Beispiel: "{recorder_id}/{site}/{week}/"
     * Platzhalter {name} werden zu Feldern auf der Recording.
     */
    pathPattern?: string;
    /** Wenn true: Dateien ins Projektverzeichnis kopieren (Standard: false = Non-destructive). */
    copyFiles?: boolean;
    /** Dateierweiterungen filtern (Standard: alle bekannten Audio-Exts). */
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
    /** Dynamisches Eingabeformular-Schema (JSON Schema). */
    inputSchema?: Record<string, unknown>;
    /** Wenn true: Ausführung ist async und erzeugt einen AnalysisRun. */
    isAsync: boolean;
}
