// ═══════════════════════════════════════════════════════════════════════
// corpus-types.test.mjs — Tests for the dataset domain model (v2)
//
// Checks: type construction, validation helpers, ViewStage logic.
// No dependency on Tauri — runs directly in Node.js.
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

// ── Helper functions (analogous to production code) ───────────────────

/** Creates a minimal Recording object. */
function makeRecording(overrides = {}) {
    return {
        id: 'rec-001',
        datasetId: 'dataset-001',
        filepath: '/audio/test.wav',
        tags: [],
        metadata: {
            duration: 10.5,
            sampleRate: 48000,
            numChannels: 1,
            sizeBytes: 1_048_576,
            mimeType: 'audio/wav',
        },
        importedAt: Date.now(),
        fields: {},
        ...overrides,
    };
}

/** Creates a minimal Dataset object. */
function makeDataset(overrides = {}) {
    return {
        id: 'dataset-001',
        name: 'Test Dataset',
        mediaType: 'audio',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        recordingCount: 0,
        fieldSchema: [],
        knownTags: [],
        ...overrides,
    };
}

// ── Recording ────────────────────────────────────────────────────────

test('Recording: base fields present', () => {
    const rec = makeRecording();
    assert.equal(rec.id, 'rec-001');
    assert.equal(rec.datasetId, 'dataset-001');
    assert.equal(rec.filepath, '/audio/test.wav');
    assert.deepEqual(rec.tags, []);
});

test('Recording: metadata structure correct', () => {
    const rec = makeRecording();
    assert.equal(rec.metadata.sampleRate, 48000);
    assert.equal(rec.metadata.numChannels, 1);
    assert.equal(rec.metadata.mimeType, 'audio/wav');
    assert.equal(rec.metadata.duration, 10.5);
});

test('Recording: tags can be set', () => {
    const rec = makeRecording({ tags: ['reviewed', 'Turdus merula'] });
    assert.equal(rec.tags.length, 2);
    assert.ok(rec.tags.includes('reviewed'));
    assert.ok(rec.tags.includes('Turdus merula'));
});

test('Recording: fields object accepts arbitrary keys', () => {
    const rec = makeRecording({
        fields: { recorder_id: 'SM4-01', site: 'Forest_A', week: '2024-W03' },
    });
    assert.equal(rec.fields.recorder_id, 'SM4-01');
    assert.equal(rec.fields.site, 'Forest_A');
});

// ── Dataset ───────────────────────────────────────────────────────────

test('Dataset: base fields present', () => {
    const c = makeDataset();
    assert.equal(c.id, 'dataset-001');
    assert.equal(c.name, 'Test Dataset');
    assert.equal(c.mediaType, 'audio');
    assert.equal(c.recordingCount, 0);
    assert.deepEqual(c.fieldSchema, []);
    assert.deepEqual(c.knownTags, []);
});

test('Dataset: description is optional', () => {
    const c1 = makeDataset();
    assert.equal(c1.description, undefined);

    const c2 = makeDataset({ description: 'Field recordings 2024' });
    assert.equal(c2.description, 'Field recordings 2024');
});

test('Dataset: knownTags can be populated', () => {
    const c = makeDataset({ knownTags: ['reviewed', 'exported', 'low-quality'] });
    assert.equal(c.knownTags.length, 3);
    assert.ok(c.knownTags.includes('low-quality'));
});

// ── ViewStage logic ───────────────────────────────────────────────────

/** Minimal ViewStage implementation for tests. */
function makeFilterStage(field, op, value) {
    return { kind: 'filter_field', params: { field, op, value } };
}

function makeTagStage(tags) {
    return { kind: 'match_tags', params: { tags } };
}

function applyTagFilter(recordings, stage) {
    if (!stage.params.tags?.length) return recordings;
    return recordings.filter((r) => stage.params.tags.every((t) => r.tags.includes(t)));
}

function applyFieldFilter(recordings, stage) {
    const { field, op, value } = stage.params;
    return recordings.filter((r) => {
        const v = r.fields?.[field] ?? r.metadata?.[field];
        if (op === 'eq') return v === value;
        if (op === 'neq') return v !== value;
        if (op === 'gte') return v >= value;
        if (op === 'lte') return v <= value;
        return true;
    });
}

test('ViewStage: match_tags filters correctly', () => {
    const recs = [
        makeRecording({ id: 'r1', tags: ['reviewed'] }),
        makeRecording({ id: 'r2', tags: ['reviewed', 'exported'] }),
        makeRecording({ id: 'r3', tags: [] }),
    ];
    const stage = makeTagStage(['reviewed']);
    const result = applyTagFilter(recs, stage);
    assert.equal(result.length, 2);
    assert.ok(result.every((r) => r.tags.includes('reviewed')));
});

test('ViewStage: match_tags with empty array returns all', () => {
    const recs = [makeRecording({ id: 'r1' }), makeRecording({ id: 'r2' })];
    const stage = makeTagStage([]);
    const result = applyTagFilter(recs, stage);
    assert.equal(result.length, 2);
});

test('ViewStage: match_tags with multiple tags uses AND logic', () => {
    const recs = [
        makeRecording({ id: 'r1', tags: ['reviewed', 'exported'] }),
        makeRecording({ id: 'r2', tags: ['reviewed'] }),
        makeRecording({ id: 'r3', tags: ['exported'] }),
    ];
    const stage = makeTagStage(['reviewed', 'exported']);
    const result = applyTagFilter(recs, stage);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'r1');
});

