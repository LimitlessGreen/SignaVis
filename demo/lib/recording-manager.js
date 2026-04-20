/**
 * RecordingManager — manages a session's list of RecordingEntry objects.
 *
 * Each entry represents one audio recording (local file or XC recording)
 * together with its annotation data. Only one entry is "active" at a time;
 * switching saves the current player annotations back into the leaving entry
 * and restores the arriving entry.
 *
 * Persisted in sessionStorage so the list survives page refresh but is
 * cleared when the tab is closed. Blob URLs are not serialisable — they
 * are cleared on refresh and the user must re-pick local files.
 *
 * Events (fired on the instance, which extends EventTarget):
 *   'change'        — after any structural mutation (add / remove)
 *   'activechange'  — after the active recording changes
 *
 * RecordingEntry shape:
 * {
 *   id:              string,              // UUID, local only
 *   xcId:            string | null,       // '12345' for XC recordings, null for local files
 *   filename:        string,              // display name
 *   audioUrl:        string | null,       // blob URL or XC audio URL
 *   isBlobUrl:       boolean,             // true if audioUrl is a blob: URL (not persistent)
 *   xcRecordingMeta: object | null,       // raw XC API recording object
 *   annotations:     object[],           // per-recording annotation list
 *   sampleRate:      number | null,       // set after first load
 * }
 */

const SESSION_KEY = 'aw:recording-manager.v1';

function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
}

/** @returns {RecordingEntry} */
export function defaultRecordingEntry(partial = {}) {
    return {
        id: uuid(),
        xcId: null,
        filename: 'Untitled',
        audioUrl: null,
        isBlobUrl: false,
        xcRecordingMeta: null,
        annotations: [],
        sampleRate: null,
        /** When true, activateRecordingEntry will re-import XC labels on next switch */
        needsXcImport: false,
        ...partial,
    };
}

export class RecordingManager extends EventTarget {
    constructor() {
        super();
        /** @type {Map<string, ReturnType<typeof defaultRecordingEntry>>} */
        this._entries = new Map();
        /** @type {string|null} */
        this._activeId = null;
        this._restore();
    }

    // ── Accessors ────────────────────────────────────────────────────────

    /** @returns {ReturnType<typeof defaultRecordingEntry>[]} */
    getAll() { return [...this._entries.values()]; }

    /** @returns {ReturnType<typeof defaultRecordingEntry>|null} */
    getById(id) { return this._entries.get(id) ?? null; }

    /** @returns {ReturnType<typeof defaultRecordingEntry>|null} */
    getActive() { return this._activeId ? (this._entries.get(this._activeId) ?? null) : null; }

    get activeId() { return this._activeId; }

    get size() { return this._entries.size; }

    // ── Mutations ────────────────────────────────────────────────────────

    /**
     * Add a new recording entry. Does NOT set it as active.
     * @param {Partial<ReturnType<typeof defaultRecordingEntry>>} partial
     * @returns {ReturnType<typeof defaultRecordingEntry>}
     */
    add(partial = {}) {
        const entry = defaultRecordingEntry(partial);
        this._entries.set(entry.id, entry);
        this._save();
        this._fire('change');
        return entry;
    }

    /**
     * Remove a recording entry by ID.
     * If it was active, active becomes null (caller must handle player state).
     */
    remove(id) {
        if (!this._entries.has(id)) return;
        this._entries.delete(id);
        if (this._activeId === id) this._activeId = null;
        this._save();
        this._fire('change');
    }

    /**
     * Update fields on an existing entry (shallow merge).
     */
    update(id, updates) {
        const entry = this._entries.get(id);
        if (!entry) return;
        Object.assign(entry, updates);
        this._save();
    }

