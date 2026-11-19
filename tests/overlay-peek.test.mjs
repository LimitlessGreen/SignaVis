// overlay-peek.test.mjs — bars over the spectrogram fade near the pointer (overlay-peek.ts)

import test from 'node:test';
import assert from 'node:assert/strict';
import { distToBox, peekState, NEAR_PX } from '../src/ui/components/similar-review/overlay-peek.ts';

const bar = { left: 100, top: 100, right: 400, bottom: 130 };
const grip = { left: 100, top: 100, right: 115, bottom: 130 };
const idle = { engaged: false };

test('distToBox: 0 inside, euclidean outside', () => {
    assert.equal(distToBox(bar, 200, 110), 0);
    assert.equal(distToBox(bar, 200, 140), 10);
    assert.equal(distToBox(bar, 403, 134), 5);
});

test('far away: shown; near or on the bar: faded', () => {
    assert.deepEqual(peekState(idle, bar, grip, 200, 300, 0), { faded: false, engaged: false });
    assert.equal(peekState(idle, bar, grip, 200, 130 + NEAR_PX - 1, 0).faded, true);
    assert.equal(peekState(idle, bar, grip, 300, 115, 0).faded, true);
});

test('grip brings the bar back until the pointer leaves the margin', () => {
    let s = peekState(idle, bar, grip, 105, 115, 0);
    assert.deepEqual(s, { faded: false, engaged: true });
    s = peekState(s, bar, grip, 300, 115, 0);          // on to the buttons
    assert.deepEqual(s, { faded: false, engaged: true });
    s = peekState(s, bar, grip, 300, 300, 0);          // left
    assert.deepEqual(s, { faded: false, engaged: false });
    assert.equal(peekState(s, bar, grip, 300, 115, 0).faded, true);   // coming back fades again
});

test('a held button (drawing, dragging) keeps it faded', () => {
    assert.deepEqual(peekState({ engaged: true }, bar, grip, 105, 115, 1), { faded: true, engaged: false });
});
