// ═══════════════════════════════════════════════════════════════════════
// storage/LocalStorageAdapter.ts — IStorage backed by window.localStorage
// ═══════════════════════════════════════════════════════════════════════

import { StorageBase } from './IStorage.ts';

export class LocalStorageAdapter extends StorageBase {
    getItem(key: string): string | null {
        try { return localStorage.getItem(key); }
        catch { return null; }
    }
    setItem(key: string, value: string): void {
        try { localStorage.setItem(key, value); }
        catch { /* quota exceeded or private browsing */ }
    }
    removeItem(key: string): void {
        try { localStorage.removeItem(key); }
        catch { /* ignore */ }
    }
    hasItem(key: string): boolean {
        try { return localStorage.getItem(key) !== null; }
        catch { return false; }
    }
    clear(): void {
        try { localStorage.clear(); }
        catch { /* ignore */ }
    }
}
