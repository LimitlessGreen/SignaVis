// ═══════════════════════════════════════════════════════════════════════
// domain/project/IProjectStore.ts — port for a labeling project location
//
// Implementations (see plans/project-folder-plan.md):
//   • OpfsProjectStore      — browser-private project (all browsers), phase 3
//   • FsAccessProjectStore  — user-picked folder (Chromium), phase 4
//   • MemoryProjectStore    — tests
//
// Paths are relative to the project root with '/' separators.
// ═══════════════════════════════════════════════════════════════════════

import type { WorkspaceProject } from './workspaceProject.ts';

export interface ProjectStoreCapabilities {
    /** Audio files can be written into the store (XC downloads under xc/). */
    writeAudio: boolean;
    /** The store is a folder the user can see / back up outside the browser. */
    userVisible: boolean;
}

export interface AudioFileInfo {
    path: string;
    size: number;
    lastModified: number;
}

export interface IProjectStore {
    /** Display name (folder name, or 'Browser project'). */
    readonly label: string;
    readonly capabilities: ProjectStoreCapabilities;

    /** Null when the store holds no project yet. Throws ProjectFormatError for a foreign file. */
    loadProject(): Promise<WorkspaceProject | null>;
    saveProject(project: WorkspaceProject): Promise<void>;
    /** Last-modified time of the stored project file (for external-change detection), or null. */
    projectModifiedAt(): Promise<number | null>;

    /** Audio files in the store (recursive), e.g. for "files not yet in the project". */
    listAudio(): Promise<AudioFileInfo[]>;
    readAudio(path: string): Promise<File | null>;
    writeAudio(path: string, data: ArrayBuffer): Promise<void>;
    /** Generic small text/JSON files (xc/XC1.json metadata, exports/…). */
    writeText(path: string, text: string): Promise<void>;
}

export const AUDIO_EXTENSIONS = ['wav', 'mp3', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'webm'];

export const isAudioPath = (path: string) =>
    AUDIO_EXTENSIONS.includes(path.split('.').pop()?.toLowerCase() || '');

/** Normalise a relative project path; rejects absolute paths and '..'. */
export function normalizeProjectPath(path: string): string {
    const parts = String(path).replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
    if (!parts.length || parts.some((p) => p === '..') || /^[a-z]:$/i.test(parts[0])) {
        throw new Error(`Invalid project path: ${path}`);
    }
    return parts.join('/');
}
