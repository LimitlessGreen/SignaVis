// Minimal frontend bridge for the P0-01 Tauri scaffold commands.
// Safe to import in browser builds due to lazy @tauri-apps/api loading.

type InvokeArgs = Record<string, unknown>;

async function invoke<T>(command: string, args?: InvokeArgs): Promise<T> {
    const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
    return tauriInvoke<T>(command, args);
}

export type CreatedProject = {
    id: string;
    name: string;
    createdAt: number;
    updatedAt: number;
};

export type ImportedAsset = {
    id: string;
    kind: string;
    sourcePath: string;
    storagePath: string;
    sizeBytes: number;
    importedAt: number;
};

export type LocalAnalysisJob = {
    id: string;
    projectId: string;
    assetId?: string | null;
    backend: string;
    status: string;
    createdAt: number;
    startedAt: number | null;
    finishedAt: number | null;
    error?: {
        code: string;
        message: string;
        details?: unknown;
    } | null;
    result: {
        message: string;
        detections: Array<unknown>;
    };
};

export async function tauriProjectCreate(name?: string): Promise<CreatedProject> {
    return invoke<CreatedProject>('project_create', {
        args: { name },
    });
}

export async function tauriAssetImportLocal(projectId: string, sourcePath: string): Promise<ImportedAsset> {
    return invoke<ImportedAsset>('asset_import_local', {
        args: {
            projectId,
            sourcePath,
        },
    });
}

export async function tauriAnalysisRunLocal(
    projectId: string,
    assetId?: string,
    backend = 'local',
): Promise<LocalAnalysisJob> {
    return invoke<LocalAnalysisJob>('analysis_run_local', {
        args: {
            projectId,
            assetId,
            backend,
        },
    });
}

export async function tauriReadLocalJob(id: string): Promise<LocalAnalysisJob> {
    return invoke<LocalAnalysisJob>('read_local_job', { id });
}

export async function tauriListLocalJobs(projectId?: string): Promise<LocalAnalysisJob[]> {
    return invoke<LocalAnalysisJob[]>('list_local_jobs', {
        projectId,
    });
}

export async function tauriCancelLocalJob(id: string): Promise<LocalAnalysisJob> {
    return invoke<LocalAnalysisJob>('cancel_local_job', { id });
}
