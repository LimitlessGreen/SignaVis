// ═══════════════════════════════════════════════════════════════════════
// infrastructure/storage/audioBlobStore.ts — persistent audio byte cache
//
// Keeps downloaded audio (e.g. Xeno-canto MP3s) so switching recordings
// does not re-download them. Backends:
//   • OPFS (navigator.storage.getDirectory) — all current browsers
//   • Cache API                             — fallback
//   • memory                                — tests
//
// An index (key → size, lastAccess, pinned) is kept in the backend under
// INDEX_NAME. Unpinned entries are evicted LRU when maxBytes is exceeded;
// pinned entries (e.g. pinned reference calls) are never evicted.
// ═══════════════════════════════════════════════════════════════════════

export interface BlobBackend {
    readonly kind: string;
    get(name: string): Promise<ArrayBuffer | null>;
    put(name: string, buf: ArrayBuffer): Promise<void>;
    delete(name: string): Promise<void>;
}

export interface AudioIndexEntry {
    size: number;
    lastAccess: number;
    pinned?: boolean;
}

const INDEX_NAME = '__index.json';
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

const safeName = (key: string) => key.replace(/[^A-Za-z0-9._-]/g, '_');

export class AudioBlobStore {
    readonly backend: BlobBackend;
    maxBytes: number;
    #index: Record<string, AudioIndexEntry> | null = null;
    #now: () => number;
    #queue: Promise<unknown> = Promise.resolve();

    constructor(backend: BlobBackend, { maxBytes = DEFAULT_MAX_BYTES, now = () => Date.now() } = {}) {
        this.backend = backend;
        this.maxBytes = maxBytes;
        this.#now = now;
    }

    /** Serialise index mutations so concurrent puts do not lose entries. */
    #run<T>(fn: () => Promise<T>): Promise<T> {
        const p = this.#queue.then(fn, fn);
        this.#queue = p.catch(() => {});
        return p;
    }

    async #loadIndex() {
        if (this.#index) return this.#index;
        try {
            const raw = await this.backend.get(INDEX_NAME);
            const parsed = raw ? JSON.parse(new TextDecoder().decode(raw)) : {};
            this.#index = parsed && typeof parsed === 'object' ? parsed : {};
        } catch { this.#index = {}; }
        return this.#index!;
    }

    async #saveIndex() {
        const bytes = new TextEncoder().encode(JSON.stringify(this.#index || {}));
        await this.backend.put(INDEX_NAME, bytes.buffer as ArrayBuffer);
    }

    async get(key: string): Promise<ArrayBuffer | null> {
        const name = safeName(key);
        const buf = await this.backend.get(name).catch(() => null);
        if (!buf) return null;
        await this.#run(async () => {
            const idx = await this.#loadIndex();
            idx[name] = { ...(idx[name] || { size: buf.byteLength }), lastAccess: this.#now() };
            await this.#saveIndex();
        }).catch(() => {});
        return buf;
    }

    async has(key: string): Promise<boolean> {
        const idx = await this.#loadIndex();
        return !!idx[safeName(key)];
    }

    async put(key: string, buf: ArrayBuffer, { pinned }: { pinned?: boolean } = {}): Promise<void> {
        const name = safeName(key);
        await this.#run(async () => {
            await this.backend.put(name, buf.slice(0));
            const idx = await this.#loadIndex();
            const prev = idx[name];
            idx[name] = { size: buf.byteLength, lastAccess: this.#now(), pinned: pinned ?? prev?.pinned ?? false };
            await this.#evict(name);
            await this.#saveIndex();
        });
    }

    async setPinned(key: string, pinned: boolean): Promise<void> {
        const name = safeName(key);
        await this.#run(async () => {
            const idx = await this.#loadIndex();
            if (!idx[name]) return;
            idx[name].pinned = pinned;
            if (!pinned) await this.#evict(null);
            await this.#saveIndex();
        });
    }

    async delete(key: string): Promise<void> {
        const name = safeName(key);
        await this.#run(async () => {
            const idx = await this.#loadIndex();
            delete idx[name];
            await this.backend.delete(name).catch(() => {});
            await this.#saveIndex();
        });
    }

    /** Remove all unpinned entries. */
    async clear({ includePinned = false } = {}): Promise<void> {
        await this.#run(async () => {
            const idx = await this.#loadIndex();
            for (const [name, e] of Object.entries(idx)) {
                if (e.pinned && !includePinned) continue;
                delete idx[name];
                await this.backend.delete(name).catch(() => {});
            }
            await this.#saveIndex();
        });
    }

    async usage(): Promise<{ bytes: number; count: number; pinnedBytes: number }> {
        const idx = await this.#loadIndex();
        let bytes = 0, pinnedBytes = 0, count = 0;
        for (const e of Object.values(idx)) {
            bytes += e.size; count++;
            if (e.pinned) pinnedBytes += e.size;
        }
        return { bytes, count, pinnedBytes };
    }

    /** Evict least-recently-used unpinned entries until under maxBytes. `keep` is never evicted. */
    async #evict(keep: string | null) {
        const idx = this.#index!;
        let total = Object.values(idx).reduce((s, e) => s + e.size, 0);
        if (total <= this.maxBytes) return;
        const victims = Object.entries(idx)
            .filter(([n, e]) => !e.pinned && n !== keep)
            .sort((a, b) => a[1].lastAccess - b[1].lastAccess);
        for (const [name, e] of victims) {
            if (total <= this.maxBytes) break;
            delete idx[name];
            total -= e.size;
            await this.backend.delete(name).catch(() => {});
        }
    }
}

