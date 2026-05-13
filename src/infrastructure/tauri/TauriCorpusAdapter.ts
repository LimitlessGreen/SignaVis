// ═══════════════════════════════════════════════════════════════════════
// infrastructure/tauri/TauriCorpusAdapter.ts
// IPC-Bridge für Corpus/Recording-Befehle (Signavis v2 Architektur)
// ═══════════════════════════════════════════════════════════════════════

import type {
    Corpus,
    CorpusSummary,
    Recording,
    RecordingSummary,
    FolderImportConfig,
} from '../../domain/corpus/types.ts';

type InvokeArgs = Record<string, unknown>;

async function invoke<T>(command: string, args?: InvokeArgs): Promise<T> {
    const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
    return tauriInvoke<T>(command, args);
}

// ── Typen (spiegeln Rust-Structs) ─────────────────────────────────────

export interface ImportResult {
    imported: number;
    skipped: number;
    errors: number;
    errorMessages: string[];
    durationMs: number;
}

// ── Corpus-Operationen ────────────────────────────────────────────────

export async function corpusCreate(
    name: string,
    description?: string,
): Promise<Corpus> {
    return invoke<Corpus>('corpus_create', { args: { name, description } });
}

export async function corpusList(): Promise<Corpus[]> {
    return invoke<Corpus[]>('corpus_list');
}

export async function corpusGet(id: string): Promise<Corpus> {
    return invoke<Corpus>('corpus_get', { id });
}

export async function corpusDelete(id: string): Promise<void> {
    return invoke<void>('corpus_delete', { id });
}

export async function corpusUpdateMeta(
    id: string,
    name?: string,
    description?: string,
): Promise<Corpus> {
    return invoke<Corpus>('corpus_update_meta', { args: { id, name, description } });
}

// ── Recording-Operationen ─────────────────────────────────────────────

export interface RecordingListArgs {
    corpusId: string;
    limit?: number;
    offset?: number;
}

export async function recordingImportFolder(
    config: FolderImportConfig,
): Promise<ImportResult> {
    return invoke<ImportResult>('recording_import_folder', {
        args: {
            corpusId: config.corpusId,
            folderPath: config.folderPath,
            pathPattern: config.pathPattern,
            skipDuplicates: config.copyFiles === false ? undefined : true,
            extensions: config.extensions,
        },
    });
}

export async function recordingList(args: RecordingListArgs): Promise<Recording[]> {
    return invoke<Recording[]>('recording_list', { args });
}

export async function recordingGet(id: string): Promise<Recording> {
    return invoke<Recording>('recording_get', { id });
}

export async function recordingSetTags(id: string, tags: string[]): Promise<void> {
    return invoke<void>('recording_set_tags', { args: { id, tags } });
}

export async function recordingDelete(id: string): Promise<void> {
    return invoke<void>('recording_delete', { id });
}

export async function recordingCount(corpusId: string): Promise<number> {
    return invoke<number>('recording_count', { corpusId });
}

/**
 * Gibt alle distinkten Werte eines Pfad-Felds in einem Corpus zurück.
 * Für Dropdown-Filter in der Galerie-Toolbar.
 */
export async function recordingDistinctValues(
    corpusId: string,
    fieldName: string,
): Promise<string[]> {
    return invoke<string[]>('recording_distinct_values', { corpusId, fieldName });
}

// ── BirdNET-Inferenz ──────────────────────────────────────────────────

export interface BirdnetRunArgs {
    corpusId: string;
    /** Dynamisches Feld-Name für SoundEvents, z.B. "birdnetV24". */
    fieldName: string;
    minConf?: number;
    lat?: number;
    lon?: number;
    /** Kalenderwoche 1-48. */
    week?: number;
    /** BirdNET-Modellversion, z.B. "2.4". */
    version?: string;
    mergeConsecutive?: number;
    sensitivity?: number;
    /** Nur diese Recording-IDs analysieren. Leer = alle. */
    recordingIds?: string[];
    /** Pfad zum Python-Interpreter. Fallback: SIGNAVIS_PYTHON env → python3. */
    pythonExecutable?: string;
    /** Expliziter Pfad zu birdnet_sidecar.py. */
    sidecarScript?: string;
}

export interface BirdnetRunSummary {
    jobId: string;
    corpusId: string;
    fieldName: string;
    processed: number;
    errors: number;
    skipped: number;
}

export async function corpusRunBirdnet(args: BirdnetRunArgs): Promise<BirdnetRunSummary> {
    return invoke<BirdnetRunSummary>('corpus_run_birdnet', { args });
}

// ── Corpus-Schema ─────────────────────────────────────────────────────

export interface CorpusAddFieldArgs {
    corpusId: string;
    fieldName: string;
    fieldKind: string;
    description?: string;
    group?: string;
}

export async function corpusAddFieldToSchema(args: CorpusAddFieldArgs): Promise<Corpus> {
    return invoke<Corpus>('corpus_add_field_to_schema', { args });
}

