import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecordingTree, folderPathOf, countRecordings, recordingName, XC_FOLDER_ID } from '../src/app/recording-tree.ts';

const entries = [
    { id: 'x2', source: 'xc', xcId: 'XC900', path: 'xc/XC900.mp3' },
    { id: 'f10', source: 'file', path: 'garden/2026/a10.wav' },
    { id: 'x1', source: 'xc', xcId: 'XC12', path: null },
    { id: 'f2', source: 'file', path: 'garden/2026/a2.wav' },
    { id: 's', source: 'file', filename: 'session.wav', path: null },
    { id: 'linked', source: 'file', xcId: 'XC5', path: 'garden/mine.wav' },
];

const shape = (nodes) => nodes.map((n) => (n.kind === 'folder' ? { [n.name]: shape(n.children) } : n.id));

test('buildRecordingTree: real folders, virtual XC folder, root files', () => {
    const tree = buildRecordingTree(entries);
    assert.deepEqual(shape(tree), [
        { garden: [{ 2026: ['f2', 'f10'] }, 'linked'] },
        { 'Xeno-canto': ['x1', 'x2'] },
        's',
    ]);
    assert.equal(tree[1].id, XC_FOLDER_ID);
    assert.equal(countRecordings(tree[0]), 3);
});

test('folderPathOf / recordingName', () => {
    const tree = buildRecordingTree(entries);
    assert.deepEqual(folderPathOf(tree, 'f10'), ['garden', 'garden/2026']);
    assert.deepEqual(folderPathOf(tree, 'x1'), [XC_FOLDER_ID]);
    assert.deepEqual(folderPathOf(tree, 's'), []);
    assert.equal(recordingName(entries[0]), 'XC900');
    assert.equal(recordingName(entries[1]), 'a10.wav');
    assert.equal(recordingName(entries[4]), 'session.wav');
});
