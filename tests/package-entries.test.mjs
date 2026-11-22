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
