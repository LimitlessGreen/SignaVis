import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecordingTree, folderPathOf, countRecordings, recordingName, XC_FOLDER_ID, LOCAL_FOLDER_ID, SESSION_FOLDER_ID } from '../src/app/recording-tree.ts';

const entries = [
    { id: 'x2', source: 'xc', xcId: 'XC900', path: 'xc/XC900.mp3' },
    { id: 'f10', source: 'file', path: 'garden/2026/a10.wav' },
    { id: 'x1', source: 'xc', xcId: 'XC12', path: null },
    { id: 'f2', source: 'file', path: 'garden/2026/a2.wav' },
    { id: 's', source: 'file', filename: 'session.wav', path: null },
    { id: 'linked', source: 'file', xcId: 'XC5', path: 'garden/mine.wav' },
    { id: 'top', source: 'file', path: 'top.wav' },
];

const shape = (nodes) => nodes.map((n) => (n.kind === 'folder' ? { [n.name]: shape(n.children) } : n.kind === 'file' ? `file:${n.name}` : n.id));

test('buildRecordingTree: sources on one level — project folder, Xeno-canto, session files', () => {
    const tree = buildRecordingTree(entries, [], { localName: 'Birds' });
    assert.deepEqual(shape(tree), [
        { Birds: [{ garden: [{ 2026: ['f2', 'f10'] }, 'linked'] }, 'top'] },
        { 'Xeno-canto': ['x1', 'x2'] },
        { 'Session files': ['s'] },
    ]);
    assert.deepEqual(tree.map((n) => n.id), [LOCAL_FOLDER_ID, XC_FOLDER_ID, SESSION_FOLDER_ID]);
    assert.equal(countRecordings(tree[0]), 4);
});

test('folderPathOf / recordingName', () => {
    const tree = buildRecordingTree(entries);
    assert.deepEqual(folderPathOf(tree, 'f10'), [LOCAL_FOLDER_ID, 'garden', 'garden/2026']);
    assert.deepEqual(folderPathOf(tree, 'x1'), [XC_FOLDER_ID]);
    assert.deepEqual(folderPathOf(tree, 's'), [SESSION_FOLDER_ID]);
    assert.equal(recordingName(entries[0]), 'XC900');
    assert.equal(recordingName(entries[1]), 'a10.wav');
    assert.equal(recordingName(entries[4]), 'session.wav');
});

test('folder files without entry appear as file nodes, sorted with recordings', () => {
    const tree = buildRecordingTree(
        [{ id: 'f2', source: 'file', path: 'garden/a2.wav' }],
        [{ path: 'garden/a10.wav', size: 5 }, { path: 'garden/a1.wav' }, { path: 'top.wav' }],
        { localName: 'P' },
    );
    assert.deepEqual(shape(tree), [{ P: [{ garden: ['file:a1.wav', 'f2', 'file:a10.wav'] }, 'file:top.wav'] }]);
    assert.equal(countRecordings(tree[0]), 4);
});

test('recordingFolder / folderContents', async () => {
    const { recordingFolder, folderContents } = await import('../src/app/recording-tree.ts');
    assert.equal(recordingFolder({ source: 'file', path: 'garden/2026/a.wav' }), 'garden/2026');
    assert.equal(recordingFolder({ source: 'file', path: 'top.wav' }), '');
    assert.equal(recordingFolder({ source: 'xc', xcId: 'XC1' }), XC_FOLDER_ID);
    assert.equal(recordingFolder({ source: 'file', filename: 's.wav' }), SESSION_FOLDER_ID);
    const tree = buildRecordingTree([{ id: 'f2', source: 'file', path: 'g/a2.wav' }], [{ path: 'g/sub/b.wav' }, { path: 'c.wav' }]);
    const g = tree[0].children.find((n) => n.name === 'g');
    const c = folderContents(g);
    assert.deepEqual([c.entries.map((e) => e.id), c.files.map((f) => f.path)], [['f2'], ['g/sub/b.wav']]);
});
