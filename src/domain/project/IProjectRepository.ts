// ═══════════════════════════════════════════════════════════════════════
// domain/project/IProjectRepository.ts — Port for project persistence
//
// This interface is the only thing the application core knows about
// how projects are stored. Adapters implement it for:
//   • browser localStorage / IndexedDB
//   • Tauri native filesystem
//   • remote REST/gRPC API
// ═══════════════════════════════════════════════════════════════════════

import type { Project, ProjectSummary } from './types.ts';

export interface IProjectRepository {
    /**
     * Persist a project. Creates a new entry if `project.id` is unknown,
     * otherwise replaces the existing one.
     */
    save(project: Project): Promise<void>;

    /**
     * Load a project by id. Returns `null` when not found (never throws for
     * missing entries — only throws on I/O or parse errors).
     */
    load(id: string): Promise<Project | null>;

    /**
     * List lightweight summaries of all stored projects, sorted by
     * `updatedAt` descending (most recent first).
     */
    list(): Promise<ProjectSummary[]>;

    /**
     * Permanently remove a project. Resolves silently if the id is not found.
     */
    delete(id: string): Promise<void>;
}
