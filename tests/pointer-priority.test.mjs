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

// ── resolvePress / classifyHit: the one decision for a press on the spectrogram ──
import { resolvePress, classifyHit } from '../src/domain/pointer-priority.ts';

const region = (id, parent = null) => ({ ...node(['spectrogram-label-region'], parent), dataset: { id } });
const btn = (parent) => ({ ...node(['button'], parent), closest(sel) {
    if (sel === 'button') return this;
    for (let n = this.parent; n; n = n.parent) if (n.classes.includes(sel.replace(/^\./, ''))) return n;
    return null;
} });
const locked = (id) => id === 'det';

test('classifyHit: player, own/locked labels, their buttons, canvas', () => {
    assert.equal(classifyHit(node(['playhead']), locked), 'player');
    assert.equal(classifyHit(region('a'), locked), 'label');
    assert.equal(classifyHit(btn(region('a')), locked), 'label-button');
    assert.equal(classifyHit(region('det'), locked), 'locked-label');
    assert.equal(classifyHit(btn(region('det')), locked), 'locked-label-button');
    assert.equal(classifyHit(node(['canvas']), locked), 'canvas');
});

const press = (o) => resolvePress({ hit: 'canvas', button: 0, shift: false, tool: 'none', hasAudio: true, readOnly: false, ...o });

test('the playhead wins left/middle presses over every tool', () => {
    for (const tool of ['zoom-box', 'snap', 'stamp', 'draw', 'none'])
        for (const button of [0, 1]) assert.equal(press({ hit: 'player', tool, button }), 'pass', `${tool}/${button}`);
});

test('right-click on the playhead still reaches the tool', () => {
    assert.equal(press({ hit: 'player', tool: 'stamp', button: 2 }), 'stamp-exit');
    assert.equal(press({ hit: 'player', tool: 'zoom-box', button: 2 }), 'zoom-box-back');
    assert.equal(press({ hit: 'player', tool: 'draw', button: 2 }), 'pass');
    assert.equal(press({ hit: 'player', tool: 'snap', button: 2 }), 'pass');
});

test('no tool: canvas goes to the player, Shift draws', () => {
    assert.equal(press({}), 'pass');
    assert.equal(press({ shift: true }), 'draw-start');
    assert.equal(press({ shift: true, hit: 'label' }), 'pass');
});

test('draw mode: left on canvas draws; labels, other buttons, read-only and no audio pass', () => {
    assert.equal(press({ tool: 'draw' }), 'draw-start');
    assert.equal(press({ tool: 'draw', hit: 'label' }), 'pass');
    assert.equal(press({ tool: 'draw', button: 1 }), 'pass');
    assert.equal(press({ tool: 'draw', button: 2 }), 'pass');
    assert.equal(press({ tool: 'draw', readOnly: true }), 'pass');
    assert.equal(press({ tool: 'draw', hasAudio: false }), 'pass');
});

test('zoom box: left starts, right goes back, also over labels; middle passes', () => {
    assert.equal(press({ tool: 'zoom-box' }), 'zoom-box-start');
    assert.equal(press({ tool: 'zoom-box', hit: 'label' }), 'zoom-box-start');
    assert.equal(press({ tool: 'zoom-box', button: 2 }), 'zoom-box-back');
    assert.equal(press({ tool: 'zoom-box', button: 1 }), 'pass');
    assert.equal(press({ tool: 'zoom-box', hasAudio: false }), 'pass');
});

test('snap: own labels and buttons keep clicks, detection boxes let it through', () => {
    assert.equal(press({ tool: 'snap' }), 'snap');
    assert.equal(press({ tool: 'snap', hit: 'label' }), 'pass');
    assert.equal(press({ tool: 'snap', hit: 'label-button' }), 'pass');
    assert.equal(press({ tool: 'snap', hit: 'locked-label-button' }), 'pass');
    assert.equal(press({ tool: 'snap', hit: 'locked-label' }), 'snap-through-locked');
    assert.equal(press({ tool: 'snap', button: 2 }), 'pass');
});

test('stamp: left places (also over labels), right exits', () => {
    assert.equal(press({ tool: 'stamp' }), 'stamp-place');
    assert.equal(press({ tool: 'stamp', hit: 'label' }), 'stamp-place');
    assert.equal(press({ tool: 'stamp', button: 2 }), 'stamp-exit');
    assert.equal(press({ tool: 'stamp', button: 2, hasAudio: false }), 'stamp-exit');
    assert.equal(press({ tool: 'stamp', hasAudio: false }), 'pass');
});
