// ═══════════════════════════════════════════════════════════════════════
// tileStoreLru.ts — size cap for the spectrogram pyramid stores in OPFS
//
// Each long recording leaves one store directory (about 60 MB per minute of audio). Without a
// cap they pile up across files and sessions. Every open stamps its store with the time of use;
// afterwards the least recently used stores are removed until the total fits the cap. Stores
// that another page still has open (sync access handles) cannot be removed and are skipped.
// ═══════════════════════════════════════════════════════════════════════

/** Default upper bound for all pyramid stores together. */
export const TILE_CACHE_DEFAULT_MAX_BYTES = 1 << 30;

/** File in each store holding the last use as milliseconds since the epoch. */
const USED_FILE = 'used';

/** Record that the store in `dir` was just used. Errors are ignored (the stamp is a hint). */
export async function markStoreUsed(dir: FileSystemDirectoryHandle, now = Date.now()): Promise<void> {
    try {
        const fh = await dir.getFileHandle(USED_FILE, { create: true });
        const bytes = new TextEncoder().encode(String(now));
        if (typeof (fh as any).createWritable === 'function') {
            const w = await (fh as any).createWritable();
            await w.write(bytes);
            await w.close();
        } else {
            // Safari: no createWritable, but sync handles in workers.
            const h = await (fh as any).createSyncAccessHandle();
            try { h.truncate(0); h.write(bytes, { at: 0 }); h.flush(); } finally { h.close(); }
        }
    } catch { /* not fatal */ }
}

async function storeInfo(dir: FileSystemDirectoryHandle): Promise<{ bytes: number; used: number }> {
    let bytes = 0;
    let used = 0;
    for await (const [name, h] of (dir as any).entries()) {
        if (h.kind !== 'file') continue;
        try {
            const f: File = await h.getFile();
            bytes += f.size;
            if (name === USED_FILE) used = Number(await f.text()) || 0;
        } catch { /* file vanished or locked */ }
    }
    return { bytes, used };
}

/**
 * Remove least recently used stores under `base` until all together take at most `maxBytes`.
 * Stores named in `keep` stay even if they alone exceed the cap.
 */
export async function pruneTileStores(base: FileSystemDirectoryHandle, maxBytes: number, keep: Set<string>):
    Promise<{ totalBytes: number; removed: string[] }> {
    const stores: Array<{ key: string; bytes: number; used: number }> = [];
    for await (const [key, h] of (base as any).entries()) {
        if (h.kind !== 'directory') continue;
        stores.push({ key, ...(await storeInfo(h)) });
    }
    let totalBytes = stores.reduce((s, x) => s + x.bytes, 0);
    const removed: string[] = [];
    stores.sort((a, b) => a.used - b.used);
    for (const s of stores) {
        if (totalBytes <= maxBytes) break;
        if (keep.has(s.key)) continue;
        try {
            await base.removeEntry(s.key, { recursive: true });
            totalBytes -= s.bytes;
            removed.push(s.key);
        } catch { /* open in another page */ }
    }
    return { totalBytes, removed };
}
