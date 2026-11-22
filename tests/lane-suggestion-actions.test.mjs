// Lanes (labels without frequency bounds, BirdNET) must keep their action buttons:
// ✓/✗ on suggestions, ✎/🗑 on own labels. #172 hid them with the handles.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as sass from 'sass';

const css = sass.compile('src/styles/main.scss', { loadPaths: ['src/styles'] }).css;

/** Declarations of every rule whose selector targets .label-actions inside a lane. */
function laneActionRules() {
    const out = [];
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const sels = m[1].split(',').map((s) => s.trim());
        if (sels.some((s) => /region--lane[^ ]*.*\.label-actions(\s|$|:)/.test(s) || /region--lane[^ ]*.*\.label-actions$/.test(s))) out.push(m[2]);
    }
    return out;
}

test('lane strips do not hide their action buttons', () => {
    const hidden = laneActionRules().filter((d) => /display:\s*none/.test(d));
    assert.deepEqual(hidden, []);
});

test('lane actions sit in a row next to the strip, not a column over the lanes below', () => {
    assert.ok(laneActionRules().some((d) => /flex-direction:\s*row/.test(d)));
});
