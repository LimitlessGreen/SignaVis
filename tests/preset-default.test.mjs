// The player's `defaultPreset` option picks the built-in preset a fresh
// player starts with (no favourite, no last-used settings); `classicSmall`
// keeps the classic look at a quarter of the spectrogram data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PresetManager } from '../src/domain/PresetManager.ts';
import { InMemoryStorageAdapter } from '../src/infrastructure/storage/InMemoryStorageAdapter.ts';
import { DSP_PROFILES, windowHopFromOverlap, fftSizeFromOversampling } from '../src/shared/constants.ts';

const KEYS = ['presetSelect', 'scaleSelect', 'windowSizeSelect', 'overlapSelect', 'oversamplingSelect',
    'nMelsInput', 'colourScaleSelect', 'windowFunctionSelect', 'colorSchemeSelect'];

function makeDom() {
    const d = {};
    for (const k of KEYS) d[k] = { value: '' };
    return d;
}

function manager(d, storage, defaultPreset) {
    return new PresetManager(d, {
        onRegenerateSpectrogram() {}, onStage1Rebuild() {}, storage, defaultPreset,
    });
}

test('classicSmall keeps the classic look with a quarter of the cells', () => {
    const c = DSP_PROFILES.classic, s = DSP_PROFILES.classicSmall;
    assert.ok(s, 'classicSmall exists');
    for (const k of ['scale', 'colourScale', 'windowSize', 'windowFunction', 'colorScheme', 'usePcen']) {
        assert.equal(s[k], c[k], k);
    }
    const cells = (p) => (fftSizeFromOversampling(p.windowSize, p.oversamplingLevel) / 2 + 1)
        / windowHopFromOverlap(p.windowSize, p.overlapLevel);
    assert.ok(cells(s) <= cells(c) / 3.9, `${cells(s)} vs ${cells(c)}`);
    assert.equal(s.label, 'Classic small');
});

test('a fresh player starts with the defaultPreset option', () => {
    const d = makeDom();
    manager(d, new InMemoryStorageAdapter(), 'classicSmall').applyFavouritePresetControls();
    assert.equal(d.overlapSelect.value, String(DSP_PROFILES.classicSmall.overlapLevel));
    assert.equal(d.oversamplingSelect.value, String(DSP_PROFILES.classicSmall.oversamplingLevel));
});

test('the reference preset falls back to defaultPreset, unknown names to classic', () => {
    const storage = new InMemoryStorageAdapter();
    assert.equal(manager(makeDom(), storage, 'classicSmall').getReferenceSettings().oversamplingLevel,
        DSP_PROFILES.classicSmall.oversamplingLevel);
    assert.equal(manager(makeDom(), storage, 'nope').getReferenceSettings().oversamplingLevel,
        DSP_PROFILES.classic.oversamplingLevel);
    for (const inherited of ['constructor', 'toString', '__proto__']) {
        assert.equal(manager(makeDom(), storage, inherited).getReferenceSettings().oversamplingLevel,
            DSP_PROFILES.classic.oversamplingLevel, inherited);
    }
});

test('a favourite still wins over defaultPreset', () => {
    const storage = new InMemoryStorageAdapter();
    storage.setItem('aw-favourite-preset', 'perch');
    const d = makeDom();
    manager(d, storage, 'classicSmall').applyFavouritePresetControls();
    assert.equal(d.scaleSelect.value, 'mel');
});
