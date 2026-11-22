// ═══════════════════════════════════════════════════════════════════════
// storage/prefs.ts — small persisted UI settings (one place for every key)
//
// Every read and write is safe: blocked storage (private mode, sandboxed
// iframe, quota) never throws, reads fall back to the default.
// Flags are stored as '1' / '0' (also reads 'true' / 'false').
//
// The backend is window.localStorage by default. A host that embeds the
// player can swap it (e.g. InMemoryStorageAdapter to keep nothing, or a
// prefixed adapter) with setPrefsBackend().
// ═══════════════════════════════════════════════════════════════════════

/** The part of Storage that prefs needs (window.localStorage and IStorage both fit). */
export interface PrefsBackend {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

let backend: PrefsBackend | null | undefined;

function store(): PrefsBackend | null {
    if (backend !== undefined) return backend;
    // The getter itself throws in some sandboxed contexts.
    try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** Use another backend for all prefs (null: persist nothing). Call with undefined to restore localStorage. */
export function setPrefsBackend(next: PrefsBackend | null | undefined): void {
    backend = next;
}

export const prefs = {
    get(key: string): string | null {
        try { return store()?.getItem(key) ?? null; } catch { return null; }
    },
    set(key: string, value: string): void {
        try { store()?.setItem(key, value); } catch { /* blocked or full: not persisted */ }
    },
    remove(key: string): void {
        try { store()?.removeItem(key); } catch { /* blocked */ }
    },
    /** '1'/'true' → true, '0'/'false' → false, missing or anything else → fallback. */
    flag(key: string, fallback = false): boolean {
        const v = prefs.get(key);
        if (v === '1' || v === 'true') return true;
        if (v === '0' || v === 'false') return false;
        return fallback;
    },
    setFlag(key: string, on: boolean): void {
        prefs.set(key, on ? '1' : '0');
    },
    /** Parsed JSON, or fallback when missing, unreadable or null. */
    json<T>(key: string, fallback: T): T {
        const raw = prefs.get(key);
        if (raw == null) return fallback;
        try { return (JSON.parse(raw) ?? fallback) as T; } catch { return fallback; }
    },
    setJson(key: string, value: unknown): void {
        let text: string;
        try { text = JSON.stringify(value); } catch { return; }
        prefs.set(key, text);
    },
};

/**
 * Storage-shaped view of prefs, for helpers that take a storage argument
 * (recent items, sponsor card, species lists, …). Never throws.
 */
export const prefsStorage: PrefsBackend = {
    getItem: (key) => prefs.get(key),
    setItem: (key, value) => prefs.set(key, value),
    removeItem: (key) => prefs.remove(key),
};
