import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
    isVisible, layoutPanelIds, layoutUsable, parseSpacesState, stringifySpacesState,
} from '../src/app/lite/spaces-state.ts';

const DEFS = [
    { id: 'browse', title: 'Browse', icon: '', panels: ['library'] },
    { id: 'annotate', title: 'Annotate', icon: '', panels: ['editor'] },
    { id: 'embeddings', title: 'Embeddings', icon: '', panels: ['embeddings'], optional: true },
];
const layout = (...ids) => ({ grid: { root: {}, width: 1, height: 1, orientation: 'HORIZONTAL' }, panels: Object.fromEntries(ids.map((id) => [id, { id }])) });

test('parseSpacesState: missing, broken or foreign text gives the empty state', () => {
    for (const text of [null, '', '{', '[]', '{"version":2,"active":"browse"}']) {
        assert.deepEqual(parseSpacesState(text, DEFS, 'annotate'), { version: 1, active: 'annotate', spaces: {} });
    }
});

test('parseSpacesState: keeps known spaces, valid layouts and availability; drops the rest', () => {
    const text = JSON.stringify({
        version: 1, active: 'embeddings',
        spaces: {
            browse: { layout: layout('library') },
            embeddings: { layout: 'nonsense', available: true },
            gone: { layout: layout('x') },
        },
    });
    const s = parseSpacesState(text, DEFS, 'annotate');
    assert.equal(s.active, 'embeddings');
    assert.deepEqual(Object.keys(s.spaces).sort(), ['browse', 'embeddings']);
    assert.deepEqual(layoutPanelIds(s.spaces.browse.layout), ['library']);
    assert.equal(s.spaces.embeddings.layout, null);
    assert.equal(s.spaces.embeddings.available, true);
});

test('parseSpacesState: an unknown active space falls back', () => {
    assert.equal(parseSpacesState('{"version":1,"active":"nope","spaces":{}}', DEFS, 'annotate').active, 'annotate');
});

test('stringify → parse round trip', () => {
    const s = { version: 1, active: 'browse', spaces: { browse: { layout: layout('library') }, embeddings: { layout: null, available: true } } };
    assert.deepEqual(parseSpacesState(stringifySpacesState(s), DEFS, 'annotate'), s);
});

test('layoutUsable: only with known panels that no other space holds', () => {
    const known = new Set(['library', 'editor', 'embeddings']);
    assert.equal(layoutUsable(layout('library'), known, new Set(['editor'])), true);
    assert.equal(layoutUsable(layout('library', 'editor'), known, new Set(['editor'])), false);
    assert.equal(layoutUsable(layout('library', 'old-panel'), known, new Set()), false);
    assert.equal(layoutUsable(layout(), known, new Set()), false);
});

test('isVisible: optional spaces only once made available', () => {
    const s = parseSpacesState(null, DEFS, 'annotate');
    assert.equal(isVisible(DEFS[0], s), true);
    assert.equal(isVisible(DEFS[2], s), false);
    s.spaces.embeddings = { layout: null, available: true };
    assert.equal(isVisible(DEFS[2], s), true);
});

test('vendored dockview stylesheet matches the installed dockview-core', () => {
    const { version } = JSON.parse(fs.readFileSync(new URL('../node_modules/dockview-core/package.json', import.meta.url), 'utf8'));
    const head = fs.readFileSync(new URL('../src/styles/vendor/dockview.css', import.meta.url), 'utf8').slice(0, 200);
    assert.match(head, new RegExp(`dockview-core ${version.replace(/\./g, '\\.')} stylesheet`),
        'run node scripts/vendor-dockview-css.mjs after updating dockview-core');
});
