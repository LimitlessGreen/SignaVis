import test from 'node:test';
import assert from 'node:assert/strict';
import { adoptionPlan, boxesIn, speciesFor, withoutKnownBoxes } from '../src/app/adopt-detection.ts';
import { adoptLabels, labelsToAdopt } from '../src/app/annotation-sets.ts';

const det = (o = {}) => ({ id: 'bn1', setId: 'bn', origin: 'BirdNET', start: 3, end: 6, freqMin: 0, freqMax: 24000, fullBand: true,
    label: 'Chaffinch', scientificName: 'Fringilla coelebs', confidence: 0.8, ...o });
const box = (id, start, end, confidence, o = {}) => ({ id, setId: 'bb', origin: 'BirdBox', start, end, freqMin: 2000, freqMax: 6000,
    label: 'Bird', confidence, ...o });

test('boxesIn: boxes mostly inside the window, most confident first', () => {
    const labels = [box('a', 3.2, 3.6, 0.4), box('b', 4, 4.5, 0.9), box('edge', 5.8, 6.1, 0.7), box('out', 5.9, 6.6, 0.95), box('far', 8, 8.4, 0.9)];
    assert.deepEqual(boxesIn(det(), labels).map((b) => b.id), ['b', 'edge', 'a']);
});

test('BirdNET detection: best box by default, all on request, unchanged without boxes', () => {
    const labels = [det(), box('a', 3.2, 3.6, 0.4), box('b', 4, 4.5, 0.9)];
    const best = adoptionPlan(labels[0], labels);
    assert.equal(best.candidates, 2);
    assert.equal(best.sources.length, 1);
    const s = best.sources[0];
    assert.deepEqual([s.start, s.end, s.freqMin, s.freqMax, s.fullBand, s.label, s.scientificName, s.id],
        [4, 4.5, 2000, 6000, false, 'Chaffinch', 'Fringilla coelebs', 'bn1']);
    assert.deepEqual(s.adoptBox, { start: 4, end: 4.5, freqMin: 2000, freqMax: 6000, label: 'Chaffinch' });
    assert.equal(adoptionPlan(labels[0], labels, { mode: 'all' }).sources.length, 2);

    const alone = adoptionPlan(labels[0], [labels[0]]);
    assert.deepEqual(alone, { sources: [labels[0]], candidates: 0, needsName: false });
});

test('BirdBox box: species from the most confident detection around it, else template, else needs a name', () => {
    const b = box('a', 4, 4.5, 0.9);
    const labels = [det(), det({ id: 'bn2', label: 'Robin', scientificName: 'Erithacus rubecula', confidence: 0.95 }), det({ id: 'bn3', start: 9, end: 12, label: 'Wren', confidence: 0.99 }), b];
    assert.equal(speciesFor(b, labels).id, 'bn2');
    const named = adoptionPlan(b, labels);
    assert.equal(named.needsName, false);
    assert.deepEqual([named.sources[0].label, named.sources[0].scientificName, named.sources[0].start], ['Robin', 'Erithacus rubecula', 4]);

    const tpl = adoptionPlan(b, [b], { template: { name: 'Blackbird', scientificName: 'Turdus merula', color: '#123456', tags: { sex: 'male' } } });
    assert.deepEqual([tpl.sources[0].label, tpl.sources[0].color, tpl.sources[0].tags, tpl.needsName], ['Blackbird', '#123456', { sex: 'male' }, false]);

    const bare = adoptionPlan(b, [b]);
    assert.deepEqual([bare.sources[0].label, bare.needsName], ['Bird', true]);
});

test('template tags: onto the template species or, without one, onto any; not onto another species', () => {
    const labels = [det(), box('a', 4, 4.5, 0.9)];
    const tags = { sex: 'male', soundType: 'song' };
    assert.deepEqual(adoptionPlan(labels[0], labels, { template: { name: '', tags } }).sources[0].tags, tags);
    assert.deepEqual(adoptionPlan(labels[0], labels, { template: { name: 'x', scientificName: 'Fringilla coelebs', tags } }).sources[0].tags, tags);
    assert.equal(adoptionPlan(labels[0], labels, { template: { name: 'Robin', scientificName: 'Erithacus rubecula', tags } }).sources[0].tags, undefined);
});

test('withoutKnownBoxes: one copy per species and box, also after the box ids moved', () => {
    const labels = [det(), det({ id: 'bn2', start: 4, end: 7 }), box('bb_0', 4.2, 4.6, 0.9)];
    const both = [labels[0], labels[1]].flatMap((d) => adoptionPlan(d, labels, { mode: 'all' }).sources);
    const once = withoutKnownBoxes(both, labels, 'own');
    assert.equal(once.length, 1);                                     // two overlapping detections, one box
    const own = adoptLabels(once, 'own');
    // sliders moved: same box under another id; the copy was resized by hand meanwhile
    own[0].start = 4.25;
    const again = adoptionPlan({ ...labels[2], id: 'bb_7' }, labels).sources;
    assert.equal(again[0].label, 'Chaffinch');
    assert.equal(withoutKnownBoxes(again, [...labels, ...own], 'own').length, 0);
    // another species on the same box is still possible
    assert.equal(withoutKnownBoxes([{ ...again[0], label: 'Robin', adoptBox: { ...again[0].adoptBox, label: 'Robin' } }], [...labels, ...own], 'own').length, 1);
});

// The app's order: labelsToAdopt, then withoutKnownBoxes (main.js adoptSources)
const open = (sources, existing) => withoutKnownBoxes(labelsToAdopt(sources, existing, 'own'), existing, 'own');

test('the same box once per species: a second species is copied, the first not again, also after a rename', () => {
    const b = box('bb_0', 4, 4.5, 0.9);
    const as = (name) => adoptionPlan(b, [b], { template: { name } }).sources;
    const own = adoptLabels(open(as('Chaffinch'), [b]), 'own');
    assert.equal(own.length, 1);
    assert.equal(open(as('Chaffinch'), [b, ...own]).length, 0);
    assert.equal(open(as('Robin'), [b, ...own]).length, 1);
    // an unnamed box copied as "Bird" and renamed by hand is not copied a second time
    const bare = adoptLabels(open(adoptionPlan(b, [b]).sources, [b]), 'own');
    bare[0].label = 'Wren';
    assert.equal(open(adoptionPlan(b, [b]).sources, [b, ...bare]).length, 0);
});

test('boxes with the same time but other frequencies are different calls', () => {
    const low = box('lo', 4, 4.5, 0.9, { freqMin: 1000, freqMax: 2500 }), high = box('hi', 4, 4.5, 0.8, { freqMin: 5000, freqMax: 8000 });
    const labels = [det(), low, high];
    const sources = adoptionPlan(labels[0], labels, { mode: 'all' }).sources;
    const own = adoptLabels(open(sources, labels), 'own');
    assert.deepEqual(own.map((l) => l.freqMin), [1000, 5000]);
    assert.equal(open(sources, [...labels, ...own]).length, 0);
});

import { boxSetsBoundsOf } from '../src/app/adopt-detection.ts';
test('boxSetsBoundsOf: a box inside a full-band label sets its bounds, others do not', () => {
    const win = { start: 10, end: 13, fullBand: true };
    assert.equal(boxSetsBoundsOf(win, { start: 11, end: 11.5 }), true);
    assert.equal(boxSetsBoundsOf(win, { start: 12.8, end: 14 }), false);     // mostly outside
    assert.equal(boxSetsBoundsOf({ ...win, fullBand: false }, { start: 11, end: 11.5 }), false);
    assert.equal(boxSetsBoundsOf(null, { start: 11, end: 11.5 }), false);
});
