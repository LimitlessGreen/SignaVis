// Spectrogram settings fixed by the host app (option spectrogramSettings,
// setSpectrogramSettings()): the BirdNET-Analyzer passes those of its settings page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHostSpectrogramSettings, contrastFromTop } from '../src/domain/dsp/hostSpectrogramSettings.ts';
import { getSpectrogramColor, SPECTROGRAM_COLOR_SCHEMES } from '../src/domain/spectrogram.ts';
import { PresetManager } from '../src/domain/PresetManager.ts';
import { InMemoryStorageAdapter } from '../src/infrastructure/storage/InMemoryStorageAdapter.ts';
import { DSP_PROFILES, DB_CONTRAST } from '../src/shared/constants.ts';

const KEYS = ['presetSelect', 'scaleSelect', 'windowSizeSelect', 'overlapSelect', 'oversamplingSelect',
    'nMelsInput', 'colourScaleSelect', 'windowFunctionSelect', 'colorSchemeSelect'];

function makeDom() {
    const d = {};
    for (const k of KEYS) d[k] = { value: '' };
    return d;
}

function manager(d, storage, hostSettings) {
    return new PresetManager(d, {
        onRegenerateSpectrogram() {}, onStage1Rebuild() {}, storage, defaultPreset: 'classicSmall', hostSettings,
    });
}

test('host settings split into DSP fields and the contrast range', () => {
    const r = parseHostSpectrogramSettings({
        colorScheme: 'viridis', windowSize: 2048, overlapLevel: 2, oversamplingLevel: 0, scale: 'cqt', contrastRangeDb: 80,
    });
    assert.deepEqual(r.dsp, { colorScheme: 'viridis', windowSize: 2048, overlapLevel: 2, oversamplingLevel: 0, scale: 'cqt' });
    assert.equal(r.contrastRangeDb, 80);
    assert.deepEqual(parseHostSpectrogramSettings(null), { dsp: {}, contrastRangeDb: null });
    assert.deepEqual(parseHostSpectrogramSettings({ contrastRangeDb: null }), { dsp: {}, contrastRangeDb: null });
});

test('unknown settings and values the player has no control for are rejected', () => {
    for (const bad of [
        { colourScheme: 'viridis' }, { colorScheme: 'cividis' }, { windowSize: 1000 }, { windowSize: '1024' },
        { overlapLevel: 6 }, { oversamplingLevel: -1 }, { scale: 'log' },
        { contrastRangeDb: 10 }, { contrastRangeDb: 200 }, { contrastRangeDb: NaN }, [], 'viridis',
    ]) {
        assert.throws(() => parseHostSpectrogramSettings(bad), TypeError, JSON.stringify(bad));
    }
});

test('every colour map of the Analyzer settings page is known, jet included', () => {
    // Analyzer names: viridis, magma, plasma, inferno, Greys (→ grayscale), jet.
    for (const name of ['viridis', 'magma', 'plasma', 'inferno', 'grayscale', 'jet']) {
        assert.ok(SPECTROGRAM_COLOR_SCHEMES.includes(name), name);
    }
    // Jet runs dark blue → cyan/green → dark red, not the inferno fallback.
    assert.deepEqual(getSpectrogramColor(0, 'jet'), { r: 0, g: 0, b: 128 });
    assert.deepEqual(getSpectrogramColor(0.5, 'jet'), { r: 123, g: 255, b: 123 });
    assert.deepEqual(getSpectrogramColor(1, 'jet'), { r: 128, g: 0, b: 0 });
    // Grayscale is matplotlib's Greys: quiet white, loud black.
    assert.deepEqual(getSpectrogramColor(0, 'grayscale'), { r: 255, g: 255, b: 255 });
});

test('every known colour scheme can be chosen in the settings panel', () => {
    const template = readFileSync(new URL('../src/ui/template.ts', import.meta.url), 'utf8');
    for (const name of SPECTROGRAM_COLOR_SCHEMES) assert.ok(template.includes(`<option value="${name}"`), name);
});

test('host settings apply over the default preset and keep its other fields', () => {
    const d = makeDom();
    manager(d, new InMemoryStorageAdapter(), { colorScheme: 'viridis', windowSize: 2048 }).applyFavouritePresetControls();
    assert.equal(d.colorSchemeSelect.value, 'viridis');
    assert.equal(d.windowSizeSelect.value, '2048');
    assert.equal(d.overlapSelect.value, String(DSP_PROFILES.classicSmall.overlapLevel));
    assert.equal(d.presetSelect.value, '', 'no longer the named preset');
});

test('host settings win over last-used settings and a favourite', () => {
    for (const [key, value] of [['aw-last-settings', JSON.stringify(DSP_PROFILES.xc)], ['aw-favourite-preset', 'perch']]) {
        const storage = new InMemoryStorageAdapter();
        storage.setItem(key, value);
        const d = makeDom();
        manager(d, storage, { colorScheme: 'magma', scale: 'linear' }).applyFavouritePresetControls();
        assert.equal(d.colorSchemeSelect.value, 'magma', key);
        assert.equal(d.scaleSelect.value, 'linear', key);
    }
});

test('setHostSettings replaces the previous ones; a reset returns to them', () => {
    const d = makeDom();
    const m = manager(d, new InMemoryStorageAdapter(), { windowSize: 4096 });
    m.applyFavouritePresetControls();
    m.setHostSettings({ colorScheme: 'jet' });
    assert.equal(d.windowSizeSelect.value, String(DSP_PROFILES.classicSmall.windowSize), 'old host value gone');
    assert.equal(d.colorSchemeSelect.value, 'jet');
    assert.equal(m.getReferenceSettings().colorScheme, 'jet');
    m.setHostSettings({});
    assert.equal(d.colorSchemeSelect.value, DSP_PROFILES.classicSmall.colorScheme);
});

test('a later host change keeps the controls the user set', () => {
    const storage = new InMemoryStorageAdapter();
    storage.setItem('aw-favourite-preset', 'perch');
    const d = makeDom();
    const m = manager(d, storage, {});
    m.applyFavouritePresetControls();
    d.overlapSelect.value = '1';
    m.setHostSettings({ colorScheme: 'jet' });
    assert.equal(d.overlapSelect.value, '1');
    assert.equal(d.colorSchemeSelect.value, 'jet');
});

test('contrast from the top: black lies the range below white, white stays put when clamped', () => {
    // White 60 dB above the noise floor, 40 dB range: black 20 dB above the floor.
    assert.deepEqual(contrastFromTop(-20, -80, 40), { floor: 20, range: 40 });
    // 120 dB would put black 60 dB under the noise floor: clamped, white unchanged.
    const { floor, range } = contrastFromTop(-20, -80, 120);
    assert.equal(floor, DB_CONTRAST.floor.min);
    assert.equal(-80 + floor + range, -20);
});
