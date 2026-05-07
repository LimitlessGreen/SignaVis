// ═══════════════════════════════════════════════════════════════════════
// shared/storageJson.ts — Type-safe JSON helpers for IStorage
// ═══════════════════════════════════════════════════════════════════════

import type { IStorage } from '../infrastructure/storage/IStorage.ts';

/**
 * Read a JSON value from storage.  Returns `fallback` when the key is
 * absent, empty, or contains unparseable/unexpected data.
 */
export function jsonGetItem<T>(storage: IStorage, key: string, fallback: T): T {
    try {
        const raw = storage.getItem(key);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw) as unknown;
        if (parsed === null || parsed === undefined) return fallback;
        return parsed as T;
    } catch {
        return fallback;
    }
}

/** Serialise `value` to JSON and persist it under `key`. */
export function jsonSetItem(storage: IStorage, key: string, value: unknown): void {
    storage.setItem(key, JSON.stringify(value));
}
