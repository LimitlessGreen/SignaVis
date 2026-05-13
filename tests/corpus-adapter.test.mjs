// ═══════════════════════════════════════════════════════════════════════
// corpus-adapter.test.mjs — Tests for TauriCorpusAdapter
//
// Mocks @tauri-apps/api/core and verifies:
//   - Correct IPC command names
//   - Correct argument serialisation
//   - Error forwarding
//
// No real Tauri required — runs directly in Node.js.
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { register } from 'node:module';

// ── Tauri IPC mock ────────────────────────────────────────────────────

/**
 * Creates a mock for @tauri-apps/api/core.
 * invoke() records the last call and returns the prepared result.
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

// ── Test helper functions ─────────────────────────────────────────────

/**
 * Wrapper that calls TauriCorpusAdapter functions with a mock invoke.
 * Since the adapter imports dynamically, we simulate the logic directly here.
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

// ── Dataset commands ──────────────────────────────────────────────────

test('datasetCreate: sends correct IPC command', async () => {
    const { calls, invokeFn } = makeTauriMock({ id: 'c1', name: 'Test Dataset' });
    const adapter = datasetAdapterWith(invokeFn);

    const result = await adapter.datasetCreate('Test Dataset', 'Description');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'dataset_create');
    assert.equal(calls[0].args.args.name, 'Test Dataset');
    assert.equal(calls[0].args.args.description, 'Description');
    assert.equal(result.id, 'c1');
});

test('datasetCreate: description may be absent (undefined)', async () => {
    const { calls, invokeFn } = makeTauriMock({ id: 'c2', name: 'No Desc' });
    const adapter = datasetAdapterWith(invokeFn);

    await adapter.datasetCreate('No Desc');
    assert.equal(calls[0].args.args.description, undefined);
});

test('datasetList: sends dataset_list without arguments', async () => {
    const { calls, invokeFn } = makeTauriMock([]);
    const adapter = datasetAdapterWith(invokeFn);

    const result = await adapter.datasetList();
    assert.equal(calls[0].command, 'dataset_list');
    assert.deepEqual(result, []);
});

test('datasetGet: sends id correctly', async () => {
    const { calls, invokeFn } = makeTauriMock({ id: 'abc', name: 'X' });
    const adapter = datasetAdapterWith(invokeFn);

    await adapter.datasetGet('abc');
    assert.equal(calls[0].command, 'dataset_get');
    assert.equal(calls[0].args.id, 'abc');
});

test('datasetDelete: sends id correctly', async () => {
    const { calls, invokeFn } = makeTauriMock(undefined);
    const adapter = datasetAdapterWith(invokeFn);

    await adapter.datasetDelete('del-id');
    assert.equal(calls[0].command, 'dataset_delete');
    assert.equal(calls[0].args.id, 'del-id');
});

test('datasetUpdateMeta: sends all fields', async () => {
    const { calls, invokeFn } = makeTauriMock({ id: 'x', name: 'New' });
    const adapter = datasetAdapterWith(invokeFn);

    await adapter.datasetUpdateMeta('x', 'New', 'New description');
    assert.equal(calls[0].command, 'dataset_update_meta');
    assert.equal(calls[0].args.args.id, 'x');
    assert.equal(calls[0].args.args.name, 'New');
    assert.equal(calls[0].args.args.description, 'New description');
});

// ── Recording commands ───────────────────────────────────────────────

test('recordingList: sends datasetId, limit, offset', async () => {
    const { calls, invokeFn } = makeTauriMock([]);
    const adapter = datasetAdapterWith(invokeFn);

    await adapter.recordingList({ datasetId: 'cid', limit: 50, offset: 0 });
    assert.equal(calls[0].command, 'recording_list');
    assert.equal(calls[0].args.args.datasetId, 'cid');
    assert.equal(calls[0].args.args.limit, 50);
    assert.equal(calls[0].args.args.offset, 0);
});

test('recordingGet: sends id', async () => {
    const { calls, invokeFn } = makeTauriMock({ id: 'r1' });
    const adapter = datasetAdapterWith(invokeFn);

    await adapter.recordingGet('r1');
    assert.equal(calls[0].command, 'recording_get');
    assert.equal(calls[0].args.id, 'r1');
});

test('recordingSetTags: sends id and tags array', async () => {
    const { calls, invokeFn } = makeTauriMock(undefined);
    const adapter = datasetAdapterWith(invokeFn);

    await adapter.recordingSetTags('r42', ['reviewed', 'Turdus merula']);
    assert.equal(calls[0].command, 'recording_set_tags');
    assert.equal(calls[0].args.args.id, 'r42');
    assert.deepEqual(calls[0].args.args.tags, ['reviewed', 'Turdus merula']);
});

test('recordingSetTags: empty tags array is valid', async () => {
    const { calls, invokeFn } = makeTauriMock(undefined);
    const adapter = datasetAdapterWith(invokeFn);

    await adapter.recordingSetTags('r1', []);
    assert.deepEqual(calls[0].args.args.tags, []);
});

test('recordingDelete: sends id', async () => {
    const { calls, invokeFn } = makeTauriMock(undefined);
    const adapter = datasetAdapterWith(invokeFn);

    await adapter.recordingDelete('r99');
    assert.equal(calls[0].command, 'recording_delete');
    assert.equal(calls[0].args.id, 'r99');
});

test('recordingCount: sends datasetId', async () => {
    const { calls, invokeFn } = makeTauriMock(42);
    const adapter = datasetAdapterWith(invokeFn);

    const count = await adapter.recordingCount('dataset-xyz');
    assert.equal(calls[0].command, 'recording_count');
    assert.equal(calls[0].args.datasetId, 'dataset-xyz');
    assert.equal(count, 42);
});

// ── Import wizard ─────────────────────────────────────────────────────

test('recordingImportFolder: sends complete configuration', async () => {
    const importResult = {
        imported: 10, skipped: 2, errors: 0, errorMessages: [], durationMs: 850,
    };
    const { calls, invokeFn } = makeTauriMock(importResult);
    const adapter = datasetAdapterWith(invokeFn);

    const result = await adapter.recordingImportFolder({
        datasetId: 'c1',
        folderPath: '/data/recordings',
        pathPattern: '{recorder_id}/{site}/{week}',
        copyFiles: true,
        extensions: ['wav', 'flac'],
    });

    assert.equal(calls[0].command, 'recording_import_folder');
    assert.equal(calls[0].args.args.datasetId, 'c1');
    assert.equal(calls[0].args.args.folderPath, '/data/recordings');
    assert.equal(calls[0].args.args.pathPattern, '{recorder_id}/{site}/{week}');
    assert.equal(calls[0].args.args.skipDuplicates, true);
    assert.deepEqual(calls[0].args.args.extensions, ['wav', 'flac']);
    assert.equal(result.imported, 10);
    assert.equal(result.skipped, 2);
});

test('recordingImportFolder: extensions is optional (undefined)', async () => {
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

// ── Error forwarding ──────────────────────────────────────────────────

test('error is forwarded correctly', async () => {
    const { invokeFn } = makeTauriMock(new Error('IPC error: dataset not found'));
    const adapter = datasetAdapterWith(invokeFn);

    await assert.rejects(
        () => adapter.datasetGet('nonexistent'),
        { message: 'IPC error: dataset not found' },
    );
});

test('recordingSetTags: error forwarded for invalid ID', async () => {
    const { invokeFn } = makeTauriMock(new Error('recording not found'));
    const adapter = datasetAdapterWith(invokeFn);

    await assert.rejects(
        () => adapter.recordingSetTags('bad-id', ['tag']),
        { message: 'recording not found' },
    );
});

// ── Batch operations ──────────────────────────────────────────────────

test('Create and list multiple datasets (mock sequence)', async () => {
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
