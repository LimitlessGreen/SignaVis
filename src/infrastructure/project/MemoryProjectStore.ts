// infrastructure/project/MemoryProjectStore.ts — IProjectStore in memory (tests, fallback)

import type { IProjectStore, AudioFileInfo } from '../../domain/project/IProjectStore.ts';
import { isAudioPath, normalizeProjectPath } from '../../domain/project/IProjectStore.ts';
import type { WorkspaceProject } from '../../domain/project/workspaceProject.ts';
import { parseProject, stringifyProject, PROJECT_FILE_NAME } from '../../domain/project/workspaceProject.ts';

export class MemoryProjectStore implements IProjectStore {
    readonly label: string;
    readonly capabilities = { writeAudio: true, userVisible: false };
    readonly files = new Map<string, { data: ArrayBuffer | string; lastModified: number }>();
    #now: () => number;

    constructor(label = 'Memory project', { now = () => Date.now() } = {}) {
        this.label = label;
        this.#now = now;
    }

    async loadProject(): Promise<WorkspaceProject | null> {
        const f = this.files.get(PROJECT_FILE_NAME);
        return f ? parseProject(String(f.data)) : null;
    }

    async saveProject(project: WorkspaceProject) {
        this.files.set(PROJECT_FILE_NAME, { data: stringifyProject(project), lastModified: this.#now() });
    }

    async projectModifiedAt() {
        return this.files.get(PROJECT_FILE_NAME)?.lastModified ?? null;
    }

    async listAudio(): Promise<AudioFileInfo[]> {
        return [...this.files.entries()]
            .filter(([p]) => isAudioPath(p))
            .map(([path, f]) => ({
                path,
                size: typeof f.data === 'string' ? f.data.length : f.data.byteLength,
                lastModified: f.lastModified,
            }))
            .sort((a, b) => a.path.localeCompare(b.path));
    }

    async readAudio(path: string) {
        const p = normalizeProjectPath(path);
        const f = this.files.get(p);
        if (!f || typeof f.data === 'string') return null;
        return new File([f.data.slice(0)], p.split('/').pop()!, { lastModified: f.lastModified });
    }

    async writeAudio(path: string, data: ArrayBuffer) {
        this.files.set(normalizeProjectPath(path), { data: data.slice(0), lastModified: this.#now() });
    }

    async writeText(path: string, text: string) {
        this.files.set(normalizeProjectPath(path), { data: text, lastModified: this.#now() });
    }
}
