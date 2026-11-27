import test from 'node:test';
import assert from 'node:assert/strict';

import { baseName, durationText, headMeta, rowOfOpen } from '../src/ui/panels/editor-chrome.ts';

test('durationText: m:ss below an hour, h:mm:ss above', () => {
    assert.equal(durationText(60.1), '1:00');
    assert.equal(durationText(1800), '30:00');
    assert.equal(durationText(3723), '1:02:03');
    assert.equal(durationText(-3), '0:00');
});

test('headMeta: site · recorder · local start · length, only what is known', () => {
    const startMs = Date.UTC(2023, 2, 13, 16, 0, 1);
    assert.equal(headMeta({ site: 'Standort 6', device: 'Rekorder 17', startMs, localOffsetMin: 60, durationS: 60 }),
        'Standort 6 · Rekorder 17 · 2023-03-13 17:00 · 1:00');
    assert.equal(headMeta({ site: null, device: null, startMs: null, localOffsetMin: null, durationS: null }), '');
    assert.equal(headMeta({ site: 'S3', device: null, startMs, localOffsetMin: null, durationS: 0 }), 'S3 · 2023-03-13 16:00');
});

test('rowOfOpen: the view row of the open recording by catalog id, not by file name', () => {
    const a = { id: 1, path: 'site-a/dawn.wav' }, b = { id: 2, path: 'site-b/dawn.wav' };
    assert.deepEqual(rowOfOpen([a, b], 2), { row: b, index: 1 }, 'same file name, other folder');
    assert.deepEqual(rowOfOpen([a, b], null), { row: null, index: -1 }, 'opened from Files: not a view row');
    assert.deepEqual(rowOfOpen([a, undefined], 9), { row: null, index: -1 });
});
