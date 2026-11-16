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
