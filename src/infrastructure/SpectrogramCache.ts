
export interface SpectrogramCacheOptions {
    maxEntries?: number;
    maxBytes?: number;
    minFreeBytes?: number;
}
export interface CacheEntry {
    key?: string;
    dataBuffer?: ArrayBuffer | null;
    nFrames?: number;
    nMels?: number;
    hopSize?: number;
    winLength?: number;
    colourScale?: string;
    timestamp?: number;
    byteSize?: number;
}
// ═══════════════════════════════════════════════════════════════════════
// SpectrogramCache.ts — IndexedDB-backed spectrogram data cache
// ═══════════════════════════════════════════════════════════════════════
//
// Caches computed Float32Array spectrogram data so that switching between
// recordings does not require full DSP recomputation.
//
// Cache key: SHA-256 of (audio fingerprint + DSP params string).
//   The fingerprint uses the first + last 4096 samples, the total sample
//   count, and the sample rate — fast to compute, collision-free in practice.
//
// Eviction strategy (both limits are checked on every write):
//   1. LRU by entry count: evicts oldest entries when count exceeds maxEntries.
//   2. LRU by byte size:   evicts oldest entries when estimated bytes exceed
//      maxBytes (each Float32Array entry ≈ nFrames × nMels × 4 bytes).
//   3. Storage quota guard: skips writes when browser reports less than
//      MIN_FREE_BYTES of available origin storage (StorageManager.estimate).
//
// All limits are configurable at construction time.
// The module-level `spectrogramCache` singleton uses production defaults.

const DB_NAME    = 'aw-spectrogram-cache';
const STORE_NAME = 'spectrograms';
const DB_VERSION  = 1;

// ── Default limits ────────────────────────────────────────────────────

const DEFAULT_MAX_ENTRIES  = 20;
const DEFAULT_MAX_BYTES    = 256 * 1024 * 1024;   // 256 MB across all cached entries
const DEFAULT_MIN_FREE_BYTES = 50 * 1024 * 1024;  // skip write if < 50 MB origin storage free

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
 * @property {number}       [byteSize]     - estimated size in bytes (set on write)
 */

