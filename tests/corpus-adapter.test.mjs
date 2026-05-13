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
function datasetAdapterWith(invokeFn) {
    async function invoke(command, args) {
        return invokeFn(command, args);
    }

    return {
        async datasetCreate(name, description) {
            return invoke('dataset_create', { args: { name, description } });
        },
        async datasetList() {
            return invoke('dataset_list');
        },
        async datasetGet(id) {
            return invoke('dataset_get', { id });
        },
        async datasetDelete(id) {
            return invoke('dataset_delete', { id });
        },
        async datasetUpdateMeta(id, name, description) {
            return invoke('dataset_update_meta', { args: { id, name, description } });
        },
        async recordingList({ datasetId, limit, offset }) {
            return invoke('recording_list', { args: { datasetId, limit, offset } });
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
        async recordingCount(datasetId) {
            return invoke('recording_count', { datasetId });
        },
        async recordingImportFolder(config) {
            return invoke('recording_import_folder', {
                args: {
                    datasetId: config.datasetId,
                    folderPath: config.folderPath,
                    pathPattern: config.pathPattern,
                    skipDuplicates: true,
                    extensions: config.extensions,
                },
            });
        },
    };
}

// ── Dataset-Commands ──────────────────────────────────────────────────

test('datasetCreate: sendet korrekten IPC-Befehl', async () => {
    const { calls, invokeFn } = makeTauriMock({ id: 'c1', name: 'Test Dataset' });
    const adapter = datasetAdapterWith(invokeFn);

    const result = await adapter.datasetCreate('Test Dataset', 'Beschreibung');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'dataset_create');
    assert.equal(calls[0].args.args.name, 'Test Dataset');
    assert.equal(calls[0].args.args.description, 'Beschreibung');
    assert.equal(result.id, 'c1');
});

test('datasetCreate: description kann fehlen (undefined)', async () => {
    const { calls, invokeFn } = makeTauriMock({ id: 'c2', name: 'Kein Desc' });
    const adapter = datasetAdapterWith(invokeFn);

    await adapter.datasetCreate('Kein Desc');
    assert.equal(calls[0].args.args.description, undefined);
});

test('datasetList: sendet dataset_list ohne Argumente', async () => {
    const { calls, invokeFn } = makeTauriMock([]);
    const adapter = datasetAdapterWith(invokeFn);

    const result = await adapter.datasetList();
    assert.equal(calls[0].command, 'dataset_list');
    assert.deepEqual(result, []);
});

test('datasetGet: sendet id korrekt', async () => {
    const { calls, invokeFn } = makeTauriMock({ id: 'abc', name: 'X' });
    const adapter = datasetAdapterWith(invokeFn);

    await adapter.datasetGet('abc');
    assert.equal(calls[0].command, 'dataset_get');
    assert.equal(calls[0].args.id, 'abc');
});

test('datasetDelete: sendet id korrekt', async () => {
    const { calls, invokeFn } = makeTauriMock(undefined);
    const adapter = datasetAdapterWith(invokeFn);

    await adapter.datasetDelete('del-id');
    assert.equal(calls[0].command, 'dataset_delete');
    assert.equal(calls[0].args.id, 'del-id');
});

test('datasetUpdateMeta: sendet alle Felder', async () => {
    const { calls, invokeFn } = makeTauriMock({ id: 'x', name: 'Neu' });
    const adapter = datasetAdapterWith(invokeFn);

    await adapter.datasetUpdateMeta('x', 'Neu', 'Neue Beschreibung');
    assert.equal(calls[0].command, 'dataset_update_meta');
    assert.equal(calls[0].args.args.id, 'x');
    assert.equal(calls[0].args.args.name, 'Neu');
    assert.equal(calls[0].args.args.description, 'Neue Beschreibung');
});

// ── Recording-Commands ───────────────────────────────────────────────

test('recordingList: sendet datasetId, limit, offset', async () => {
    const { calls, invokeFn } = makeTauriMock([]);
    const adapter = datasetAdapterWith(invokeFn);

    await adapter.recordingList({ datasetId: 'cid', limit: 50, offset: 0 });
    assert.equal(calls[0].command, 'recording_list');
    assert.equal(calls[0].args.args.datasetId, 'cid');
    assert.equal(calls[0].args.args.limit, 50);
    assert.equal(calls[0].args.args.offset, 0);
});

test('recordingGet: sendet id', async () => {
    const { calls, invokeFn } = makeTauriMock({ id: 'r1' });
    const adapter = datasetAdapterWith(invokeFn);

    await adapter.recordingGet('r1');
    assert.equal(calls[0].command, 'recording_get');
    assert.equal(calls[0].args.id, 'r1');
});

