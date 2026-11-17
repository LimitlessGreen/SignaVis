import test from 'node:test';
import assert from 'node:assert/strict';
import { SpectrogramLabelLayer } from '../src/domain/annotations.ts';
import { templateTagsSummary } from '../src/ui/components/label-template/template-tags.ts';

function createLayer(template) {
    const layer = new SpectrogramLabelLayer();
    layer.player = {
        duration: 10,
        _state: { audioBuffer: { duration: 10 }, sampleRateHz: 44100 },
        getSpeciesBarSelection: () => template,
        _emit() {},
    };
    layer.overlay = null;
    return layer;
}
const region = () => ({ start: 1, end: 2, freqMin: 1000, freqMax: 5000, label: 'Label 1' });

test('template with a species: new label gets species and tags without the dialog', () => {
    const layer = createLayer({ name: 'Chaffinch', color: '#ff0000', scientificName: 'Fringilla coelebs', tags: { sex: 'male', soundType: 'song' } });
    layer._openNewLabelPicker(layer._normalize(region()));
    layer._openNewLabelPicker(layer._normalize({ ...region(), start: 3, end: 4 }));
    const all = layer.getAll ? layer.getAll() : layer._items;
    assert.equal(all.length, 2);
    for (const l of all) {
        assert.equal(l.label, 'Chaffinch');
        assert.equal(l.scientificName, 'Fringilla coelebs');
        assert.deepEqual(l.tags, { sex: 'male', soundType: 'song' });
    }
    assert.notEqual(all[0].tags, all[1].tags, 'each label has its own tags object');
});

test('Alt (forcePicker) and a tags-only template go to the dialog instead', () => {
    const forced = createLayer({ name: 'Chaffinch', color: '', scientificName: '', tags: {} });
    // No DOM in this test: reaching the dialog shows up as its failed document access
    assert.throws(() => forced._openNewLabelPicker(forced._normalize(region()), { forcePicker: true }), /document/);
    assert.equal(forced._items.length, 0);

    const tagsOnly = createLayer({ name: '', color: '', scientificName: '', tags: { sex: 'male' } });
    assert.throws(() => tagsOnly._openNewLabelPicker(tagsOnly._normalize(region())), /document/);
    assert.equal(tagsOnly._items.length, 0);
});

test('templateTagsSummary: preset order first, then custom tags, empty values dropped', () => {
    const presets = [{ key: 'sex', options: [] }, { key: 'lifeStage', options: [] }, { key: 'soundType', options: [] }];
    assert.equal(templateTagsSummary({ soundType: 'song', note: 'faint', sex: 'male', lifeStage: '' }, presets), 'male · song · faint');
    assert.equal(templateTagsSummary({}, presets), '');
});

test('reference for the dialog defaults: own labels only, not the detection boxes (BirdBox "Bird")', () => {
    const layer = createLayer(null);
    layer.add({ start: 0, end: 1, freqMin: 1000, freqMax: 4000, label: 'Chaffinch', scientificName: 'Fringilla coelebs' });
    layer.add({ id: 'bb_1', start: 2, end: 3, freqMin: 1000, freqMax: 4000, label: 'Bird', origin: 'BirdBox' });
    layer._lockedIds = new Set(['bb_1']);
    assert.equal(layer._getReferenceLabelForDefaults().label, 'Chaffinch');
    // Snap clicks right on a BirdBox box, which focuses it
    layer._focusedLabelId = 'bb_1';
    assert.equal(layer._getReferenceLabelForDefaults().label, 'Chaffinch');
    layer._lockedIds = new Set(['bb_1', layer._items[0].id]);
    assert.equal(layer._getReferenceLabelForDefaults(), null);
});

test('refreshSnap: snaps again at the clicked point even when the signal gave no preview yet', () => {
    const layer = createLayer(null);
    layer.overlay = { style: {}, appendChild() {} };
    layer.player.computeSnapPatch = () => null;   // aw-dsp not ready
    layer.snapMode = true;
    let box = null;
    const asked = [];
    layer.snapBoxSource = (time, freq) => { asked.push([time, freq]); return box && { box, weaker: false }; };
    layer._runSnap(4, 2000);
    assert.equal(layer._snap, null);
    box = { start: 3.5, end: 4.5, freqMin: 1500, freqMax: 2500 };
    layer._toGeometry = () => ({ left: 0, top: 0, width: 1, height: 1 });
    try { layer.refreshSnap(); } catch { /* no DOM for the preview element */ }
    assert.deepEqual(asked, [[4, 2000], [4, 2000]]);
    assert.equal(layer._snap?.source, 'detector');
    layer._clearSnap();
    layer.refreshSnap();
    assert.equal(asked.length, 2, 'a cleared snap does not come back');
});
