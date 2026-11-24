import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dockviewCss, vendoredFile, VENDORED_CSS } from '../scripts/vendor-dockview-css.mjs';

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

test('layoutUsable: only panels of this space, each entry matching its key', () => {
    const own = new Set(['library']);
    assert.equal(layoutUsable(layout('library'), own), true);
    assert.equal(layoutUsable(layout('library', 'editor'), own), false, 'editor belongs to another space');
    assert.equal(layoutUsable(layout('old-panel'), own), false);
    assert.equal(layoutUsable(layout(), own), false);
    const renamed = layout('library');
    renamed.panels.library.id = 'editor';   // dockview would restore the editor here
    assert.equal(layoutUsable(renamed, own), false);
    const otherComponent = layout('library');
    otherComponent.panels.library.contentComponent = 'editor';
    assert.equal(layoutUsable(otherComponent, own), false);
    assert.equal(layoutUsable({ grid: {}, panels: { library: null } }, own), false);
});

test('isVisible: optional spaces only once made available', () => {
    const s = parseSpacesState(null, DEFS, 'annotate');
    assert.equal(isVisible(DEFS[0], s), true);
    assert.equal(isVisible(DEFS[2], s), false);
    s.spaces.embeddings = { layout: null, available: true };
    assert.equal(isVisible(DEFS[2], s), true);
});

test('vendored dockview stylesheet is the installed one, with its licence', () => {
    const d = dockviewCss();
    const file = fs.readFileSync(VENDORED_CSS, 'utf8');
    assert.ok(file === vendoredFile(d), 'run node scripts/vendor-dockview-css.mjs after updating dockview-core');
    assert.match(file, /Permission is hereby granted/);
});

test('layoutUsable: a layout without a panel the space has now (added in an update) is not used', () => {
    const own = new Set(['lib-recordings', 'lib-fields', 'lib-map']);
    assert.equal(layoutUsable(layout('lib-recordings', 'lib-fields'), own), false, 'lib-map would be unreachable');
    assert.equal(layoutUsable(layout('lib-recordings', 'lib-fields', 'lib-map'), own), true);
});

test('layoutUsable: on-demand panels may be missing from a stored layout', () => {
    const own = new Set(['editor', 'labels', 'upload']);
    const onDemand = new Set(['upload']);
    assert.equal(layoutUsable(layout('editor', 'labels'), own, onDemand), true, 'upload is added when revealed');
    assert.equal(layoutUsable(layout('editor', 'labels', 'upload'), own, onDemand), true, 'and kept once placed');
    assert.equal(layoutUsable(layout('editor'), own, onDemand), false, 'labels is not on demand');
});
