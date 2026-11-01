import test from 'node:test';
import assert from 'node:assert/strict';

import {
    PROJECT_SCHEMA, inferSource, serializeProject, parseProject, deserializeProject, filesNotInProject,
    stringifyProject, ProjectFormatError, xcRecordingPath,
} from '../src/domain/project/workspaceProject.ts';
import { normalizeProjectPath, isAudioPath } from '../src/domain/project/IProjectStore.ts';
import { MemoryProjectStore } from '../src/infrastructure/project/MemoryProjectStore.ts';
import { RecordingManager } from '../src/app/recording-manager.ts';

globalThis.sessionStorage ??= (() => {
    const m = new Map();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
})();

const NOW = new Date('2026-10-31T12:00:00Z');

function sampleSnapshot() {
    return {
        entries: [
            { id: 'r1', xcId: '928094', filename: 'XC928094.mp3', audioUrl: 'https://xeno-canto.org/928094/download',
              isBlobUrl: false, annotations: [{ id: 'l1', start: 1, end: 2, setId: 's1' }], sampleRate: 44100,
              xcRecordingMeta: { id: '928094', lic: 'CC-BY-4.0' }, needsXcImport: false },
            { id: 'r2', xcId: null, filename: 'local.wav', audioUrl: 'blob:http://x/abc', isBlobUrl: true,
              annotations: [], sampleRate: null, context: { site: 'Garten' } },
            { id: 'r3', xcId: null, filename: 'birdsong.wav', audioUrl: './samples/birdsong.wav', isBlobUrl: false, annotations: [] },
        ],
        activeId: 'r1',
        labelSets: new Map([['s1', { id: 's1', name: 'Mine', origin: 'manual', status: 'draft' }]]),
        ownSetId: 's1',
        activeSetId: 's1',
        settings: { taxonomyLang: 'de' },
    };
}

test('inferSource covers legacy entries', () => {
    assert.equal(inferSource({ xcId: '1', audioUrl: 'https://xeno-canto.org/1/download' }), 'xc');
    assert.equal(inferSource({ xcId: '1', audioUrl: null }), 'xc');
    assert.equal(inferSource({ xcId: '1', audioUrl: 'blob:x', isBlobUrl: true }), 'file'); // local copy linked to XC
    assert.equal(inferSource({ audioUrl: './samples/a.wav' }), 'sample');
    assert.equal(inferSource({ audioUrl: 'https://example.org/a.wav' }), 'url');
    assert.equal(inferSource({ source: 'xc' }), 'xc');
});

test('serialize → JSON → parse → deserialize roundtrip', () => {
    const project = serializeProject(sampleSnapshot(), { id: 'p1', name: 'Test' }, NOW);
    assert.equal(project.schema, PROJECT_SCHEMA);
    assert.equal(project.updatedAt, NOW.toISOString());
    const json = stringifyProject(project);
    assert.ok(!json.includes('blob:'), 'blob URLs must never be persisted');

    const snap = deserializeProject(parseProject(json));
    assert.equal(snap.activeId, 'r1');
    assert.equal(snap.ownSetId, 's1');
    assert.deepEqual(snap.settings, { taxonomyLang: 'de' });
    assert.equal(snap.labelSets.get('s1').name, 'Mine');
    const [xc, local, sample] = snap.entries;
    assert.equal(xc.source, 'xc');
    assert.equal(xc.audioUrl, 'https://xeno-canto.org/928094/download');
    assert.deepEqual(xc.annotations, [{ id: 'l1', start: 1, end: 2, setId: 's1' }]);
    assert.equal(xc.xcRecordingMeta.lic, 'CC-BY-4.0');
    assert.equal(local.source, 'file');
    assert.equal(local.audioUrl, null);       // session-only file: user re-picks it
    assert.deepEqual(local.context, { site: 'Garten' });
    assert.equal(sample.audioUrl, './samples/birdsong.wav');
});

test('serialize does not alias session state', () => {
    const snap = sampleSnapshot();
    const project = serializeProject(snap, { id: 'p', name: 'n' }, NOW);
    project.recordings[0].annotations.push({ id: 'x' });
    project.sets[0].name = 'changed';
    assert.equal(snap.entries[0].annotations.length, 1);
    assert.equal(snap.labelSets.get('s1').name, 'Mine');
});

test('parseProject rejects foreign files and repairs dangling references', () => {
    assert.throws(() => parseProject({ foo: 1 }), ProjectFormatError);
    assert.throws(() => parseProject({ schema: 'other/1', recordings: [] }), ProjectFormatError);
    assert.throws(() => parseProject({ schema: PROJECT_SCHEMA }), ProjectFormatError);
    const p = parseProject({
        schema: PROJECT_SCHEMA, recordings: [{ id: 'a', source: 'xc', xcId: '5' }, { id: 'a' }, null],
        activeRecordingId: 'gone', sets: [{ id: 's' }], ownSetId: 'missing', activeSetId: 's',
    });
    assert.equal(p.recordings.length, 1);
    assert.equal(p.activeRecordingId, null);
    assert.equal(p.ownSetId, null);
    assert.equal(p.activeSetId, 's');
    assert.equal(p.recordings[0].annotations.length, 0);
});

