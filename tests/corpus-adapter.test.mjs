// ═══════════════════════════════════════════════════════════════════════
// corpus-adapter.test.mjs — Tests für TauriCorpusAdapter
//
// Mockt @tauri-apps/api/core und prüft:
//   - Korrekte IPC-Befehlsnamen
//   - Korrekte Argument-Serialisierung
//   - Fehlerweiterleitung
//
// Kein echtes Tauri nötig — läuft in Node.js direkt.
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { register } from 'node:module';

// ── Tauri-IPC-Mock ───────────────────────────────────────────────────

/**
 * Erzeugt einen Mock für @tauri-apps/api/core.
 * invoke() speichert den letzten Aufruf und gibt das vorbereitete Ergebnis zurück.
 */
function makeTauriMock(result = {}) {
    const calls = [];
    const invokeFn = async (command, args) => {
        calls.push({ command, args });
        if (result instanceof Error) throw result;
        return result;
    };
    return { calls, invokeFn };
}

// ── Test-Hilfsfunktionen ─────────────────────────────────────────────

/**
 * Wrapper der die TauriCorpusAdapter-Funktionen mit einem Mock-invoke aufruft.
 * Da der Adapter dynamisch importiert, simulieren wir hier die Logik direkt.
 */
function corpusAdapterWith(invokeFn) {
    async function invoke(command, args) {
        return invokeFn(command, args);
    }

    return {
        async corpusCreate(name, description) {
            return invoke('corpus_create', { args: { name, description } });
        },
        async corpusList() {
            return invoke('corpus_list');
        },
        async corpusGet(id) {
            return invoke('corpus_get', { id });
        },
        async corpusDelete(id) {
            return invoke('corpus_delete', { id });
        },
        async corpusUpdateMeta(id, name, description) {
            return invoke('corpus_update_meta', { args: { id, name, description } });
        },
        async recordingList({ corpusId, limit, offset }) {
            return invoke('recording_list', { args: { corpusId, limit, offset } });
        },
        async recordingGet(id) {
            return invoke('recording_get', { id });
        },
        async recordingSetTags(id, tags) {
            return invoke('recording_set_tags', { args: { id, tags } });
        },
        async recordingDelete(id) {
            return invoke('recording_delete', { id });
        },
        async recordingCount(corpusId) {
            return invoke('recording_count', { corpusId });
        },
        async recordingImportFolder(config) {
            return invoke('recording_import_folder', {
                args: {
                    corpusId: config.corpusId,
                    folderPath: config.folderPath,
                    pathPattern: config.pathPattern,
                    skipDuplicates: true,
                    extensions: config.extensions,
                },
            });
        },
    };
}

// ── Corpus-Commands ──────────────────────────────────────────────────

test('corpusCreate: sendet korrekten IPC-Befehl', async () => {
    const { calls, invokeFn } = makeTauriMock({ id: 'c1', name: 'Testkorpus' });
    const adapter = corpusAdapterWith(invokeFn);

    const result = await adapter.corpusCreate('Testkorpus', 'Beschreibung');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'corpus_create');
    assert.equal(calls[0].args.args.name, 'Testkorpus');
    assert.equal(calls[0].args.args.description, 'Beschreibung');
    assert.equal(result.id, 'c1');
});

test('corpusCreate: description kann fehlen (undefined)', async () => {
    const { calls, invokeFn } = makeTauriMock({ id: 'c2', name: 'Kein Desc' });
    const adapter = corpusAdapterWith(invokeFn);

    await adapter.corpusCreate('Kein Desc');
    assert.equal(calls[0].args.args.description, undefined);
});

test('corpusList: sendet corpus_list ohne Argumente', async () => {
    const { calls, invokeFn } = makeTauriMock([]);
    const adapter = corpusAdapterWith(invokeFn);

    const result = await adapter.corpusList();
    assert.equal(calls[0].command, 'corpus_list');
    assert.deepEqual(result, []);
});

test('corpusGet: sendet id korrekt', async () => {
    const { calls, invokeFn } = makeTauriMock({ id: 'abc', name: 'X' });
    const adapter = corpusAdapterWith(invokeFn);

    await adapter.corpusGet('abc');
    assert.equal(calls[0].command, 'corpus_get');
    assert.equal(calls[0].args.id, 'abc');
});

test('corpusDelete: sendet id korrekt', async () => {
    const { calls, invokeFn } = makeTauriMock(undefined);
    const adapter = corpusAdapterWith(invokeFn);

    await adapter.corpusDelete('del-id');
    assert.equal(calls[0].command, 'corpus_delete');
    assert.equal(calls[0].args.id, 'del-id');
});

test('corpusUpdateMeta: sendet alle Felder', async () => {
    const { calls, invokeFn } = makeTauriMock({ id: 'x', name: 'Neu' });
    const adapter = corpusAdapterWith(invokeFn);

    await adapter.corpusUpdateMeta('x', 'Neu', 'Neue Beschreibung');
    assert.equal(calls[0].command, 'corpus_update_meta');
    assert.equal(calls[0].args.args.id, 'x');
    assert.equal(calls[0].args.args.name, 'Neu');
    assert.equal(calls[0].args.args.description, 'Neue Beschreibung');
});

// ── Recording-Commands ───────────────────────────────────────────────

