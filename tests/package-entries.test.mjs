// The package entries are the public API: what types/index.d.ts declares must
// exist at runtime (before, the types promised MockAudioEngine, EventBus, …
// while the bundle did not export them).
import test from 'node:test';
import assert from 'node:assert/strict';

const full = await import('../src/index.ts');
const core = await import('../src/core.ts');

const CORE_VALUES = [
    'BirdNETPlayer', 'DEFAULT_OPTIONS',
    'readRecordingStart', 'isoClockTime', 'ravenClock', 'utcLabel', 'formatRecordingStart',
    'EventBus', 'AudioEngineBase', 'MockAudioEngine', 'StorageBase', 'InMemoryStorageAdapter',
    'LocalStorageAdapter', 'UndoStack', 'FrequencyViewport', 'prefs', 'prefsStorage', 'setPrefsBackend',
];
const OPTIONAL_VALUES = [
    'DEFAULT_XC_ENDPOINT', 'XenoCantoApiClient', 'XenoCantoApiError', 'buildXenoCantoAnnotationSet',
    'DEFAULT_XC_RECORDINGS_ENDPOINT', 'normalizeXcId', 'getRecordingScientificName', 'fetchXenoCantoRecording',
    'extractXenoCantoRawLabels', 'mapXenoCantoLabelsToSpectrogram', 'importXenoCantoSpectrogramLabels',
    'TaxonomyResolver', 'LiveRecorder', 'encodeWav', 'recordingFileName',
    'BirdNETInference', 'BIRDNET_MODEL_URL', 'BIRDNET_V24_MODEL_URL',
];

test('signavis/core exports the player and the headless utilities', () => {
    const missing = CORE_VALUES.filter((k) => core[k] === undefined);
    assert.deepEqual(missing, []);
});

test('signavis (full) exports core plus every optional module', () => {
    const missing = [...CORE_VALUES, ...OPTIONAL_VALUES].filter((k) => full[k] === undefined);
    assert.deepEqual(missing, []);
});

test('signavis/core does not export the optional modules', () => {
    const leaked = OPTIONAL_VALUES.filter((k) => k in core);
    assert.deepEqual(leaked, []);
});

test('package.json exports follow scripts/package-entries.mjs', async () => {
    const fs = await import('node:fs');
    const { PACKAGE_ENTRIES } = await import('../scripts/package-entries.mjs');
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    for (const [name, e] of Object.entries(PACKAGE_ENTRIES)) {
        const exp = pkg.exports[e.subpath];
        assert.ok(exp, `package.json exports is missing ${e.subpath}`);
        assert.equal(exp.import, `./dist/${name}.esm.js`, e.subpath);
        assert.equal(exp.types, `./types/${e.types}.d.ts`, e.subpath);
        if (e.cssSubpath) assert.equal(pkg.exports[e.cssSubpath], `./dist/${name}.css`, e.cssSubpath);
    }
    assert.equal(pkg.exports['./style'].default, './dist/birdnet-player.css');
});

test('signavis/label-table exports the feature; the full player knows it as an option', async () => {
    const lt = await import('../src/label-table.ts');
    assert.equal(typeof lt.labelTable, 'function');
    assert.equal(lt.labelTable().name, 'labelTable');
    assert.equal(typeof full.BirdNETPlayer.optionFeatures.labelTable, 'function');
    assert.deepEqual(Object.keys(core.BirdNETPlayer.optionFeatures), []);
    assert.ok(Object.getPrototypeOf(full.BirdNETPlayer) === core.BirdNETPlayer);
});