test('path helpers', () => {
    assert.equal(normalizeProjectPath('audio\\sub/./a.wav'), 'audio/sub/a.wav');
    assert.throws(() => normalizeProjectPath('../a.wav'));
    assert.throws(() => normalizeProjectPath('C:/a.wav'));
    assert.throws(() => normalizeProjectPath(''));
    assert.equal(isAudioPath('x/Y.FLAC'), true);
    assert.equal(isAudioPath('project.signavis.json'), false);
    assert.equal(xcRecordingPath('12'), 'xc/XC12.mp3');
});

test('MemoryProjectStore stores project and audio', async () => {
    let t = 0;
    const store = new MemoryProjectStore('m', { now: () => ++t });
    assert.equal(await store.loadProject(), null);
    await store.saveProject(serializeProject(sampleSnapshot(), { id: 'p', name: 'n' }, NOW));
    assert.equal((await store.loadProject()).recordings.length, 3);
    assert.equal(await store.projectModifiedAt(), 1);
    await store.writeAudio('xc/XC1.mp3', new Uint8Array(5).buffer);
    await store.writeText('xc/XC1.json', '{}');
    assert.deepEqual((await store.listAudio()).map((f) => f.path), ['xc/XC1.mp3']);
    assert.equal((await store.readAudio('xc/XC1.mp3')).size, 5);
    assert.equal(await store.readAudio('nope.wav'), null);
});

test('RecordingManager: source on add, snapshot and replaceAll', () => {
    const rm = new RecordingManager();
    rm.clear();
    const a = rm.add({ xcId: '7', filename: 'XC7.mp3', audioUrl: 'https://xeno-canto.org/7/download' });
    rm.add({ filename: 'f.wav', audioUrl: 'blob:x', isBlobUrl: true });
    assert.equal(a.source, 'xc');
    assert.equal(a.path, null);
    rm.setActive(a.id);

    const { entries, activeId } = rm.snapshot();
    assert.equal(entries.length, 2);
    entries[0].annotations.push({ id: 'z' });
    assert.equal(rm.getById(a.id).annotations.length, 0, 'snapshot is a copy');

    let fired = [];
    rm.addEventListener('change', () => fired.push('change'));
    rm.addEventListener('activechange', () => fired.push('active'));
    const snap = deserializeProject(parseProject(stringifyProject(
        serializeProject({ ...rm.snapshot(), labelSets: new Map(), ownSetId: null, activeSetId: null }, { id: 'p', name: 'n' }, NOW))));
    rm.replaceAll(snap.entries, snap.activeId);
    assert.deepEqual(fired, ['change', 'active']);
    assert.equal(rm.size, 2);
    assert.equal(rm.activeId, activeId);
    assert.equal(rm.getById(a.id).source, 'xc');
    assert.equal(rm.getAll().find((e) => e.filename === 'f.wav').source, 'file');
    rm.replaceAll([], 'missing');
    assert.equal(rm.activeId, null);
});

test('XC IDs are stored with prefix; bare numbers from older files are migrated', () => {
    const p = parseProject({ schema: PROJECT_SCHEMA, recordings: [{ id: 'a', source: 'xc', xcId: '5' }, { id: 'b', xcId: 'XC6' }] });
    assert.deepEqual(p.recordings.map((r) => r.xcId), ['XC5', 'XC6']);
    const snap = deserializeProject(p);
    assert.equal(snap.entries[0].audioUrl, 'https://xeno-canto.org/5/download');
    assert.equal(serializeProject(sampleSnapshot(), { id: 'p', name: 'n' }, NOW).recordings[0].xcId, 'XC928094');
    assert.equal(xcRecordingPath('XC12'), 'xc/XC12.mp3');
    assert.deepEqual(filesNotInProject([{ path: 'xc/XC5.mp3' }, { path: 'xc/XC9.mp3' }], [{ xcId: 'XC5' }]).map((f) => f.path), ['xc/XC9.mp3']);
});

test('RecordingManager normalizes XC IDs on add, update, assign and lookup', () => {
    const rm = new RecordingManager();
    rm.clear();
    const a = rm.add({ xcId: '0928094', audioUrl: 'https://xeno-canto.org/928094/download' });
    assert.equal(a.xcId, 'XC928094');
    assert.equal(rm.findByXcId('928094'), a);
    assert.equal(rm.findByXcId('xc928094'), a);
    const f = rm.add({ filename: 'f.wav', audioUrl: 'blob:x', isBlobUrl: true });
    assert.equal(rm.assignXcId(f.id, '12'), true);
    assert.equal(rm.getById(f.id).xcId, 'XC12');
    assert.equal(rm.assignXcId(f.id, 'abc'), false);
    assert.equal(rm.assignXcId(f.id, ''), true);
    assert.equal(rm.getById(f.id).xcId, null);
    rm.update(f.id, { xcId: 77 });
    assert.equal(rm.getById(f.id).xcId, 'XC77');
});