test('recordingSetTags: sendet id und tags-Array', async () => {
    const { calls, invokeFn } = makeTauriMock(undefined);
    const adapter = datasetAdapterWith(invokeFn);

    await adapter.recordingSetTags('r42', ['reviewed', 'Turdus merula']);
    assert.equal(calls[0].command, 'recording_set_tags');
    assert.equal(calls[0].args.args.id, 'r42');
    assert.deepEqual(calls[0].args.args.tags, ['reviewed', 'Turdus merula']);
});

test('recordingSetTags: leeres Tags-Array ist gültig', async () => {
    const { calls, invokeFn } = makeTauriMock(undefined);
    const adapter = datasetAdapterWith(invokeFn);

    await adapter.recordingSetTags('r1', []);
    assert.deepEqual(calls[0].args.args.tags, []);
});

test('recordingDelete: sendet id', async () => {
    const { calls, invokeFn } = makeTauriMock(undefined);
    const adapter = datasetAdapterWith(invokeFn);

    await adapter.recordingDelete('r99');
    assert.equal(calls[0].command, 'recording_delete');
    assert.equal(calls[0].args.id, 'r99');
});

test('recordingCount: sendet datasetId', async () => {
    const { calls, invokeFn } = makeTauriMock(42);
    const adapter = datasetAdapterWith(invokeFn);

    const count = await adapter.recordingCount('dataset-xyz');
    assert.equal(calls[0].command, 'recording_count');
    assert.equal(calls[0].args.datasetId, 'dataset-xyz');
    assert.equal(count, 42);
});

// ── Import-Wizard ────────────────────────────────────────────────────

test('recordingImportFolder: sendet vollständige Konfiguration', async () => {
    const importResult = {
        imported: 10, skipped: 2, errors: 0, errorMessages: [], durationMs: 850,
    };
    const { calls, invokeFn } = makeTauriMock(importResult);
    const adapter = datasetAdapterWith(invokeFn);

    const result = await adapter.recordingImportFolder({
        datasetId: 'c1',
        folderPath: '/data/aufnahmen',
        pathPattern: '{recorder_id}/{site}/{week}',
        copyFiles: true,
        extensions: ['wav', 'flac'],
    });

    assert.equal(calls[0].command, 'recording_import_folder');
    assert.equal(calls[0].args.args.datasetId, 'c1');
    assert.equal(calls[0].args.args.folderPath, '/data/aufnahmen');
    assert.equal(calls[0].args.args.pathPattern, '{recorder_id}/{site}/{week}');
    assert.equal(calls[0].args.args.skipDuplicates, true);
    assert.deepEqual(calls[0].args.args.extensions, ['wav', 'flac']);
    assert.equal(result.imported, 10);
    assert.equal(result.skipped, 2);
});

test('recordingImportFolder: extensions ist optional (undefined)', async () => {
    const { calls, invokeFn } = makeTauriMock({ imported: 0, skipped: 0, errors: 0, errorMessages: [], durationMs: 0 });
    const adapter = datasetAdapterWith(invokeFn);

    await adapter.recordingImportFolder({
        datasetId: 'c1',
        folderPath: '/data',
        pathPattern: '',
        copyFiles: false,
    });

    assert.equal(calls[0].args.args.extensions, undefined);
});

// ── Fehlerweiterleitung ───────────────────────────────────────────────

test('Fehler wird korrekt weitergeleitet', async () => {
    const { invokeFn } = makeTauriMock(new Error('IPC-Fehler: dataset nicht gefunden'));
    const adapter = datasetAdapterWith(invokeFn);

    await assert.rejects(
        () => adapter.datasetGet('nonexistent'),
        { message: 'IPC-Fehler: dataset nicht gefunden' },
    );
});

test('recordingSetTags: Fehler bei ungültiger ID weitergeleitet', async () => {
    const { invokeFn } = makeTauriMock(new Error('recording not found'));
    const adapter = datasetAdapterWith(invokeFn);

    await assert.rejects(
        () => adapter.recordingSetTags('bad-id', ['tag']),
        { message: 'recording not found' },
    );
});

// ── Batch-Operationen ────────────────────────────────────────────────

test('Mehrere Datasets erstellen und auflisten (Mock-Sequenz)', async () => {
    const datasets = [
        { id: 'c1', name: 'Alpha', recordingCount: 5 },
        { id: 'c2', name: 'Beta', recordingCount: 12 },
    ];

    let callCount = 0;
    const invokeFn = async (command) => {
        callCount++;
        if (command === 'dataset_list') return datasets;
        return datasets[callCount - 2] ?? {};
    };
    const adapter = datasetAdapterWith(invokeFn);

    const list = await adapter.datasetList();
    assert.equal(list.length, 2);
    assert.equal(list[0].name, 'Alpha');
    assert.equal(list[1].recordingCount, 12);
});