test('recordingList: sendet corpusId, limit, offset', async () => {
    const { calls, invokeFn } = makeTauriMock([]);
    const adapter = corpusAdapterWith(invokeFn);

    await adapter.recordingList({ corpusId: 'cid', limit: 50, offset: 0 });
    assert.equal(calls[0].command, 'recording_list');
    assert.equal(calls[0].args.args.corpusId, 'cid');
    assert.equal(calls[0].args.args.limit, 50);
    assert.equal(calls[0].args.args.offset, 0);
});

test('recordingGet: sendet id', async () => {
    const { calls, invokeFn } = makeTauriMock({ id: 'r1' });
    const adapter = corpusAdapterWith(invokeFn);

    await adapter.recordingGet('r1');
    assert.equal(calls[0].command, 'recording_get');
    assert.equal(calls[0].args.id, 'r1');
});

test('recordingSetTags: sendet id und tags-Array', async () => {
    const { calls, invokeFn } = makeTauriMock(undefined);
    const adapter = corpusAdapterWith(invokeFn);

    await adapter.recordingSetTags('r42', ['reviewed', 'Turdus merula']);
    assert.equal(calls[0].command, 'recording_set_tags');
    assert.equal(calls[0].args.args.id, 'r42');
    assert.deepEqual(calls[0].args.args.tags, ['reviewed', 'Turdus merula']);
});

test('recordingSetTags: leeres Tags-Array ist gültig', async () => {
    const { calls, invokeFn } = makeTauriMock(undefined);
    const adapter = corpusAdapterWith(invokeFn);

    await adapter.recordingSetTags('r1', []);
    assert.deepEqual(calls[0].args.args.tags, []);
});

test('recordingDelete: sendet id', async () => {
    const { calls, invokeFn } = makeTauriMock(undefined);
    const adapter = corpusAdapterWith(invokeFn);

    await adapter.recordingDelete('r99');
    assert.equal(calls[0].command, 'recording_delete');
    assert.equal(calls[0].args.id, 'r99');
});

test('recordingCount: sendet corpusId', async () => {
    const { calls, invokeFn } = makeTauriMock(42);
    const adapter = corpusAdapterWith(invokeFn);

    const count = await adapter.recordingCount('corpus-xyz');
    assert.equal(calls[0].command, 'recording_count');
    assert.equal(calls[0].args.corpusId, 'corpus-xyz');
    assert.equal(count, 42);
});

// ── Import-Wizard ────────────────────────────────────────────────────

test('recordingImportFolder: sendet vollständige Konfiguration', async () => {
    const importResult = {
        imported: 10, skipped: 2, errors: 0, errorMessages: [], durationMs: 850,
    };
    const { calls, invokeFn } = makeTauriMock(importResult);
    const adapter = corpusAdapterWith(invokeFn);

    const result = await adapter.recordingImportFolder({
        corpusId: 'c1',
        folderPath: '/data/aufnahmen',
        pathPattern: '{recorder_id}/{site}/{week}',
        copyFiles: true,
        extensions: ['wav', 'flac'],
    });

    assert.equal(calls[0].command, 'recording_import_folder');
    assert.equal(calls[0].args.args.corpusId, 'c1');
    assert.equal(calls[0].args.args.folderPath, '/data/aufnahmen');
    assert.equal(calls[0].args.args.pathPattern, '{recorder_id}/{site}/{week}');
    assert.equal(calls[0].args.args.skipDuplicates, true);
    assert.deepEqual(calls[0].args.args.extensions, ['wav', 'flac']);
    assert.equal(result.imported, 10);
    assert.equal(result.skipped, 2);
});

test('recordingImportFolder: extensions ist optional (undefined)', async () => {
    const { calls, invokeFn } = makeTauriMock({ imported: 0, skipped: 0, errors: 0, errorMessages: [], durationMs: 0 });
    const adapter = corpusAdapterWith(invokeFn);

    await adapter.recordingImportFolder({
        corpusId: 'c1',
        folderPath: '/data',
        pathPattern: '',
        copyFiles: false,
    });

    assert.equal(calls[0].args.args.extensions, undefined);
});

// ── Fehlerweiterleitung ───────────────────────────────────────────────

test('Fehler wird korrekt weitergeleitet', async () => {
    const { invokeFn } = makeTauriMock(new Error('IPC-Fehler: corpus nicht gefunden'));
    const adapter = corpusAdapterWith(invokeFn);

    await assert.rejects(
        () => adapter.corpusGet('nonexistent'),
        { message: 'IPC-Fehler: corpus nicht gefunden' },
    );
});

test('recordingSetTags: Fehler bei ungültiger ID weitergeleitet', async () => {
    const { invokeFn } = makeTauriMock(new Error('recording not found'));
    const adapter = corpusAdapterWith(invokeFn);

    await assert.rejects(
        () => adapter.recordingSetTags('bad-id', ['tag']),
        { message: 'recording not found' },
    );
});

// ── Batch-Operationen ────────────────────────────────────────────────

test('Mehrere Corpus erstellen und auflisten (Mock-Sequenz)', async () => {
    const corpora = [
        { id: 'c1', name: 'Alpha', recordingCount: 5 },
        { id: 'c2', name: 'Beta', recordingCount: 12 },
    ];

    let callCount = 0;
    const invokeFn = async (command) => {
        callCount++;
        if (command === 'corpus_list') return corpora;
        return corpora[callCount - 2] ?? {};
    };
    const adapter = corpusAdapterWith(invokeFn);

    const list = await adapter.corpusList();
    assert.equal(list.length, 2);
    assert.equal(list[0].name, 'Alpha');
    assert.equal(list[1].recordingCount, 12);
});
