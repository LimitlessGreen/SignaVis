// ═══════════════════════════════════════════════════════════════════════
// infrastructure/project/OpfsProjectStore.ts — browser-private project
//
// IProjectStore on the Origin Private File System (all current browsers).
// Layout under the OPFS root:  projects/<name>/project.signavis.json, …
// Writes go through createWritable (swap file, replaced on close()).
// ═══════════════════════════════════════════════════════════════════════

import type { IProjectStore, AudioFileInfo } from '../../domain/project/IProjectStore.ts';
import { isAudioPath, normalizeProjectPath } from '../../domain/project/IProjectStore.ts';
import type { WorkspaceProject } from '../../domain/project/workspaceProject.ts';
import { parseProject, stringifyProject, PROJECT_FILE_NAME } from '../../domain/project/workspaceProject.ts';

type DirHandle = any;

async function walk(dir: DirHandle, prefix: string, out: AudioFileInfo[]) {
    for await (const [name, handle] of dir.entries()) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (handle.kind === 'directory') await walk(handle, path, out);
        else if (isAudioPath(path)) {
            const f = await handle.getFile();
            out.push({ path, size: f.size, lastModified: f.lastModified });
        }
    }
}

export class OpfsProjectStore implements IProjectStore {
    readonly label = 'Browser project';
    readonly capabilities = { writeAudio: true, userVisible: false };
    #root: DirHandle;

    private constructor(root: DirHandle) { this.#root = root; }

    /** Null when OPFS (with createWritable) is unavailable — callers fall back to legacy storage. */
    static async open(name = 'default'): Promise<OpfsProjectStore | null> {
        try {
            const opfs = await (navigator as any).storage?.getDirectory?.();
            if (!opfs) return null;
            const projects = await opfs.getDirectoryHandle('projects', { create: true });
            const root = await projects.getDirectoryHandle(name, { create: true });
            const probe = await root.getFileHandle('.probe', { create: true });
            const writable = typeof probe.createWritable === 'function';
            await root.removeEntry('.probe').catch(() => {});
            if (!writable) return null;
            try { await (navigator as any).storage?.persist?.(); } catch { /* ignore */ }
            return new OpfsProjectStore(root);
        } catch { return null; }
    }

    async #fileHandle(path: string, create: boolean) {
        const parts = normalizeProjectPath(path).split('/');
        let dir = this.#root;
        for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create });
        return dir.getFileHandle(parts[parts.length - 1], { create });
    }

    async #write(path: string, data: ArrayBuffer | string) {
        const fh = await this.#fileHandle(path, true);
        const w = await fh.createWritable();
        await w.write(data);
        await w.close();
    }

    async loadProject(): Promise<WorkspaceProject | null> {
        let file: File;
        try { file = await (await this.#fileHandle(PROJECT_FILE_NAME, false)).getFile(); }
        catch { return null; }
        return parseProject(await file.text());
    }

    async saveProject(project: WorkspaceProject) {
        await this.#write(PROJECT_FILE_NAME, stringifyProject(project));
    }

    async projectModifiedAt() {
        try { return (await (await this.#fileHandle(PROJECT_FILE_NAME, false)).getFile()).lastModified; }
        catch { return null; }
    }

    async listAudio() {
        const out: AudioFileInfo[] = [];
        await walk(this.#root, '', out);
        return out.sort((a, b) => a.path.localeCompare(b.path));
    }

    async readAudio(path: string) {
        try { return await (await this.#fileHandle(path, false)).getFile(); }
        catch { return null; }
    }

    async writeAudio(path: string, data: ArrayBuffer) { await this.#write(path, data); }
    async writeText(path: string, text: string) { await this.#write(path, text); }
}
