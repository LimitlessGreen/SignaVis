import test from 'node:test';
import assert from 'node:assert/strict';

import { NativeProjectStore, openDefaultNativeStore, folderName } from '../src/infrastructure/project/NativeProjectStore.ts';
import { ProjectConflictError } from '../src/infrastructure/project/DirectoryProjectStore.ts';
import { serializeProject } from '../src/domain/project/workspaceProject.ts';

// Fake of the Lite shell's project_fs commands (src-tauri-lite/src/project_fs.rs) on a Map.
function fakeShell() {
    let clock = 1000;
    const files = new Map();   // "<root>|<path>" → { data: Uint8Array, lastModified }
    const calls = [];
    const key = (root, path) => `${root}|${path}`;
    const invoke = async (cmd, args, options) => {
        calls.push(cmd);
        switch (cmd) {
            case 'project_stat': {
                const f = files.get(key(args.root, args.path));
                return f ? { path: args.path, size: f.data.length, lastModified: f.lastModified } : null;
            }
            case 'project_read': {
                const f = files.get(key(args.root, args.path));
                if (!f) throw 'not-found';
                return f.data.slice().buffer;
            }
            case 'project_write': {
                assert.ok(args instanceof Uint8Array, 'write sends a raw body');
                const root = decodeURIComponent(options.headers['x-root']);
                const path = decodeURIComponent(options.headers['x-path']);
                files.set(key(root, path), { data: args.slice(), lastModified: ++clock });
                return null;
            }
            case 'project_list_audio':
                return [...files.entries()]
                    .filter(([k]) => k.startsWith(`${args.root}|`) && /\.(wav|mp3)$/i.test(k))
                    .map(([k, f]) => ({ path: k.split('|')[1], size: f.data.length, lastModified: f.lastModified }));
            case 'default_project_dir':
                return 'C:\\Users\\Ä\\AppData\\Roaming\\lite\\projects\\default';
            default:
                throw new Error(`unknown command ${cmd}`);
        }
    };
    return { invoke, files, calls, touch: (root, path) => { files.get(key(root, path)).lastModified = ++clock; } };
}

const project = (name) => serializeProject(
    { entries: [], activeId: null, labelSets: new Map(), ownSetId: null, activeSetId: null }, { id: 'id', name });

test('native store: project, audio and text round trip', async () => {
    const shell = fakeShell();
    const store = new NativeProjectStore('/home/jb/Feld 2026', { invoke: shell.invoke });
    assert.equal(store.label, 'Feld 2026');
    assert.equal(await store.loadProject(), null);

    await store.saveProject(project('Feld'));
    assert.equal((await store.loadProject()).name, 'Feld');

    await store.writeAudio('xc/XC1.mp3', new Uint8Array([1, 2, 3]).buffer);
    await store.writeText('xc/XC1.json', '{"ä":1}');
    const file = await store.readAudio('xc/XC1.mp3');
    assert.equal(file.name, 'XC1.mp3');
    assert.equal(file.type, 'audio/mpeg');
    assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [1, 2, 3]);
    assert.equal(await store.readAudio('missing.wav'), null);
    assert.deepEqual((await store.listAudio()).map((f) => f.path), ['xc/XC1.mp3']);
});

test('native store: rejects paths outside the project before calling the shell', async () => {
    const shell = fakeShell();
    const store = new NativeProjectStore('/p', { invoke: shell.invoke });
    await assert.rejects(() => store.writeText('../evil.txt', 'x'), /Invalid project path/);
    assert.ok(!shell.calls.includes('project_write'));
});

test('native store: conflict guard notices changes made outside the app', async () => {
    const shell = fakeShell();
    const store = new NativeProjectStore('/p', { invoke: shell.invoke, guardConflicts: true });
    await store.saveProject(project('a'));
    await store.loadProject();
    await store.saveProject(project('b'));          // own changes are fine
    shell.touch('/p', 'project.signavis.json');     // another program writes the file
    await assert.rejects(() => store.saveProject(project('c')), ProjectConflictError);
    await store.acceptExternalChange();
    await store.saveProject(project('c'));
    assert.equal((await store.loadProject()).name, 'c');
});

test('default project lives in the folder the shell names', async () => {
    const shell = fakeShell();
    const store = await openDefaultNativeStore(shell.invoke);
    assert.equal(store.label, 'Default project');
    assert.match(store.rootPath, /projects\\default$/);
});

test('folderName handles both separators and trailing slashes', () => {
    assert.equal(folderName('C:\\Users\\JB\\Feld\\'), 'Feld');
    assert.equal(folderName('/home/jb/Feld 2026'), 'Feld 2026');
});
