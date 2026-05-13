// ═══════════════════════════════════════════════════════════════════════
// infrastructure/tauri/TauriCorpusAdapter.ts
// IPC bridge for Dataset/Recording commands (Signavis v2 architecture)
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

// ── Types (mirror Rust structs) ───────────────────────────────────────

export interface ImportResult {
    imported: number;
    skipped: number;
    errors: number;
    errorMessages: string[];
    durationMs: number;
}

// ── Dataset operations ────────────────────────────────────────────────

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

// ── Recording operations ──────────────────────────────────────────────

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
 * Returns all distinct values of a path field within a dataset.
 * Used for dropdown filters in the gallery toolbar.
 */
export async function recordingDistinctValues(
    datasetId: string,
    fieldName: string,
): Promise<string[]> {
    return invoke<string[]>('recording_distinct_values', { datasetId, fieldName });
}

// ── BirdNET inference ─────────────────────────────────────────────────

export interface BirdnetRunArgs {
    datasetId: string;
    /** Dynamic field name for SoundEvents, e.g. "birdnetV24". */
    fieldName: string;
    minConf?: number;
    lat?: number;
    lon?: number;
    /** Calendar week 1-48. */
    week?: number;
    /** BirdNET model version, e.g. "2.4". */
    version?: string;
    mergeConsecutive?: number;
    sensitivity?: number;
    /** Analyse only these recording IDs. Empty = all. */
    recordingIds?: string[];
    /** Path to the Python interpreter. Fallback: SIGNAVIS_PYTHON env → python3. */
    pythonExecutable?: string;
    /** Explicit path to birdnet_sidecar.py. */
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

// ── Dataset schema ─────────────────────────────────────────────────────

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
