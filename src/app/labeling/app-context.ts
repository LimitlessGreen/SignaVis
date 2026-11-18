// ═══════════════════════════════════════════════════════════════════════
// app-context.ts — what feature modules of the labeling app get from main.js
//
// Each module under features/ exports install(ctx) (or a factory) and only uses what
// is listed here. Members are read when used (main.js passes getters), so a module can
// be installed before every part of the app exists.
// ═══════════════════════════════════════════════════════════════════════

import type { LabelStore, StoredLabel } from './label-store.ts';
import type { RecordingManager } from '../recording-manager.ts';

/** A label as the app stores it (more fields are passed through untouched). */
export interface AppLabel extends StoredLabel {
    setId?: string | null;
    label?: string;
    start?: number;
    end?: number;
}

export interface LabelSetInfo { name?: string; [key: string]: unknown }

export interface AppState {
    readonly labels: readonly AppLabel[];
    labelSets: Map<string, LabelSetInfo>;
    sampleRate: number;
}

/** Project storage (browser or folder), as far as feature modules write to it. */
export interface ProjectStoreLike {
    readonly label: string;
    writeText(path: string, text: string): Promise<unknown>;
}

export interface AppContext {
    readonly state: AppState;
    readonly labelStore: LabelStore<AppLabel>;
    readonly recordingManager: RecordingManager;
    /** The player; typed loosely until BirdNETPlayer's public API is described. */
    readonly player: { recordingStart?: Date | string | null; [key: string]: any };
    /** Status line under the player. */
    readonly selectionMeta: HTMLElement;
    /** File name shown in the status bar. */
    readonly fileLabel: HTMLElement;
    readonly projectStore: ProjectStoreLike | null;
    /** Save the open recording's labels into its entry now (see labelStore). */
    saveCurrentAnnotations(): void;
    /** Redraw every label view and save (changes besides the labels: sets, visibility). */
    syncToPlayer(): void;
    /** Switch the left sidebar to a tab. */
    showSidebarTab(id: string): void;
}
