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

// In non-Tauri contexts (browser dev/demo mode), delegate to the mock adapter
// so the UI is fully functional without a running desktop backend.
let _mockAdapter: typeof import('./MockCorpusAdapter.ts') | null = null;

async function isMockMode(): Promise<boolean> {
    try {
        await import('@tauri-apps/api/core');
        // If the import succeeds but window.__TAURI__ is absent, we're in browser
        return !(window as unknown as Record<string, unknown>).__TAURI__;
    } catch {
        return true;
    }
}

async function getMock() {
    if (!_mockAdapter) {
        _mockAdapter = await import('./MockCorpusAdapter.ts');
    }
    return _mockAdapter;
}

async function invoke<T>(command: string, args?: InvokeArgs): Promise<T> {
    if (await isMockMode()) {
        // Route to mock adapter by command name
        const m = await getMock();
        const a = (args?.args ?? args ?? {}) as Record<string, unknown>;
        const routes: Record<string, () => Promise<unknown>> = {
            dataset_create:            () => m.datasetCreate(a.name as string, a.description as string),
            dataset_list:              () => m.datasetList(),
            dataset_get:               () => m.datasetGet((args?.id ?? a.id) as string),
            dataset_delete:            () => m.datasetDelete((args?.id ?? a.id) as string),
            dataset_update_meta:       () => m.datasetUpdateMeta(a.id as string, a.name as string, a.description as string),
            dataset_add_field_to_schema: () => m.datasetAddFieldToSchema(a as never),
            dataset_save_view:         () => m.datasetSaveView(a as never),
            dataset_delete_view:       () => m.datasetDeleteView(a.datasetId as string, a.name as string),
            dataset_list_runs:         () => m.datasetListRuns((args?.datasetId ?? a.datasetId) as string),
            dataset_get_run:           () => m.datasetGetRun((args?.datasetId ?? a.datasetId) as string, (args?.jobId ?? a.jobId) as string),
            dataset_run_birdnet:       () => m.datasetRunBirdnet(a as never),
            recording_list:            () => m.recordingList(a as never),
            recording_get:             () => m.recordingGet((args?.id ?? a.id) as string),
            recording_set_tags:        () => m.recordingSetTags(a.id as string, a.tags as string[]),
            recording_delete:          () => m.recordingDelete((args?.id ?? a.id) as string),
            recording_set_field:       () => m.recordingSetField(a.id as string, a.fieldName as string, a.value),
            recording_count:           () => m.recordingCount((args?.datasetId ?? a.datasetId) as string),
            recording_distinct_values: () => m.recordingDistinctValues((args?.datasetId ?? a.datasetId) as string, (args?.fieldName ?? a.fieldName) as string),
            recording_import_folder:   () => m.recordingImportFolder(),
        };
        const handler = routes[command];
        if (handler) return handler() as Promise<T>;
        console.warn(`[MockAdapter] Unhandled command: ${command}`);
        return undefined as unknown as T;
    }
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
    /** When set, only recordings carrying this tag are returned. */
    tagFilter?: string;
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

/** Writes an arbitrary JSON value to a dynamic field on a recording. */
export async function recordingSetField(
    id: string,
    fieldName: string,
    value: unknown,
): Promise<void> {
    return invoke<void>('recording_set_field', { args: { id, fieldName, value } });
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

// ── Saved views ────────────────────────────────────────────────────────

export interface DatasetSaveViewArgs {
    datasetId: string;
    name: string;
    stages: Record<string, unknown>[];
}

/** Upserts a saved view on a dataset (insert or replace by name). Returns updated dataset. */
export async function datasetSaveView(args: DatasetSaveViewArgs): Promise<Dataset> {
    return invoke<Dataset>('dataset_save_view', { args });
}

/** Removes a saved view by name. Returns updated dataset. */
export async function datasetDeleteView(datasetId: string, name: string): Promise<Dataset> {
    return invoke<Dataset>('dataset_delete_view', { args: { datasetId, name } });
}

// ── Analysis run queries ───────────────────────────────────────────────

export interface AnalysisRunRecord {
    key: string;
    runType: string;
    config: Record<string, unknown>;
    status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
    startedAt?: number;
    completedAt?: number;
    processed?: number;
    errors?: number;
    errorMessage?: string;
}

/** Returns all analysis runs for a dataset. */
export async function datasetListRuns(datasetId: string): Promise<AnalysisRunRecord[]> {
    return invoke<AnalysisRunRecord[]>('dataset_list_runs', { datasetId });
}

/** Returns a single analysis run by jobId, or null if not found. */
export async function datasetGetRun(
    datasetId: string,
    jobId: string,
): Promise<AnalysisRunRecord | null> {
    return invoke<AnalysisRunRecord | null>('dataset_get_run', { datasetId, jobId });
}

// ── Event listen helper (works in both Tauri and demo/browser mode) ───

export async function tauriListen<T>(
    event: string,
    handler: (e: { payload: T }) => void,
): Promise<() => void> {
    if (await isMockMode()) {
        const mockListen = (window as unknown as Record<string, unknown>).__SIGNAVIS_MOCK_LISTEN__ as
            ((ev: string, h: (e: { payload: T }) => void) => () => void) | undefined;
        if (mockListen) return mockListen(event, handler);
        // No bridge installed yet — no-op
        return () => { /* no-op */ };
    }
    const { listen } = await import('@tauri-apps/api/event');
    return listen<T>(event, handler);
}

// ── BirdNET done event ─────────────────────────────────────────────────

export interface BirdnetDonePayload {
    jobId: string;
    datasetId: string;
    processed: number;
    errors: number;
    skipped: number;
    status: 'completed' | 'failed';
    errorMessage?: string;
}

// ── Embedding / UMAP / Similarity ──────────────────────────────────────

export interface EmbeddingRunArgs {
    datasetId: string;
    /** Dynamic field name to store embeddings under, e.g. "embedding". */
    fieldName: string;
    /** BirdNET model version, e.g. "2.4". */
    version?: string;
    /** Analyse only these recording IDs. Empty = all. */
    recordingIds?: string[];
    /** Path to the Python interpreter. */
    pythonExecutable?: string;
    /** Explicit path to embedding_sidecar.py. */
    sidecarScript?: string;
}

export interface EmbeddingRunSummary {
    jobId: string;
    datasetId: string;
    fieldName: string;
    processed: number;
    errors: number;
}

export async function datasetRunEmbedding(args: EmbeddingRunArgs): Promise<EmbeddingRunSummary> {
    return invoke<EmbeddingRunSummary>('dataset_run_embedding', { args });
}

export interface DatasetComputeUmapArgs {
    datasetId: string;
    /** Field containing 1-D float-array embeddings. */
    embeddingField: string;
    /** Field to write [x, y] coordinates to. Default "umap2d". */
    outputField?: string;
    nNeighbors?: number;
    minDist?: number;
    randomState?: number;
    /** Path to the Python interpreter. */
    pythonExecutable?: string;
    sidecarScript?: string;
}

export interface UmapSummary {
    jobId: string;
    datasetId: string;
    outputField: string;
    processed: number;
}

export async function datasetComputeUmap(args: DatasetComputeUmapArgs): Promise<UmapSummary> {
    return invoke<UmapSummary>('dataset_compute_umap', { args });
}

export interface DatasetComputeUniquenessArgs {
    datasetId: string;
    embeddingField: string;
    /** Field to write uniqueness score to. Default "uniqueness". */
    outputField?: string;
    /** k nearest neighbours to use. Default 5. */
    k?: number;
}

export interface UniquenessRunSummary {
    datasetId: string;
    processed: number;
    outputField: string;
}

export async function datasetComputeUniqueness(
    args: DatasetComputeUniquenessArgs,
): Promise<UniquenessRunSummary> {
    return invoke<UniquenessRunSummary>('dataset_compute_uniqueness', { args });
}

export interface RecordingGetSimilarArgs {
    recordingId: string;
    datasetId: string;
    embeddingField: string;
    topK?: number;
}

export interface SimilarityResult {
    recordingId: string;
    filepath: string;
    similarity: number;
}

export async function recordingGetSimilar(
    args: RecordingGetSimilarArgs,
): Promise<SimilarityResult[]> {
    return invoke<SimilarityResult[]>('recording_get_similar', { args });
}

// ── Embedding event payloads ───────────────────────────────────────────

export interface EmbeddingProgressPayload {
    jobId: string;
    datasetId: string;
    current: number;
    total: number;
}

export interface EmbeddingDonePayload {
    jobId: string;
    datasetId: string;
    processed: number;
    errors: number;
    status: 'completed' | 'failed';
    errorMessage?: string;
}

export interface UmapDonePayload {
    jobId: string;
    datasetId: string;
    processed: number;
    outputField: string;
    status: 'completed' | 'failed';
    errorMessage?: string;
}

// ── Phase 4: Clustering ────────────────────────────────────────────────

export interface DatasetRunClusteringArgs {
    datasetId: string;
    embeddingField: string;
    outputField?: string;
    probabilityField?: string;
    minClusterSize?: number;
    minSamples?: number;
    pythonExecutable?: string;
    sidecarScript?: string;
}

export interface ClusteringRunSummary {
    jobId: string;
    datasetId: string;
    outputField: string;
    processed: number;
    nClusters: number;
    nNoise: number;
}

export async function datasetRunClustering(
    args: DatasetRunClusteringArgs,
): Promise<ClusteringRunSummary> {
    return invoke<ClusteringRunSummary>('dataset_run_clustering', { args });
}

export interface ClusteringProgressPayload {
    jobId: string;
    datasetId: string;
    message: string;
}

export interface ClusteringDonePayload {
    jobId: string;
    datasetId: string;
    processed: number;
    nClusters: number;
    nNoise: number;
}

// ── Phase 4: Hardness ─────────────────────────────────────────────────

export interface DatasetComputeHardnessArgs {
    datasetId: string;
    fieldName: string;
    outputField?: string;
}

export interface HardnessRunSummary {
    datasetId: string;
    outputField: string;
    processed: number;
}

export async function datasetComputeHardness(
    args: DatasetComputeHardnessArgs,
): Promise<HardnessRunSummary> {
    return invoke<HardnessRunSummary>('dataset_compute_hardness', { args });
}

// ── Visibility ────────────────────────────────────────────────────────

export type DatasetVisibility = 'private' | 'shared' | 'public';

export async function datasetSetVisibility(
    datasetId: string,
    visibility: DatasetVisibility,
): Promise<void> {
    return invoke<void>('dataset_set_visibility', { datasetId, visibility });
}

