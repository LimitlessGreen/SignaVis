// ═══════════════════════════════════════════════════════════════════════
// corpus-types.test.mjs — Tests für das Dataset-Domänenmodell (v2)
//
// Prüft: Typkonstruktion, Validierungshelfer, ViewStage-Logik.
// Keine Abhängigkeit auf Tauri — läuft in Node.js direkt.
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

// ── Hilfsfunktionen (analog zu Produktionscode) ───────────────────────

/** Erstellt ein minimales Recording-Objekt. */
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

/** Erstellt ein minimales Dataset-Objekt. */
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

test('Recording: Basis-Felder vorhanden', () => {
    const rec = makeRecording();
    assert.equal(rec.id, 'rec-001');
    assert.equal(rec.datasetId, 'dataset-001');
    assert.equal(rec.filepath, '/audio/test.wav');
    assert.deepEqual(rec.tags, []);
});

test('Recording: Metadaten-Struktur korrekt', () => {
    const rec = makeRecording();
    assert.equal(rec.metadata.sampleRate, 48000);
    assert.equal(rec.metadata.numChannels, 1);
    assert.equal(rec.metadata.mimeType, 'audio/wav');
    assert.equal(rec.metadata.duration, 10.5);
});

test('Recording: Tags können gesetzt werden', () => {
    const rec = makeRecording({ tags: ['reviewed', 'Turdus merula'] });
    assert.equal(rec.tags.length, 2);
    assert.ok(rec.tags.includes('reviewed'));
    assert.ok(rec.tags.includes('Turdus merula'));
});

test('Recording: fields-Objekt akzeptiert beliebige Schlüssel', () => {
    const rec = makeRecording({
        fields: { recorder_id: 'SM4-01', site: 'Forest_A', week: '2024-W03' },
    });
    assert.equal(rec.fields.recorder_id, 'SM4-01');
    assert.equal(rec.fields.site, 'Forest_A');
});

// ── Dataset ───────────────────────────────────────────────────────────

test('Dataset: Basis-Felder vorhanden', () => {
    const c = makeDataset();
    assert.equal(c.id, 'dataset-001');
    assert.equal(c.name, 'Test Dataset');
    assert.equal(c.mediaType, 'audio');
    assert.equal(c.recordingCount, 0);
    assert.deepEqual(c.fieldSchema, []);
    assert.deepEqual(c.knownTags, []);
});

test('Dataset: description ist optional', () => {
    const c1 = makeDataset();
    assert.equal(c1.description, undefined);

    const c2 = makeDataset({ description: 'Freilandaufnahmen 2024' });
    assert.equal(c2.description, 'Freilandaufnahmen 2024');
});

test('Dataset: knownTags können befüllt sein', () => {
    const c = makeDataset({ knownTags: ['reviewed', 'exported', 'low-quality'] });
    assert.equal(c.knownTags.length, 3);
    assert.ok(c.knownTags.includes('low-quality'));
});

// ── ViewStage-Logik ──────────────────────────────────────────────────

/** Minimale ViewStage-Implementierung für Tests. */
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