test('ViewStage: filter_field eq filters correctly', () => {
    const recs = [
        makeRecording({ id: 'r1', fields: { site: 'Forest_A' } }),
        makeRecording({ id: 'r2', fields: { site: 'Forest_B' } }),
        makeRecording({ id: 'r3', fields: { site: 'Forest_A' } }),
    ];
    const stage = makeFilterStage('site', 'eq', 'Forest_A');
    const result = applyFieldFilter(recs, stage);
    assert.equal(result.length, 2);
    assert.ok(result.every((r) => r.fields.site === 'Forest_A'));
});

test('ViewStage: filter_field gte filters numerically', () => {
    const recs = [
        makeRecording({ id: 'r1', fields: { snr: 5.0 } }),
        makeRecording({ id: 'r2', fields: { snr: 12.0 } }),
        makeRecording({ id: 'r3', fields: { snr: 8.5 } }),
    ];
    const stage = makeFilterStage('snr', 'gte', 8.0);
    const result = applyFieldFilter(recs, stage);
    assert.equal(result.length, 2);
    assert.ok(result.every((r) => r.fields.snr >= 8.0));
});

// ── Path pattern extraction (path-pattern) ────────────────────────────

/**
 * Extracts fields from a file path according to a pattern.
 * The pattern refers to the DIRECTORY STRUCTURE relative to the import folder.
 * Pattern: "{recorder_id}/{site}/{week}" → matches SM4-01/Forest_A/2024-W03/file.wav
 *
 * Mirrors recordings.rs:extract_path_fields() — matches from the front (excluding filename).
 * `baseDir` corresponds to the import base folder.
 */
function extractPathFields(filepath, pattern, baseDir = '') {
    if (!pattern) return {};

    const normPath = filepath.replace(/\\/g, '/');
    const normBase = baseDir.replace(/\\/g, '/').replace(/\/?$/, '/');

    // Compute relative path
    const relPath = normBase && normPath.startsWith(normBase)
        ? normPath.slice(normBase.length)
        : normPath.replace(/^\//, '');

    // Directory components (excluding filename = last segment)
    const allParts = relPath.split('/').filter(Boolean);
    const dirParts = allParts.slice(0, -1); // remove filename

    const patternParts = pattern.split('/').filter(Boolean);
    const fields = {};

    for (let i = 0; i < Math.min(patternParts.length, dirParts.length); i++) {
        const pp = patternParts[i];
        const match = pp.match(/^\{(\w+)\}$/);
        if (match) {
            fields[match[1]] = dirParts[i];
        }
    }
    return fields;
}

test('Path pattern: simple pattern extracts fields', () => {
    const fields = extractPathFields(
        '/data/SM4-01/Forest_A/2024-W03/20240115_063000.wav',
        '{recorder_id}/{site}/{week}',
        '/data',
    );
    assert.equal(fields.recorder_id, 'SM4-01');
    assert.equal(fields.site, 'Forest_A');
    assert.equal(fields.week, '2024-W03');
});

test('Path pattern: empty pattern yields empty object', () => {
    const fields = extractPathFields('/data/test.wav', '', '/data');
    assert.deepEqual(fields, {});
});

test('Path pattern: pattern shorter than path — only first N directories', () => {
    const fields = extractPathFields('/data/SM4-01/Forest_A/week3/file.wav', '{recorder}/{site}', '/data');
    assert.equal(fields.recorder, 'SM4-01');
    assert.equal(fields.site, 'Forest_A');
});

test('Path pattern: static segments are ignored (no placeholder)', () => {
    // "recordings" is not a {..} placeholder — it is skipped, no entry
    const fields = extractPathFields('/data/recordings/SM4-01/Forest_A/audio.wav', 'recordings/{recorder}/{site}', '/data');
    assert.equal(fields.recorder, 'SM4-01');
    assert.equal(fields.site, 'Forest_A');
    assert.equal(fields.recordings, undefined);
});

// ── SoundEvents / Classifications ─────────────────────────────────────

test('SoundEvent: support is [start, end] in seconds', () => {
    const evt = { label: 'Turdus merula', confidence: 0.92, support: [3.0, 6.0] };
    assert.equal(evt.support[0], 3.0);
    assert.equal(evt.support[1], 6.0);
    assert.ok(evt.confidence > 0 && evt.confidence <= 1);
});

test('Classification: confidence in range 0–1', () => {
    const cls = { label: 'Parus major', confidence: 0.87 };
    assert.ok(cls.confidence >= 0 && cls.confidence <= 1);
    assert.equal(cls.label, 'Parus major');
});

test('Classifications: multiple labels possible', () => {
    const clss = {
        classifications: [
            { label: 'Turdus merula', confidence: 0.92 },
            { label: 'Erithacus rubecula', confidence: 0.45 },
        ],
    };
    assert.equal(clss.classifications.length, 2);
    const sorted = [...clss.classifications].sort((a, b) => b.confidence - a.confidence);
    assert.equal(sorted[0].label, 'Turdus merula');
});

// ── ImportResult ──────────────────────────────────────────────────────

test('ImportResult: counters correct', () => {
    const result = {
        imported: 42,
        skipped: 5,
        errors: 1,
        errorMessages: ['File not readable: /audio/corrupt.wav'],
        durationMs: 1230,
    };
    assert.equal(result.imported + result.skipped + result.errors, 48);
    assert.equal(result.errorMessages.length, result.errors);
});

test('ImportResult: empty errorMessages when 0 errors', () => {
    const result = { imported: 10, skipped: 0, errors: 0, errorMessages: [], durationMs: 500 };
    assert.equal(result.errors, 0);
    assert.deepEqual(result.errorMessages, []);
});