    /**
     * Save current player annotations into the current active entry.
     * Call before switching to a different recording.
     * @param {object[]} annotations
     */
    saveAnnotations(annotations) {
        if (!this._activeId) return;
        const entry = this._entries.get(this._activeId);
        if (entry) {
            try {
                const count = Array.isArray(annotations) ? annotations.length : 0;
                console.debug('[RecordingManager] saveAnnotations', { id: this._activeId, count });
            } catch (e) {}

            // Normalize numeric fields and deduplicate annotations before persisting.
            // This prevents tiny floating-point variations from producing
            // multiple near-identical annotations across repeated saves.
            const seen = new Set();
            const normalized = [];
            const makeKey = (l) => {
                if (!l) return '';
                if (l.id) return `id:${l.id}`;
                const setId = l.setId || '';
                const start = Number.isFinite(Number(l.start)) ? Math.round(Number(l.start) * 1e6) / 1e6 : 0;
                const end = Number.isFinite(Number(l.end)) ? Math.round(Number(l.end) * 1e6) / 1e6 : 0;
                const sci = l.scientificName || '';
                const fmin = (l.freqMin != null && !isNaN(Number(l.freqMin))) ? Math.round(Number(l.freqMin) * 10) / 10 : '';
                const fmax = (l.freqMax != null && !isNaN(Number(l.freqMax))) ? Math.round(Number(l.freqMax) * 10) / 10 : '';
                return `${setId}:${start}:${end}:${sci}:${fmin}:${fmax}`;
            };

            for (const a of (annotations || [])) {
                const key = makeKey(a);
                if (seen.has(key)) continue;
                seen.add(key);
                const copy = { ...a };
                if (copy.start != null) copy.start = Number.isFinite(Number(copy.start)) ? Math.round(Number(copy.start) * 1e6) / 1e6 : copy.start;
                if (copy.end != null) copy.end = Number.isFinite(Number(copy.end)) ? Math.round(Number(copy.end) * 1e6) / 1e6 : copy.end;
                if (copy.freqMin != null && !isNaN(Number(copy.freqMin))) copy.freqMin = Math.round(Number(copy.freqMin) * 10) / 10;
                if (copy.freqMax != null && !isNaN(Number(copy.freqMax))) copy.freqMax = Math.round(Number(copy.freqMax) * 10) / 10;
                normalized.push(copy);
            }

            entry.annotations = normalized;
            this._save();
        }
    }

    /**
     * Find the first entry whose xcId matches (case-insensitive, strips 'XC' prefix).
     * Returns null if not found.
     * @param {string} xcId
     * @returns {ReturnType<typeof defaultRecordingEntry>|null}
     */
    findByXcId(xcId) {
        const clean = String(xcId).replace(/^xc/i, '').replace(/\D/g, '').replace(/^0+/, '') || '0';
        for (const entry of this._entries.values()) {
            if (entry.xcId === clean) return entry;
        }
        return null;
    }

    /**
     * Set the active recording. Fires 'activechange'.
     * Does NOT trigger any player loading — the caller is responsible.
     */
    setActive(id) {
        if (id !== null && !this._entries.has(id)) return;
        this._activeId = id;
        this._save();
        this._fire('activechange');
    }

    /**
     * Clear all entries and reset active to null.
     */
    clear() {
        // Revoke blob URLs to avoid memory leaks
        for (const e of this._entries.values()) {
            if (e.isBlobUrl && e.audioUrl) {
                try { URL.revokeObjectURL(e.audioUrl); } catch {}
            }
        }
        this._entries.clear();
        this._activeId = null;
        this._save();
        this._fire('change');
    }

    // ── Persistence ──────────────────────────────────────────────────────

    _save() {
        try {
            // Blob URLs are not persistent — clear them before saving
            const serialisable = [...this._entries.values()].map(e => ({
                ...e,
                audioUrl: e.isBlobUrl ? null : e.audioUrl,
            }));
            sessionStorage.setItem(SESSION_KEY, JSON.stringify({
                entries: serialisable,
                activeId: this._activeId,
            }));
        } catch { /* storage full or unavailable */ }
    }

    _restore() {
        try {
            const raw = sessionStorage.getItem(SESSION_KEY);
            if (!raw) return;
            const { entries, activeId } = JSON.parse(raw);
            if (!Array.isArray(entries)) return;
            for (const e of entries) {
                const entry = defaultRecordingEntry(e);
                this._entries.set(entry.id, entry);
            }
            if (activeId && this._entries.has(activeId)) {
                this._activeId = activeId;
            }
        } catch { /* ignore parse errors */ }
    }

    _fire(type) {
        this.dispatchEvent(new CustomEvent(type));
    }
}
