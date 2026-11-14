// ═══════════════════════════════════════════════════════════════════════
// infrastructure/project/NativeProjectStore.ts — IProjectStore on a real
// folder through the SignaVis Lite shell (src-tauri-lite/src/project_fs.rs).
//
// Same behaviour as DirectoryProjectStore (atomic writes, conflict guard),
// but addressed by an absolute path instead of a FileSystemDirectoryHandle,
// so it works in every webview and needs no permission prompts.
// ═══════════════════════════════════════════════════════════════════════

import type { IProjectStore, AudioFileInfo, ProjectStoreCapabilities } from '../../domain/project/IProjectStore.ts';
import { normalizeProjectPath } from '../../domain/project/IProjectStore.ts';
import type { WorkspaceProject } from '../../domain/project/workspaceProject.ts';
import { parseProject, stringifyProject, PROJECT_FILE_NAME } from '../../domain/project/workspaceProject.ts';
import { ProjectConflictError } from './DirectoryProjectStore.ts';

type Invoke = <T>(cmd: string, args?: unknown, options?: { headers: Record<string, string> }) => Promise<T>;

interface FileInfo { path: string; size: number; lastModified: number }

async function tauriInvoke(): Promise<Invoke> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke as Invoke;
}

const MIME: Record<string, string> = {
    wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg',
    opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', webm: 'audio/webm',
};

/** Last path segment of an absolute OS path (either separator). */
export function folderName(path: string): string {
    return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

export class NativeProjectStore implements IProjectStore {
    readonly label: string;
    readonly capabilities: ProjectStoreCapabilities = { writeAudio: true, userVisible: true };
    readonly rootPath: string;
    #guard: boolean;
    #knownModified: number | null = null;
    #invoke: Promise<Invoke>;

    constructor(rootPath: string, { label, guardConflicts = false, invoke }:
        { label?: string; guardConflicts?: boolean; invoke?: Invoke } = {}) {
        this.rootPath = rootPath;
        this.label = label ?? folderName(rootPath);
        this.#guard = guardConflicts;
        this.#invoke = invoke ? Promise.resolve(invoke) : tauriInvoke();
    }

    async #call<T>(cmd: string, args?: unknown, options?: { headers: Record<string, string> }) {
        return (await this.#invoke)<T>(cmd, args, options);
    }

    async #stat(path: string) {
        return this.#call<FileInfo | null>('project_stat', { root: this.rootPath, path: normalizeProjectPath(path) });
    }

    /** File bytes, or null when the file does not exist. */
    async #read(path: string): Promise<ArrayBuffer | null> {
        try {
            return await this.#call<ArrayBuffer>('project_read', { root: this.rootPath, path: normalizeProjectPath(path) });
        } catch (e) {
            if (String(e) === 'not-found') return null;
            throw e;
        }
    }

    async #write(path: string, data: ArrayBuffer | string) {
        const body = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
        await this.#call('project_write', body, {
            headers: { 'x-root': encodeURIComponent(this.rootPath), 'x-path': encodeURIComponent(normalizeProjectPath(path)) },
        });
    }

    async loadProject(): Promise<WorkspaceProject | null> {
        const stat = await this.#stat(PROJECT_FILE_NAME);
        const bytes = stat ? await this.#read(PROJECT_FILE_NAME) : null;
        if (!stat || !bytes) { this.#knownModified = null; return null; }
        this.#knownModified = stat.lastModified;
        return parseProject(new TextDecoder().decode(bytes));
    }

    async saveProject(project: WorkspaceProject) {
        if (this.#guard) {
            const current = await this.projectModifiedAt();
            if (current !== null && current !== this.#knownModified) throw new ProjectConflictError();
        }
        await this.#write(PROJECT_FILE_NAME, stringifyProject(project));
        this.#knownModified = await this.projectModifiedAt();
    }

    /** Accept the file on disk as known (user chose "overwrite"). */
    async acceptExternalChange() {
        this.#knownModified = await this.projectModifiedAt();
    }

    async projectModifiedAt() {
        return (await this.#stat(PROJECT_FILE_NAME))?.lastModified ?? null;
    }

    async listAudio(): Promise<AudioFileInfo[]> {
        return this.#call<AudioFileInfo[]>('project_list_audio', { root: this.rootPath });
    }

    async readAudio(path: string): Promise<File | null> {
        const stat = await this.#stat(path);
        if (!stat) return null;
        const bytes = await this.#read(path);
        if (!bytes) return null;
        const name = path.split('/').pop() || path;
        const ext = name.split('.').pop()?.toLowerCase() || '';
        return new File([bytes], name, { type: MIME[ext] || '', lastModified: stat.lastModified });
    }

    async writeAudio(path: string, data: ArrayBuffer) { await this.#write(path, data); }
    async writeText(path: string, text: string) { await this.#write(path, text); }
}

/** The Lite default project: <app data>/projects/default. */
export async function openDefaultNativeStore(invoke?: Invoke): Promise<NativeProjectStore> {
    const call = invoke ?? await tauriInvoke();
    const dir = await call<string>('default_project_dir');
    return new NativeProjectStore(dir, { label: 'Default project', invoke: call });
}
