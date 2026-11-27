import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSuggestions, reviewProgress, nextOpen, setReview, openAtLeast, openBelow } from '../src/app/suggestions.ts';

const d = (id, sp, start, confidence, o = {}) => ({ id, origin: 'BirdNET', label: sp, scientificName: sp, start, end: start + 3, confidence, ...o });
const dets = [
    d('a1', 'Glaucidium passerinum', 0, 0.6), d('a2', 'Glaucidium passerinum', 3, 0.71), d('a3', 'Glaucidium passerinum', 6, 0.5),
    d('a4', 'Glaucidium passerinum', 12, 0.9),
    d('b1', 'Aegolius funereus', 30, 0.44),
    d('c1', 'Turdus merula', 40, 0.2, { review: 'rejected' }),
];

test('adjacent windows of one species become one call run', () => {
    const g = buildSuggestions(dets).find((x) => x.scientificName === 'Glaucidium passerinum');
    assert.equal(g.windows, 4);
    assert.deepEqual(g.suggestions.map((s) => [s.start, s.end, s.windows.length, s.confidence]), [[12, 15, 1, 0.9], [0, 9, 3, 0.71]]);
});

test('join off keeps every window', () => {
    assert.equal(buildSuggestions(dets, { join: false })[0].suggestions.length, 4);
});

test('states: adopted id accepts the run, review on detection, mixed stays open', () => {
    const gs = buildSuggestions(dets, { adoptedIds: new Set(['a2']) });
    const gp = gs.find((x) => x.scientificName === 'Glaucidium passerinum');
    assert.equal(gp.suggestions.find((s) => s.start === 0).state, 'accepted');
    assert.equal(gs.find((x) => x.scientificName === 'Turdus merula').suggestions[0].state, 'rejected');
    const mixed = buildSuggestions([d('x', 'A', 0, 0.5, { review: 'unsure' }), d('y', 'A', 3, 0.5)]);
    assert.equal(mixed[0].suggestions[0].state, 'open');
});

test('unexpected species first, then by best confidence; minConfidence filters', () => {
    const gs = buildSuggestions(dets, { geoScore: (k) => (k === 'aegolius funereus' ? 0.01 : 0.5) });
    assert.deepEqual(gs.map((g) => g.scientificName), ['Aegolius funereus', 'Glaucidium passerinum', 'Turdus merula']);
    assert.equal(buildSuggestions(dets, { minConfidence: 0.3 }).length, 2);
});

test('progress, next open, set review, bulk filters', () => {
    const gs = buildSuggestions(dets);
    assert.deepEqual(reviewProgress(gs), { total: 4, reviewed: 1, windows: 6, byState: { open: 3, accepted: 0, rejected: 1, unsure: 0 } });
    const first = nextOpen(gs);
    assert.equal(first.start, 12);
    assert.equal(nextOpen(gs, first.key).start, 0);
    const marked = setReview(first, 'unsure');
    assert.equal(marked[0].review, 'unsure');
    assert.equal('review' in setReview({ windows: marked }, 'open')[0], false);
    assert.equal(openAtLeast(gs, 0.7).length, 2);
    assert.equal(openBelow(gs, 0.5).length, 1);
});
