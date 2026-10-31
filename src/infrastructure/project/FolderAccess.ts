// ═══════════════════════════════════════════════════════════════════════
// infrastructure/project/FolderAccess.ts — user-picked project folders
// (File System Access API, Chromium desktop only).
//
// • pickProjectFolder()     — showDirectoryPicker in readwrite mode
// • recent folder handle    — kept in IndexedDB (handles are structured-cloneable)
// • ensurePermission()      — query / request (request needs a user gesture)
// ═══════════════════════════════════════════════════════════════════════

import { DirectoryProjectStore, type DirHandle } from './DirectoryProjectStore.ts';

const DB_NAME = 'signavis-project-folders';
const STORE = 'handles';
const RECENT_KEY = 'recent';

export const isFolderAccessSupported = () =>
    typeof (globalThis as any).showDirectoryPicker === 'function';

export function folderStore(handle: DirHandle) {
    return new DirectoryProjectStore(handle, { label: handle.name, userVisible: true, guardConflicts: true });
}

/** Opens the native folder picker. Resolves null when the user cancels. */
export async function pickProjectFolder(): Promise<DirHandle | null> {
    try {
        return await (globalThis as any).showDirectoryPicker({ id: 'signavis-project', mode: 'readwrite' });
    } catch (e: any) {
        if (e?.name === 'AbortError') return null;
        throw e;
    }
}

export type PermissionState = 'granted' | 'prompt' | 'denied';

/** With `request`, asks the user (must run inside a click handler). */
export async function ensurePermission(handle: DirHandle, { request = false } = {}): Promise<PermissionState> {
    const opts = { mode: 'readwrite' };
    try {
        let state: PermissionState = await handle.queryPermission?.(opts) ?? 'granted';
        if (state === 'prompt' && request) state = await handle.requestPermission(opts);
        return state;
    } catch { return 'denied'; }
}

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await openDb();
    try {
        return await new Promise<T>((resolve, reject) => {
            const req = fn(db.transaction(STORE, mode).objectStore(STORE));
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    } finally { db.close(); }
}

export async function rememberFolder(handle: DirHandle | null) {
    try {
        if (handle) await tx('readwrite', (s) => s.put(handle, RECENT_KEY));
        else await tx('readwrite', (s) => s.delete(RECENT_KEY));
    } catch { /* IndexedDB unavailable */ }
}

export async function recentFolder(): Promise<DirHandle | null> {
    try { return (await tx('readonly', (s) => s.get(RECENT_KEY))) ?? null; }
    catch { return null; }
}
