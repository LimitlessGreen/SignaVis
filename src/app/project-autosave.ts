// app/project-autosave.ts — debounced saving of the labeling project into an IProjectStore
//
// Only one tab may write a project: the tab that gets the Web Lock
// (navigator.locks) owns it; other tabs run without saving and show a hint.

import type { IProjectStore } from '../domain/project/IProjectStore.ts';
import type { WorkspaceProject } from '../domain/project/workspaceProject.ts';

export type AutosaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'readonly';

export interface ProjectAutosaverOptions {
    store: IProjectStore;
    build: () => WorkspaceProject;
    delayMs?: number;
    onStatus?: (status: AutosaveStatus, error?: unknown) => void;
    setTimer?: (fn: () => void, ms: number) => any;
    clearTimer?: (t: any) => void;
}

export class ProjectAutosaver {
    readonly store: IProjectStore;
    readOnly = false;
    #build: () => WorkspaceProject;
    #delay: number;
    #onStatus: (s: AutosaveStatus, e?: unknown) => void;
    #setTimer: (fn: () => void, ms: number) => any;
    #clearTimer: (t: any) => void;
    #timer: any = null;
    #dirty = false;
    #running: Promise<void> | null = null;

    constructor(o: ProjectAutosaverOptions) {
        this.store = o.store;
        this.#build = o.build;
        this.#delay = o.delayMs ?? 1000;
        this.#onStatus = o.onStatus ?? (() => {});
        this.#setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
        this.#clearTimer = o.clearTimer ?? ((t) => clearTimeout(t));
    }

    setReadOnly(v: boolean) {
        this.readOnly = v;
        if (v) { this.#clearTimer(this.#timer); this.#timer = null; this.#dirty = false; this.#onStatus('readonly'); }
    }

    /** Mark the project changed; saves after `delayMs` of quiet. */
    schedule() {
        if (this.readOnly) return;
        this.#dirty = true;
        this.#onStatus('pending');
        this.#clearTimer(this.#timer);
        this.#timer = this.#setTimer(() => { this.#timer = null; this.flush(); }, this.#delay);
    }

    /** Save now if there are unsaved changes (or `force`). Concurrent calls are serialised. */
    async flush({ force = false } = {}): Promise<void> {
        if (this.readOnly) return;
        if (this.#timer) { this.#clearTimer(this.#timer); this.#timer = null; }
        if (!this.#dirty && !force) return this.#running ?? undefined;
        if (this.#running) {
            await this.#running;
            if (!this.#dirty && !force) return;
        }
        this.#dirty = false;
        this.#running = (async () => {
            this.#onStatus('saving');
            try {
                await this.store.saveProject(this.#build());
                this.#onStatus(this.#dirty ? 'pending' : 'saved');
            } catch (e) {
                this.#dirty = true;
                this.#onStatus('error', e);
            }
        })();
        try { await this.#running; } finally { this.#running = null; }
    }

    get hasUnsavedChanges() { return this.#dirty || !!this.#running; }
}

/**
 * Hold an exclusive Web Lock for the lifetime of the page.
 * Resolves true when this tab owns `name`, false when another tab does.
 * Without the Locks API the tab is assumed to be the owner.
 */
export function acquireTabLock(name: string, locks: any = (globalThis as any).navigator?.locks): Promise<boolean> {
    if (!locks?.request) return Promise.resolve(true);
    return new Promise((resolve) => {
        locks.request(name, { ifAvailable: true }, (lock: any) => {
            resolve(!!lock);
            if (!lock) return undefined;
            return new Promise(() => {});   // never released while the page lives
        }).catch(() => resolve(true));
    });
}
