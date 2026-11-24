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

test('rowOfOpen: the view row only when its file is the open one', () => {
    const row = { id: 1, path: 'D:\\Woche_1\\SK17_2023.wav' };
    assert.equal(baseName(row.path), 'SK17_2023.wav');
    assert.equal(rowOfOpen(row, 'SK17_2023.wav'), row);
    assert.equal(rowOfOpen(row, 'other.wav'), null, 'opened from Files: not the view row');
    assert.equal(rowOfOpen(null, 'SK17_2023.wav'), null);
    assert.equal(rowOfOpen(row, ''), null);
});
