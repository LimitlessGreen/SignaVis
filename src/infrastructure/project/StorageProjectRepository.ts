// ═══════════════════════════════════════════════════════════════════════
// infrastructure/project/StorageProjectRepository.ts
//
// IProjectRepository adapter backed by IStorage (sync key-value store).
//
// Storage layout:
//   aw-project:<id>       → JSON-serialized Project
//   aw-project-index      → JSON array of project ids
//
// Works with any IStorage implementation:
//   • LocalStorageAdapter   → browser localStorage (limited to ~5 MB)
//   • InMemoryStorageAdapter → unit tests
//   • Future: TauriStorageAdapter → native filesystem or SQLite
// ═══════════════════════════════════════════════════════════════════════

import type { IProjectRepository } from '../../domain/project/IProjectRepository.ts';
import type { Project, ProjectSummary } from '../../domain/project/types.ts';
import { summarize } from '../../domain/project/types.ts';
import type { IStorage } from '../storage/IStorage.ts';

const INDEX_KEY = 'aw-project-index';

function projectKey(id: string): string {
    return `aw-project:${id}`;
}

function readIndex(storage: IStorage): string[] {
    try {
        const raw = storage.getItem(INDEX_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeIndex(storage: IStorage, ids: string[]): void {
    storage.setItem(INDEX_KEY, JSON.stringify(ids));
}

export class StorageProjectRepository implements IProjectRepository {
    readonly #storage: IStorage;

    constructor(storage: IStorage) {
        this.#storage = storage;
    }

    async save(project: Project): Promise<void> {
        const updated: Project = { ...project, updatedAt: Date.now() };
        this.#storage.setItem(projectKey(project.id), JSON.stringify(updated));

        const ids = readIndex(this.#storage);
        if (!ids.includes(project.id)) {
            writeIndex(this.#storage, [...ids, project.id]);
        }
    }

    async load(id: string): Promise<Project | null> {
        const raw = this.#storage.getItem(projectKey(id));
        if (raw === null) return null;
        try {
            return JSON.parse(raw) as Project;
        } catch {
            return null;
        }
    }

    async list(): Promise<ProjectSummary[]> {
        const ids = readIndex(this.#storage);
        const summaries: ProjectSummary[] = [];

        for (const id of ids) {
            const project = await this.load(id);
            if (project) summaries.push(summarize(project));
        }

        return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    }

    async delete(id: string): Promise<void> {
        this.#storage.removeItem(projectKey(id));
        const ids = readIndex(this.#storage).filter((i) => i !== id);
        writeIndex(this.#storage, ids);
    }
}