test('ViewStage: match_tags filtert korrekt', () => {
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

test('ViewStage: match_tags mit leerem Array gibt alle zurück', () => {
    const recs = [makeRecording({ id: 'r1' }), makeRecording({ id: 'r2' })];
    const stage = makeTagStage([]);
    const result = applyTagFilter(recs, stage);
    assert.equal(result.length, 2);
});

test('ViewStage: match_tags mit mehreren Tags AND-verknüpft', () => {
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

test('ViewStage: filter_field eq filtert korrekt', () => {
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

test('ViewStage: filter_field gte filtert numerisch', () => {
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

// ── Pfad-Muster-Extraktion (path-pattern) ────────────────────────────

/**
 * Extrahiert Felder aus einem Dateipfad anhand eines Musters.
 * Das Muster bezieht sich auf die VERZEICHNISSTRUKTUR relativ zum Import-Ordner.
 * Muster: "{recorder_id}/{site}/{week}" → passt auf SM4-01/Forest_A/2024-W03/file.wav
 *
 * Spiegelt recordings.rs:extract_path_fields() — matcht von vorne (ohne Dateinamen).
 * `baseDir` entspricht dem Import-Basisordner.
 */
function extractPathFields(filepath, pattern, baseDir = '') {
    if (!pattern) return {};

    const normPath = filepath.replace(/\\/g, '/');
    const normBase = baseDir.replace(/\\/g, '/').replace(/\/?$/, '/');

    // Relativen Pfad berechnen
    const relPath = normBase && normPath.startsWith(normBase)
        ? normPath.slice(normBase.length)
        : normPath.replace(/^\//, '');

    // Verzeichniskomponenten (ohne Dateiname = letztes Segment)
    const allParts = relPath.split('/').filter(Boolean);
    const dirParts = allParts.slice(0, -1); // Dateiname entfernen

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

test('Pfad-Muster: einfaches Muster extrahiert Felder', () => {
    const fields = extractPathFields(
        '/data/SM4-01/Forest_A/2024-W03/20240115_063000.wav',
        '{recorder_id}/{site}/{week}',
        '/data',
    );
    assert.equal(fields.recorder_id, 'SM4-01');
    assert.equal(fields.site, 'Forest_A');
    assert.equal(fields.week, '2024-W03');
});

test('Pfad-Muster: leeres Muster ergibt leeres Objekt', () => {
    const fields = extractPathFields('/data/test.wav', '', '/data');
    assert.deepEqual(fields, {});
});

test('Pfad-Muster: Muster kürzer als Pfad — nur erste N Verzeichnisse', () => {
    const fields = extractPathFields('/data/SM4-01/Forest_A/week3/file.wav', '{recorder}/{site}', '/data');
    assert.equal(fields.recorder, 'SM4-01');
    assert.equal(fields.site, 'Forest_A');
});

test('Pfad-Muster: statische Segmente werden ignoriert (kein Platzhalter)', () => {
    // "recordings" ist kein {..} Platzhalter — wird übersprungen, kein Eintrag
    const fields = extractPathFields('/data/recordings/SM4-01/Forest_A/audio.wav', 'recordings/{recorder}/{site}', '/data');
    assert.equal(fields.recorder, 'SM4-01');
    assert.equal(fields.site, 'Forest_A');
    assert.equal(fields.recordings, undefined);
});

// ── SoundEvents / Classifications ────────────────────────────────────

test('SoundEvent: support ist [start, end] in Sekunden', () => {
    const evt = { label: 'Turdus merula', confidence: 0.92, support: [3.0, 6.0] };
    assert.equal(evt.support[0], 3.0);
    assert.equal(evt.support[1], 6.0);
    assert.ok(evt.confidence > 0 && evt.confidence <= 1);
});

test('Classification: confidence im Bereich 0–1', () => {
    const cls = { label: 'Parus major', confidence: 0.87 };
    assert.ok(cls.confidence >= 0 && cls.confidence <= 1);
    assert.equal(cls.label, 'Parus major');
});

test('Classifications: mehrere Labels möglich', () => {
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

// ── ImportResult ─────────────────────────────────────────────────────

test('ImportResult: Zähler korrekt', () => {
    const result = {
        imported: 42,
        skipped: 5,
        errors: 1,
        errorMessages: ['Datei nicht lesbar: /audio/corrupt.wav'],
        durationMs: 1230,
    };
    assert.equal(result.imported + result.skipped + result.errors, 48);
    assert.equal(result.errorMessages.length, result.errors);
});

test('ImportResult: leere errorMessages bei 0 Fehlern', () => {
    const result = { imported: 10, skipped: 0, errors: 0, errorMessages: [], durationMs: 500 };
    assert.equal(result.errors, 0);
    assert.deepEqual(result.errorMessages, []);
});
