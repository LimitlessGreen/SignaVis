// ═══════════════════════════════════════════════════════════════════════
// infrastructure/project/DirectoryProjectStore.ts — IProjectStore on a
// FileSystemDirectoryHandle (OPFS directory or a user-picked folder).
//
// Writes go through createWritable (swap file, replaced on close()).
// With `guardConflicts`, saveProject refuses to overwrite a project file
// that was changed outside this tab since it was last read or written.
// ═══════════════════════════════════════════════════════════════════════

import type { IProjectStore, AudioFileInfo, ProjectStoreCapabilities } from '../../domain/project/IProjectStore.ts';
import { isAudioPath, normalizeProjectPath } from '../../domain/project/IProjectStore.ts';
import type { WorkspaceProject } from '../../domain/project/workspaceProject.ts';
import { parseProject, stringifyProject, PROJECT_FILE_NAME } from '../../domain/project/workspaceProject.ts';

export type DirHandle = any;

/** Thrown by saveProject when the project file changed on disk (another program / device). */
export class ProjectConflictError extends Error {
    constructor() { super('The project file was changed outside this tab.'); }
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.signavis-trash']);

async function walk(dir: DirHandle, prefix: string, out: AudioFileInfo[], depth: number) {
    if (depth > 8) return;
    for await (const [name, handle] of dir.entries()) {
        if (name.startsWith('.') && handle.kind === 'directory') continue;
        const path = prefix ? `${prefix}/${name}` : name;
        if (handle.kind === 'directory') {
            if (!SKIP_DIRS.has(name)) await walk(handle, path, out, depth + 1);
        } else if (isAudioPath(path)) {
            const f = await handle.getFile();
            out.push({ path, size: f.size, lastModified: f.lastModified });
        }
    }
}

export class DirectoryProjectStore implements IProjectStore {
    readonly label: string;
    readonly capabilities: ProjectStoreCapabilities;
    readonly root: DirHandle;
    #guard: boolean;
    #knownModified: number | null = null;

    constructor(root: DirHandle, { label, userVisible, guardConflicts = false }:
        { label: string; userVisible: boolean; guardConflicts?: boolean }) {
        this.root = root;
        this.label = label;
        this.capabilities = { writeAudio: true, userVisible };
        this.#guard = guardConflicts;
    }

    async #fileHandle(path: string, create: boolean) {
        const parts = normalizeProjectPath(path).split('/');
        let dir = this.root;
        for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create });
        return dir.getFileHandle(parts[parts.length - 1], { create });
    }

    async #write(path: string, data: ArrayBuffer | string) {
        const fh = await this.#fileHandle(path, true);
        const w = await fh.createWritable();
        await w.write(data);
        await w.close();
        return fh;
    }

    async loadProject(): Promise<WorkspaceProject | null> {
        let file: File;
        try { file = await (await this.#fileHandle(PROJECT_FILE_NAME, false)).getFile(); }
        catch { this.#knownModified = null; return null; }
        this.#knownModified = file.lastModified;
        return parseProject(await file.text());
    }

    async saveProject(project: WorkspaceProject) {
        if (this.#guard) {
            const current = await this.projectModifiedAt();
            if (current !== null && current !== this.#knownModified) throw new ProjectConflictError();
        }
        const fh = await this.#write(PROJECT_FILE_NAME, stringifyProject(project));
        try { this.#knownModified = (await fh.getFile()).lastModified; } catch { /* ignore */ }
    }

    /** Accept the file on disk as known (user chose "overwrite"). */
    async acceptExternalChange() {
        this.#knownModified = await this.projectModifiedAt();
    }

    async projectModifiedAt() {
        try { return (await (await this.#fileHandle(PROJECT_FILE_NAME, false)).getFile()).lastModified; }
        catch { return null; }
    }

    async listAudio() {
        const out: AudioFileInfo[] = [];
        await walk(this.root, '', out, 0);
        return out.sort((a, b) => a.path.localeCompare(b.path));
    }

    async readAudio(path: string) {
        try { return await (await this.#fileHandle(path, false)).getFile(); }
        catch { return null; }
    }

    async writeAudio(path: string, data: ArrayBuffer) { await this.#write(path, data); }
    async writeText(path: string, text: string) { await this.#write(path, text); }
}
