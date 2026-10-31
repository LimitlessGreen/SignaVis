import test from 'node:test';
import assert from 'node:assert/strict';

import { DirectoryProjectStore, ProjectConflictError } from '../src/infrastructure/project/DirectoryProjectStore.ts';
import { serializeProject, filesNotInProject, xcMetaPath } from '../src/domain/project/workspaceProject.ts';

// Minimal in-memory FileSystemDirectoryHandle / FileSystemFileHandle.
let clock = 1000;
function fakeFile(name) {
    const h = { kind: 'file', name, data: new Uint8Array(0), lastModified: 0 };
    h.getFile = async () => new File([h.data], name, { lastModified: h.lastModified });
    h.createWritable = async () => {
        let buf = null;
        return {
            write: async (d) => { buf = typeof d === 'string' ? new TextEncoder().encode(d) : new Uint8Array(d.slice(0)); },
            close: async () => { h.data = buf; h.lastModified = ++clock; },
        };
    };
    return h;
}
function fakeDir(name = 'root') {
    const children = new Map();
    const notFound = () => Object.assign(new Error('not found'), { name: 'NotFoundError' });
    return {
        kind: 'directory', name, children,
        async getDirectoryHandle(n, { create = false } = {}) {
            if (!children.has(n)) { if (!create) throw notFound(); children.set(n, fakeDir(n)); }
            const c = children.get(n); if (c.kind !== 'directory') throw new Error('type'); return c;
        },
        async getFileHandle(n, { create = false } = {}) {
            if (!children.has(n)) { if (!create) throw notFound(); children.set(n, fakeFile(n)); }
            const c = children.get(n); if (c.kind !== 'file') throw new Error('type'); return c;
        },
        async removeEntry(n) { children.delete(n); },
        async *entries() { yield* children.entries(); },
    };
}
const project = (name = 'p') => serializeProject(
    { entries: [], activeId: null, labelSets: new Map(), ownSetId: null, activeSetId: null }, { id: 'id', name });

test('folder store: project, audio, text and recursive listing', async () => {
    const root = fakeDir();
    const store = new DirectoryProjectStore(root, { label: 'Feld', userVisible: true });
    assert.equal(await store.loadProject(), null);
    await store.saveProject(project('Feld'));
    assert.equal((await store.loadProject()).name, 'Feld');

    await store.writeAudio('xc/XC1.mp3', new Uint8Array(3).buffer);
    await store.writeText(xcMetaPath('1'), '{}');
    const deep = await (await root.getDirectoryHandle('aufnahmen', { create: true })).getDirectoryHandle('tag1', { create: true });
    const fh = await deep.getFileHandle('A.WAV', { create: true });
    const w = await fh.createWritable(); await w.write(new Uint8Array(10).buffer); await w.close();
    await (await root.getDirectoryHandle('.git', { create: true })).getFileHandle('x.wav', { create: true });

    const files = (await store.listAudio()).map((f) => f.path);
    assert.deepEqual(files, ['aufnahmen/tag1/A.WAV', 'xc/XC1.mp3']);
    assert.equal((await store.readAudio('aufnahmen/tag1/A.WAV')).size, 10);
    assert.equal(await store.readAudio('nope.wav'), null);
    await assert.rejects(() => store.writeText('../evil.txt', 'x'));
});

test('folder store: detects external changes, acceptExternalChange overrides', async () => {
    const root = fakeDir();
    const store = new DirectoryProjectStore(root, { label: 'F', userVisible: true, guardConflicts: true });
    await store.saveProject(project('one'));          // new file: no conflict
    await store.saveProject(project('two'));          // own write: no conflict
    await store.loadProject();

    // another program rewrites the file
    const other = new DirectoryProjectStore(root, { label: 'F', userVisible: true });
    await other.saveProject(project('external'));

    await assert.rejects(() => store.saveProject(project('mine')), ProjectConflictError);
    assert.equal((await other.loadProject()).name, 'external');
    await store.acceptExternalChange();
    await store.saveProject(project('mine'));
    assert.equal((await other.loadProject()).name, 'mine');
});

test('filesNotInProject skips used paths and existing XC downloads', () => {
    const files = [{ path: 'a.wav' }, { path: 'b.wav' }, { path: 'xc/XC5.mp3' }, { path: 'xc/XC6.mp3' }];
    const entries = [{ path: 'a.wav' }, { xcId: '5', path: null }];
    assert.deepEqual(filesNotInProject(files, entries).map((f) => f.path), ['b.wav', 'xc/XC6.mp3']);
});