// ── Backends ─────────────────────────────────────────────────────────

export function createMemoryBackend(): BlobBackend {
    const m = new Map<string, ArrayBuffer>();
    return {
        kind: 'memory',
        async get(n) { const b = m.get(n); return b ? b.slice(0) : null; },
        async put(n, b) { m.set(n, b.slice(0)); },
        async delete(n) { m.delete(n); },
    };
}

export function createOpfsBackend(dirName: string): BlobBackend {
    let dirP: Promise<any> | null = null;
    const dir = () => (dirP ??= (navigator as any).storage.getDirectory()
        .then((root: any) => root.getDirectoryHandle(dirName, { create: true })));
    return {
        kind: 'opfs',
        async get(n) {
            try {
                const fh = await (await dir()).getFileHandle(n);
                return await (await fh.getFile()).arrayBuffer();
            } catch { return null; }
        },
        async put(n, b) {
            const fh = await (await dir()).getFileHandle(n, { create: true });
            const w = await fh.createWritable();
            await w.write(b);
            await w.close();
        },
        async delete(n) {
            try { await (await dir()).removeEntry(n); } catch { /* missing */ }
        },
    };
}

export function createCacheApiBackend(cacheName: string): BlobBackend {
    const url = (n: string) => `https://audio-cache.local/${encodeURIComponent(n)}`;
    return {
        kind: 'cache-api',
        async get(n) {
            const res = await (await caches.open(cacheName)).match(url(n));
            return res ? await res.arrayBuffer() : null;
        },
        async put(n, b) { await (await caches.open(cacheName)).put(url(n), new Response(b)); },
        async delete(n) { await (await caches.open(cacheName)).delete(url(n)); },
    };
}

/** OPFS createWritable is missing in older Safari; probe once. */
async function opfsWritable(): Promise<boolean> {
    try {
        const root = await (navigator as any).storage?.getDirectory?.();
        if (!root) return false;
        const fh = await root.getFileHandle('__probe', { create: true });
        const ok = typeof fh.createWritable === 'function';
        await root.removeEntry('__probe').catch(() => {});
        return ok;
    } catch { return false; }
}

// ── Shared XC audio store ────────────────────────────────────────────

let _xcStore: Promise<AudioBlobStore | null> | null = null;

/** The app-wide cache for Xeno-canto audio, or null when no backend is available. */
export function getXcAudioStore(): Promise<AudioBlobStore | null> {
    return (_xcStore ??= (async () => {
        let backend: BlobBackend | null = null;
        if (await opfsWritable()) backend = createOpfsBackend('xc-audio');
        else if (typeof caches !== 'undefined') backend = createCacheApiBackend('xc-audio');
        if (!backend) return null;
        try { await (navigator as any).storage?.persist?.(); } catch { /* ignore */ }
        return new AudioBlobStore(backend);
    })());
}

export const xcAudioKey = (xcId: string | number) => `XC${String(xcId).replace(/^xc/i, '')}.mp3`;
