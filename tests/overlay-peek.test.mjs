// overlay-peek.test.mjs — bars over the spectrogram fade only while a drag passes near them (overlay-peek.ts)

import test from 'node:test';
import assert from 'node:assert/strict';
import { distToBox, peekState, NEAR_PX } from '../src/ui/components/similar-review/overlay-peek.ts';

const bar = { left: 100, top: 100, right: 400, bottom: 130 };
const idle = { pressOnBar: false };

test('distToBox: 0 inside, euclidean outside', () => {
    assert.equal(distToBox(bar, 200, 110), 0);
    assert.equal(distToBox(bar, 200, 140), 10);
    assert.equal(distToBox(bar, 403, 134), 5);
});

test('hovering (no button) never fades the bar, near or on it', () => {
    assert.equal(peekState(idle, bar, 200, 300, 0).faded, false);
    assert.equal(peekState(idle, bar, 200, 130 + NEAR_PX - 1, 0).faded, false);
    assert.equal(peekState(idle, bar, 300, 115, 0).faded, false);
});

test('a drag started off the bar fades it when it comes near', () => {
    let s = peekState(idle, bar, 200, 400, 1, 'pointerdown');
    assert.equal(s.faded, false);
    s = peekState(s, bar, 200, 130 + NEAR_PX - 1, 1);
    assert.equal(s.faded, true);
    s = peekState(s, bar, 200, 130 + NEAR_PX - 1, 0, 'pointerup');
    assert.equal(s.faded, false);
});

test('pressing a button on the bar keeps it visible', () => {
    const s = peekState(idle, bar, 300, 115, 1, 'pointerdown');
    assert.deepEqual(s, { faded: false, pressOnBar: true });
    assert.equal(peekState(s, bar, 300, 140, 1).faded, false);
});
