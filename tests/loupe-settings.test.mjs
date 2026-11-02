import test from 'node:test';
import assert from 'node:assert/strict';
import { SpectrogramLabelLayer } from '../src/domain/annotations.ts';

// The labeling app moves the settings sections out of the player root into its
// Display sidebar; the loupe must still honour them via the cached DOM refs.
function layerWithMovedSettings({ loupeChecked, scheme }) {
    const box = { checked: loupeChecked, dataset: {}, addEventListener() {} };
    const layer = new SpectrogramLabelLayer();
    layer.player = {
        root: { querySelector: () => null }, // nothing left inside the root
        _state: { d: { editLoupeCheck: box, colorSchemeSelect: { value: scheme } } },
    };
    return layer;
}

test('edit loupe honours a disabled checkbox outside the player root', () => {
    const layer = layerWithMovedSettings({ loupeChecked: false, scheme: 'inferno' });
    assert.equal(layer._editLoupeEnabled(), false);
});

test('loupe reads the colour scheme outside the player root', () => {
    const layer = layerWithMovedSettings({ loupeChecked: true, scheme: 'inferno' });
    assert.equal(layer._settingEl('colorSchemeSelect').value, 'inferno');
});
