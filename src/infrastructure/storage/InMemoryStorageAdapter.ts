// ═══════════════════════════════════════════════════════════════════════
// storage/InMemoryStorageAdapter.ts — IStorage backed by a Map
// ═══════════════════════════════════════════════════════════════════════

import { StorageBase } from './IStorage.ts';

export class InMemoryStorageAdapter extends StorageBase {
    private readonly _store: Map<string, string>;

    constructor(initial: Record<string, string> = {}) {
        super();
        this._store = new Map(Object.entries(initial));
    }

    getItem(key: string): string | null {
        return this._store.has(key) ? (this._store.get(key) ?? null) : null;
    }
    setItem(key: string, value: string): void {
        this._store.set(key, String(value));
    }
    removeItem(key: string): void { this._store.delete(key); }
    hasItem(key: string): boolean  { return this._store.has(key); }
    clear(): void                  { this._store.clear(); }

    /** Return all stored entries as a plain object (useful in tests). */
    toObject(): Record<string, string> {
        return Object.fromEntries(this._store);
    }
}
