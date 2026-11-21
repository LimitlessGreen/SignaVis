// pointer-priority.test.mjs — presses on the playhead never start a label tool (pointer-priority.ts)

import test from 'node:test';
import assert from 'node:assert/strict';
import { isPlayerTarget } from '../src/domain/pointer-priority.ts';

const node = (classes, parent = null) => ({
    closest(sel) {
        const cls = sel.replace(/^\./, '');
        for (let n = this; n; n = n.parent) if (n.classes.includes(cls)) return n;
        return null;
    },
    classes, parent,
});

test('playhead and its children belong to the player', () => {
    const ph = node(['playhead']);
    assert.equal(isPlayerTarget(ph), true);
    assert.equal(isPlayerTarget(node([], ph)), true);
    assert.equal(isPlayerTarget(node(['playhead', 'playhead-secondary'])), true);
});

test('free canvas and labels stay with the label tools', () => {
    assert.equal(isPlayerTarget(node(['spectrogram-canvas'])), false);
    assert.equal(isPlayerTarget(node(['spectrogram-label-region'])), false);
    assert.equal(isPlayerTarget(null), false);
    assert.equal(isPlayerTarget({}), false);
});
