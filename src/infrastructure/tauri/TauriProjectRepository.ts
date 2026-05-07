// ═══════════════════════════════════════════════════════════════════════
// infrastructure/tauri/TauriProjectRepository.ts
//
// IProjectRepository adapter that calls the Rust IPC backend.
// Only imported when running inside a Tauri window — the browser build
// uses StorageProjectRepository instead.
//
// Runtime detection: typeof window.__TAURI_INTERNALS__ !== 'undefined'
// ═══════════════════════════════════════════════════════════════════════

import type { IProjectRepository } from '../../domain/project/IProjectRepository.ts';
import type { Project, ProjectSummary } from '../../domain/project/types.ts';
import { summarize } from '../../domain/project/types.ts';

// Lazy import so the module can be referenced in non-Tauri builds
// without pulling in the @tauri-apps/api package at load time.
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
    return tauriInvoke<T>(cmd, args);
}

export class TauriProjectRepository implements IProjectRepository {
    async save(project: Project): Promise<void> {
        const updated: Project = { ...project, updatedAt: Date.now() };
        await invoke<void>('write_project', { project: updated });
    }

    async load(id: string): Promise<Project | null> {
        try {
            return await invoke<Project>('read_project', { id });
        } catch {
            // Tauri command throws a string when the file is not found
            return null;
        }
    }

    async list(): Promise<ProjectSummary[]> {
        try {
            const summaries = await invoke<ProjectSummary[]>('list_projects');
            return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
        } catch {
            // Compatibility fallback for older desktop binaries.
            const ids = await invoke<string[]>('list_project_ids');
            const projects = await Promise.all(ids.map((id) => this.load(id)));
            return projects
                .filter((p): p is Project => p !== null)
                .map(summarize)
                .sort((a, b) => b.updatedAt - a.updatedAt);
        }
    }

    async delete(id: string): Promise<void> {
        await invoke<void>('delete_project', { id });
    }
}

// ── Helper: detect Tauri environment ─────────────────────────────────

export function isTauriContext(): boolean {
    return typeof (globalThis as any).__TAURI_INTERNALS__ !== 'undefined';
}