export class SpectrogramCache {
    _db: IDBDatabase | null = null;
    _opening: Promise<IDBDatabase | null> | null = null;
    _maxEntries: number;
    _maxBytes: number;
    _minFreeBytes: number;
    /**
     * @param {object} [opts]
     * @param {number} [opts.maxEntries=20]       - max number of cached spectrograms
     * @param {number} [opts.maxBytes=268435456]  - max total byte size (default 256 MB)
     * @param {number} [opts.minFreeBytes=52428800] - skip write if origin has < this free
     */
    constructor({ maxEntries = DEFAULT_MAX_ENTRIES,
                  maxBytes   = DEFAULT_MAX_BYTES,
                  minFreeBytes = DEFAULT_MIN_FREE_BYTES } = {}) {
        /** @type {IDBDatabase|null} */
        this._db        = null;
        this._opening   = null;
        this._maxEntries = maxEntries;
        this._maxBytes   = maxBytes;
        this._minFreeBytes = minFreeBytes;
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
    async computeKey(channelData: Float32Array | number[], sampleRate: number, dspParams: any): Promise<string> {
        const FINGERPRINT_SAMPLES = 4096;
        const cd = channelData instanceof Float32Array ? channelData : Float32Array.from(channelData as any);
        const len = cd.length;

        const fpLen = Math.min(FINGERPRINT_SAMPLES, len);
        const fp    = new Float32Array(fpLen * 2 + 3);
        fp.set(cd.subarray(0, fpLen), 0);
        fp.set(cd.subarray(Math.max(0, len - fpLen)), fpLen);
        fp[fpLen * 2]     = sampleRate;
        fp[fpLen * 2 + 1] = len;
        fp[fpLen * 2 + 2] = len > 0 ? cd[Math.floor(len / 2)] : 0;

        const paramsBytes = new TextEncoder().encode(JSON.stringify(dspParams));
        const combined    = new Uint8Array(fp.buffer.byteLength + paramsBytes.length);
        combined.set(new Uint8Array(fp.buffer), 0);
        combined.set(paramsBytes, fp.buffer.byteLength);

        if (crypto?.subtle?.digest) {
            const hashBuf = await crypto.subtle.digest('SHA-256', combined);
            return Array.from(new Uint8Array(hashBuf))
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');
        }
        // FNV-1a 64-bit fallback (no secure context)
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
     * Updates the LRU timestamp of a hit.
     *
     * @param {string} key
     * @returns {Promise<CacheEntry|null>}
     */
    async get(key: string) {
        const db = await this._open();
        if (!db) return null;
        return new Promise((resolve) => {
            const tx    = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const req   = store.get(key);
            req.onsuccess = () => {
                const entry = req.result;
                if (!entry) { resolve(null); return; }
                entry.timestamp = Date.now();
                store.put(entry);
                resolve(entry);
            };
            req.onerror = () => resolve(null);
        });
    }

    /**
     * Write a cache entry. Evicts LRU entries if limits are exceeded.
     * Skips the write silently if origin storage is critically low.
     *
     * @param {string}      key
     * @param {CacheEntry}  entry
     */
    async set(key: string, entry: CacheEntry) {
        // Guard: skip write if origin storage is critically low
        if (this._minFreeBytes > 0 && await this._isStorageCritical()) return;

        const db = await this._open();
        if (!db) return;

        const byteSize = this._estimateEntryBytes(entry);

        return new Promise((resolve) => {
            const tx    = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);

            store.put({ ...entry, key, timestamp: Date.now(), byteSize });

            const allReq = store.getAll();
            allReq.onsuccess = () => {
                const all: CacheEntry[] = allReq.result as any[];
                const sorted = all.sort((a: CacheEntry, b: CacheEntry) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

                // Evict by entry count
                let toEvict: CacheEntry[] = sorted.slice(0, Math.max(0, all.length - this._maxEntries));

                // Evict additional entries to stay under byte limit
                if (this._maxBytes > 0) {
                    const remaining: CacheEntry[] = sorted.filter((e: CacheEntry) => !toEvict.includes(e));
                    let totalBytes: number = remaining.reduce((s: number, e: CacheEntry) => s + (e.byteSize ?? 0), 0);
                    const byteEvict: CacheEntry[] = [];
                    for (const e of remaining) {
                        if (totalBytes <= this._maxBytes) break;
                        byteEvict.push(e);
                        totalBytes -= e.byteSize ?? 0;
                    }
                    toEvict = [...new Set([...toEvict, ...byteEvict])];
                }

                for (const e of toEvict) { if (e.key) store.delete(e.key); }
                resolve(undefined);
            };
            allReq.onerror   = () => resolve(undefined);
            tx.onerror       = () => resolve(undefined);
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

    /**
     * Returns the approximate total cached bytes (sum of stored byteSize fields).
     * @returns {Promise<number>}
     */
    async estimateBytesUsed(): Promise<number> {
        const db = await this._open();
        if (!db) return 0;
        return new Promise((resolve) => {
            const tx  = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).getAll();
            req.onsuccess = () => {
                const list: CacheEntry[] = req.result as any[];
                const total = list.reduce((s: number, e: CacheEntry) => s + (e.byteSize ?? 0), 0);
                resolve(total);
            };
            req.onerror = () => resolve(0);
        });
    }

    // ── Private ──────────────────────────────────────────────────────────

    /**
     * Estimate the byte footprint of a spectrogram entry.
     * Float32Array body + ~128 bytes metadata overhead.
     * @param {CacheEntry} entry
     * @returns {number}
     */
    _estimateEntryBytes(entry: CacheEntry) {
        const dataBytes = (entry.dataBuffer?.byteLength ?? 0)
            || ((entry.nFrames ?? 0) * (entry.nMels ?? 0) * 4);
        return (dataBytes || 0) + 128;
    }

    /**
     * Query StorageManager.estimate() and return true if available storage
     * is below the configured minimum free threshold.
     * Silently returns false when the API is unavailable.
     * @returns {Promise<boolean>}
     */
    async _isStorageCritical(): Promise<boolean> {
        try {
            if (!navigator?.storage?.estimate) return false;
            const info = await navigator.storage.estimate();
            const quota = (info as any).quota ?? 0;
            const usage = (info as any).usage ?? 0;
            return (quota - usage) < this._minFreeBytes;
        } catch {
            return false;
        }
    }

    _open(): Promise<IDBDatabase | null> {
        if (this._db)      return Promise.resolve(this._db);
        if (this._opening) return this._opening;
        this._opening = new Promise((resolve) => {
            if (typeof indexedDB === 'undefined') { resolve(null); return; }
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const rt = e.target as IDBOpenDBRequest | null;
                if (!rt) return;
                const db = rt.result as IDBDatabase;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'key' });
                }
            };
            req.onsuccess = (e) => {
                const rt = e.target as IDBOpenDBRequest | null;
                if (!rt) { this._opening = null; resolve(null); return; }
                this._db      = rt.result as IDBDatabase;
                this._opening = null;
                resolve(this._db);
            };
            req.onerror = () => {
                this._opening = null;
                resolve(null);
            };
        });
        return this._opening;
    }
}

/** Singleton shared across the player instance. Uses production defaults. */
export const spectrogramCache = new SpectrogramCache();
