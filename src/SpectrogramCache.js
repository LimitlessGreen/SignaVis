// ═══════════════════════════════════════════════════════════════════════
// SpectrogramCache.js — IndexedDB-backed spectrogram data cache
// ═══════════════════════════════════════════════════════════════════════
//
// Caches computed Float32Array spectrogram data so that switching between
// recordings does not require full DSP recomputation.
//
// Cache key: SHA-256 of (audio fingerprint + DSP params string).
//   The fingerprint uses the first + last 4096 samples, the total sample
//   count, and the sample rate — fast to compute, collision-free in practice.
//
// LRU eviction: keeps the 20 most-recently-accessed entries.

const DB_NAME    = 'aw-spectrogram-cache';
const STORE_NAME = 'spectrograms';
const MAX_ENTRIES = 20;
const DB_VERSION  = 1;

/**
 * @typedef {object} CacheEntry
 * @property {string}       [key]
 * @property {ArrayBuffer}  dataBuffer   - Float32Array data as ArrayBuffer
 * @property {number}       nFrames
 * @property {number}       nMels
 * @property {number}       hopSize
 * @property {number}       winLength
 * @property {string}       colourScale
 * @property {number}       [timestamp]    - Date.now() of last access
 */

export class SpectrogramCache {
    constructor() {
        /** @type {IDBDatabase|null} */
        this._db = null;
        this._opening = null;
    }

    // ── Public API ───────────────────────────────────────────────────────

    /**
     * Compute a cache key from audio channel data + DSP parameters.
     *
     * @param {Float32Array} channelData
     * @param {number}       sampleRate
     * @param {object}       dspParams   — plain serialisable DSP options
     * @returns {Promise<string>}  hex SHA-256 digest
     */
    async computeKey(channelData, sampleRate, dspParams) {
        const FINGERPRINT_SAMPLES = 4096;
        const len = channelData.length;

        // Build fingerprint: first + last FINGERPRINT_SAMPLES + metadata word
        const fpLen   = Math.min(FINGERPRINT_SAMPLES, len);
        const fp      = new Float32Array(fpLen * 2 + 3);
        fp.set(channelData.subarray(0, fpLen), 0);
        fp.set(channelData.subarray(Math.max(0, len - fpLen)), fpLen);
        fp[fpLen * 2]     = sampleRate;
        fp[fpLen * 2 + 1] = len;
        fp[fpLen * 2 + 2] = len > 0 ? channelData[Math.floor(len / 2)] : 0; // mid-sample

        const paramsBytes = new TextEncoder().encode(JSON.stringify(dspParams));

        const combined = new Uint8Array(fp.buffer.byteLength + paramsBytes.length);
        combined.set(new Uint8Array(fp.buffer), 0);
        combined.set(paramsBytes, fp.buffer.byteLength);

        // crypto.subtle is only available in secure contexts (HTTPS / localhost).
        // Fall back to a fast non-cryptographic FNV-1a hash otherwise.
        if (crypto?.subtle?.digest) {
            const hashBuf = await crypto.subtle.digest('SHA-256', combined);
            return Array.from(new Uint8Array(hashBuf))
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');
        }
        // FNV-1a 64-bit (emulated with two 32-bit halves)
        let h1 = 0x811c9dc5, h2 = 0xc4a8d669;
        for (let i = 0; i < combined.length; i++) {
            const b = combined[i];
            h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0;
            h2 = Math.imul(h2 ^ b, 0x01000193) >>> 0;
        }
        return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
    }

    /**
     * Look up a cache entry. Returns null on miss.
     * Updates the timestamp of a hit (promotes to most-recently-used).
     *
     * @param {string} key
     * @returns {Promise<CacheEntry|null>}
     */
    async get(key) {
        const db = await this._open();
        if (!db) return null;
        return new Promise((resolve) => {
            const tx    = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const req   = store.get(key);
            req.onsuccess = () => {
                const entry = req.result;
                if (!entry) { resolve(null); return; }
                // Update LRU timestamp
                entry.timestamp = Date.now();
                store.put(entry);
                resolve(entry);
            };
            req.onerror = () => resolve(null);
        });
    }

    /**
     * Write a cache entry. Evicts LRU entries when over MAX_ENTRIES.
     *
     * @param {string}      key
     * @param {CacheEntry}  entry   — all fields except `key`
     */
    async set(key, entry) {
        const db = await this._open();
        if (!db) return;
        return new Promise((resolve) => {
            const tx    = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);

            // Write the new entry
            store.put({ ...entry, key, timestamp: Date.now() });

            // Count existing entries and evict LRU if needed
            const countReq = store.count();
            countReq.onsuccess = () => {
                const count = countReq.result;
                if (count <= MAX_ENTRIES) { resolve(undefined); return; }
                // Load all, sort by timestamp ascending, delete oldest
                const allReq = store.getAll();
                allReq.onsuccess = () => {
                    const all   = allReq.result;
                    const toEvict = all
                        .sort((a, b) => a.timestamp - b.timestamp)
                        .slice(0, count - MAX_ENTRIES);
                    for (const e of toEvict) store.delete(e.key);
                    resolve(undefined);
                };
                allReq.onerror = () => resolve(undefined);
            };
            countReq.onerror = () => resolve(undefined);
            tx.onerror = () => resolve(undefined);
        });
    }

    /**
     * Clear the entire cache.
     */
    async clear() {
        const db = await this._open();
        if (!db) return;
        return new Promise((resolve) => {
            const tx    = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const req   = store.clear();
            req.onsuccess = () => resolve(undefined);
            req.onerror   = () => resolve(undefined);
        });
    }

    // ── Private ──────────────────────────────────────────────────────────

    _open() {
        if (this._db) return Promise.resolve(this._db);
        if (this._opening) return this._opening;
        this._opening = new Promise((resolve) => {
            if (typeof indexedDB === 'undefined') { resolve(null); return; }
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const rt = /** @type {IDBOpenDBRequest | null} */ (e.target);
                if (!rt) return;
                const db = /** @type {IDBDatabase} */ (rt.result);
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'key' });
                }
            };
            req.onsuccess = (e) => {
                const rt = /** @type {IDBOpenDBRequest | null} */ (e.target);
                if (!rt) { this._opening = null; resolve(null); return; }
                this._db = /** @type {IDBDatabase} */ (rt.result);
                this._opening = null;
                resolve(this._db);
            };
            req.onerror = () => {
                this._opening = null;
                resolve(null);  // cache unavailable — degrade gracefully
            };
        });
        return this._opening;
    }
}

/** Singleton shared across the player instance. */
export const spectrogramCache = new SpectrogramCache();
