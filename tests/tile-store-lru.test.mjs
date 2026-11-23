import test from 'node:test';
import assert from 'node:assert/strict';
import { pruneTileStores, markStoreUsed, TILE_CACHE_DEFAULT_MAX_BYTES } from '../src/infrastructure/storage/tileStoreLru.ts';

/** Minimal in-memory OPFS directory tree; `locked` names cannot be removed (open sync handles). */
class FakeFile {
    // Data files only need a size (no payload); files written by markStoreUsed keep real bytes.
    constructor(name, size = 0, lastModified = 0) { this.kind = 'file'; this.name = name; this.size = size; this.bytes = null; this.lastModified = lastModified; }
    async getFile() {
        if (this.bytes) return new File([this.bytes], this.name, { lastModified: this.lastModified });
        return { size: this.size, lastModified: this.lastModified, text: async () => '' };
    }
    async createWritable() {
        const self = this; const parts = [];
        return { async write(d) { parts.push(typeof d === 'string' ? new TextEncoder().encode(d) : d); }, async close() { self.bytes = new Uint8Array(await new Blob(parts).arrayBuffer()); }, async abort() {} };
    }
}
class FakeDir {
    constructor(name = '') { this.kind = 'directory'; this.name = name; this.children = new Map(); this.locked = new Set(); }
    async getDirectoryHandle(n, o) { if (!this.children.has(n) && o?.create) this.children.set(n, new FakeDir(n)); const c = this.children.get(n); if (!c) throw new DOMException('x', 'NotFoundError'); return c; }
    async getFileHandle(n, o) { if (!this.children.has(n) && o?.create) this.children.set(n, new FakeFile(n)); const c = this.children.get(n); if (!c) throw new DOMException('x', 'NotFoundError'); return c; }
    async removeEntry(n) { if (this.locked.has(n)) throw new DOMException('locked', 'NoModificationAllowedError'); this.children.delete(n); }
    async *entries() { yield* [...this.children.entries()]; }
}
const MB = 1 << 20;
async function addStore(base, key, mb, used) {
    const d = await base.getDirectoryHandle(key, { create: true });
    d.children.set('L0.f16', new FakeFile('L0.f16', mb * MB));
    d.children.set('meta.json', new FakeFile('meta.json', 10, used));
    if (used != null) await markStoreUsed(d, used);
    return d;
}

test('default cap is 1 GiB', () => assert.equal(TILE_CACHE_DEFAULT_MAX_BYTES, 1 << 30));

test('pruneTileStores removes least recently used stores until under the cap, keeps the current one', async () => {
    const base = new FakeDir();
    await addStore(base, 'a', 40, 1000);
    await addStore(base, 'b', 40, 3000);
    await addStore(base, 'c', 40, 2000);
    await addStore(base, 'cur', 40, 500);  // oldest stamp, but in use now
    const r = await pruneTileStores(base, 90 * MB, new Set(['cur']));
    assert.deepEqual([...base.children.keys()].sort(), ['b', 'cur']);
    assert.deepEqual(r.removed.sort(), ['a', 'c']);
    assert.ok(r.totalBytes <= 90 * MB);
});

test('a store larger than the cap alone is kept while current; others go', async () => {
    const base = new FakeDir();
    await addStore(base, 'old', 5, 1);
    await addStore(base, 'big', 200, 2);
    await pruneTileStores(base, 100 * MB, new Set(['big']));
    assert.deepEqual([...base.children.keys()], ['big']);
});

test('locked stores (open in another page) are skipped, not fatal', async () => {
    const base = new FakeDir();
    await addStore(base, 'a', 60, 1);
    await addStore(base, 'b', 60, 2);
    await addStore(base, 'c', 60, 3);
    base.locked.add('a');
    const r = await pruneTileStores(base, 100 * MB, new Set());
    assert.deepEqual([...base.children.keys()], ['a']);
    assert.deepEqual(r.removed, ['b', 'c']);
});

test('cap 0 removes every unlocked store', async () => {
    const base = new FakeDir();
    await addStore(base, 'a', 1, 1);
    await addStore(base, 'b', 1, 2);
    await pruneTileStores(base, 0, new Set());
    assert.equal(base.children.size, 0);
});

test('stores without a use stamp count as oldest', async () => {
    const base = new FakeDir();
    await addStore(base, 'stamped', 60, 5);
    await addStore(base, 'bare', 60, null);
    await pruneTileStores(base, 100 * MB, new Set());
    assert.deepEqual([...base.children.keys()], ['stamped']);
});
