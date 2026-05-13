// ═══════════════════════════════════════════════════════════════════════
// infrastructure/tauri/TauriCorpusAdapter.ts
// IPC-Bridge für Dataset/Recording-Befehle (Signavis v2 Architektur)
// ═══════════════════════════════════════════════════════════════════════

import type {
    Dataset,
    DatasetSummary,
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

// ── Dataset-Operationen ───────────────────────────────────────────────

export async function datasetCreate(
    name: string,
    description?: string,
): Promise<Dataset> {
    return invoke<Dataset>('dataset_create', { args: { name, description } });
}

export async function datasetList(): Promise<Dataset[]> {
    return invoke<Dataset[]>('dataset_list');
}

export async function datasetGet(id: string): Promise<Dataset> {
    return invoke<Dataset>('dataset_get', { id });
}

export async function datasetDelete(id: string): Promise<void> {
    return invoke<void>('dataset_delete', { id });
}

export async function datasetUpdateMeta(
    id: string,
    name?: string,
    description?: string,
): Promise<Dataset> {
    return invoke<Dataset>('dataset_update_meta', { args: { id, name, description } });
}

// ── Recording-Operationen ─────────────────────────────────────────────

export interface RecordingListArgs {
    datasetId: string;
    limit?: number;
    offset?: number;
}

export async function recordingImportFolder(
    config: FolderImportConfig,
): Promise<ImportResult> {
    return invoke<ImportResult>('recording_import_folder', {
        args: {
            datasetId: config.datasetId,
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

export async function recordingCount(datasetId: string): Promise<number> {
    return invoke<number>('recording_count', { datasetId });
}

/**
 * Gibt alle distinkten Werte eines Pfad-Felds in einem Dataset zurück.
 * Für Dropdown-Filter in der Galerie-Toolbar.
 */
export async function recordingDistinctValues(
    datasetId: string,
    fieldName: string,
): Promise<string[]> {
    return invoke<string[]>('recording_distinct_values', { datasetId, fieldName });
}

// ── BirdNET-Inferenz ──────────────────────────────────────────────────

export interface BirdnetRunArgs {
    datasetId: string;
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
    datasetId: string;
    fieldName: string;
    processed: number;
    errors: number;
    skipped: number;
}

export async function datasetRunBirdnet(args: BirdnetRunArgs): Promise<BirdnetRunSummary> {
    return invoke<BirdnetRunSummary>('dataset_run_birdnet', { args });
}

// ── Dataset-Schema ─────────────────────────────────────────────────────

export interface DatasetAddFieldArgs {
    datasetId: string;
    fieldName: string;
    fieldKind: string;
    description?: string;
    group?: string;
}

export async function datasetAddFieldToSchema(args: DatasetAddFieldArgs): Promise<Dataset> {
    return invoke<Dataset>('dataset_add_field_to_schema', { args });
}
