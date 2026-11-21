import test from 'node:test';
import assert from 'node:assert/strict';
import { writePcmWavFile, PCM_CACHE_DIR } from '../src/infrastructure/storage/pcmCache.ts';
import { parseWav } from '../src/infrastructure/audio/wavDecode.ts';

/** Minimal in-memory OPFS: directories, files with createWritable/getFile/removeEntry. */
class FakeFile {
    constructor(name, dir) { this.kind = 'file'; this.name = name; this.dir = dir; this.parts = []; this.lastModified = Date.now(); this.failAt = -1; }
    async getFile() { return new File(this.parts, this.name, { lastModified: this.lastModified }); }
    async createWritable() {
        const staged = []; const self = this;
        return {
            async write(d) { if (staged.length === self.failAt) throw new Error('disk full'); staged.push(new Uint8Array(d.buffer ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d)); },
            async close() { self.parts = staged; self.lastModified = Date.now(); },
            async abort() {},
        };
    }
}
class FakeDir {
    constructor() { this.kind = 'directory'; this.children = new Map(); this.failNextFileAt = -1; }
    async getDirectoryHandle(n, o) { if (!this.children.has(n) && o?.create) this.children.set(n, new FakeDir()); const c = this.children.get(n); if (!c) throw new Error('NotFound'); return c; }
    async getFileHandle(n, o) { if (!this.children.has(n) && o?.create) { const f = new FakeFile(n, this); f.failAt = this.failNextFileAt; this.failNextFileAt = -1; this.children.set(n, f); } return this.children.get(n); }
    async removeEntry(n) { this.children.delete(n); }
    async *entries() { yield* [...this.children.entries()]; }
}

const signal = (n) => Float32Array.from({ length: n }, (_, i) => Math.sin(i * 0.01) * 0.5 + (i % 7) * 1e-7);

test('writePcmWavFile: float WAV with the exact samples, in pieces', async () => {
    const root = new FakeDir();
    const data = signal((1 << 20) * 2 + 1234);          // three writes of samples
    const file = await writePcmWavFile(data, 44100, root);
    const buf = await file.arrayBuffer();
    const info = parseWav(buf);
    assert.deepEqual({ format: info.format, ch: info.channels, sr: info.sampleRate, frames: info.frames, off: info.dataOffset },
        { format: 'float', ch: 1, sr: 44100, frames: data.length, off: 44 });
    assert.deepEqual(new Float32Array(buf, 44), data);
    assert.equal((await root.getDirectoryHandle(PCM_CACHE_DIR)).children.size, 1);
});

test('writePcmWavFile: removes this page\'s previous file and stale ones, keeps fresh foreign ones', async () => {
    const root = new FakeDir();
    const dir = await root.getDirectoryHandle(PCM_CACHE_DIR, { create: true });
    const old = await dir.getFileHandle('other-old.wav', { create: true }); old.lastModified = Date.now() - 2 * 86400e3;
    await dir.getFileHandle('other-fresh.wav', { create: true });
    const first = await writePcmWavFile(signal(100), 8000, root);
    const second = await writePcmWavFile(signal(100), 8000, root);
    const names = [...dir.children.keys()].sort();
    assert.deepEqual(names, ['other-fresh.wav', second.name].sort());
    assert.notEqual(first.name, second.name);
});

test('writePcmWavFile: a failed write leaves no file and throws', async () => {
    const root = new FakeDir();
    const dir = await root.getDirectoryHandle(PCM_CACHE_DIR, { create: true });
    dir.failNextFileAt = 1;
    await assert.rejects(writePcmWavFile(signal(5000), 8000, root), /disk full/);
    assert.equal(dir.children.size, 0);
});

test('writePcmWavFile: players on one page keep each other\'s current file', async () => {
    const root = new FakeDir();
    const dir = await root.getDirectoryHandle(PCM_CACHE_DIR, { create: true });
    const a = {}, b = {};
    const a1 = await writePcmWavFile(signal(100), 8000, root, false, a);
    const b1 = await writePcmWavFile(signal(100), 8000, root, false, b);
    const a2 = await writePcmWavFile(signal(100), 8000, root, false, a);
    assert.deepEqual([...dir.children.keys()].sort(), [a2.name, b1.name].sort());
    assert.ok(!dir.children.has(a1.name));
});

test('floatWavHeader: refuses sizes the 32-bit RIFF fields cannot hold', async () => {
    const { floatWavHeader } = await import('../src/infrastructure/storage/pcmCache.ts');
    const max = Math.floor((0xffffffff - 36) / 4);
    assert.equal(new DataView(floatWavHeader(max, 48000)).getUint32(40, true), max * 4);
    assert.throws(() => floatWavHeader(max + 1, 48000), RangeError);
});

test('writePcmWavFile: a late write of an older generation keeps the newer file', async () => {
    const root = new FakeDir();
    const dir = await root.getDirectoryHandle(PCM_CACHE_DIR, { create: true });
    const owner = {};
    const newer = await writePcmWavFile(signal(100), 8000, root, false, owner, 2);
    const older = await writePcmWavFile(signal(100), 8000, root, false, owner, 1);
    assert.deepEqual([...dir.children.keys()].sort(), [newer.name, older.name].sort());
    const next = await writePcmWavFile(signal(100), 8000, root, false, owner, 3);
    assert.deepEqual([...dir.children.keys()], [next.name]);
});
