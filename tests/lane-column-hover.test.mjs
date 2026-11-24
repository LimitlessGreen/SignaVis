// Read-only lanes: the spectrogram below a strip belongs to it (hover highlights, click plays).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pickLaneLabelAt } from '../src/domain/annotations.ts';

const labels = [
    { id: 'raven-0', start: 0, end: 3, confidence: 0.46 },
    { id: 'pipit-6', start: 6, end: 9, confidence: 0.92 },
    { id: 'raven-6', start: 6, end: 9, confidence: 0.72 },
    { id: 'x-7', start: 7.5, end: 10.5 },
];

test('picks the label covering the time', () => {
    assert.equal(pickLaneLabelAt(labels, 1.2)?.id, 'raven-0');
    assert.equal(pickLaneLabelAt(labels, 4), null);
    assert.equal(pickLaneLabelAt(labels, 3), null);   // end is exclusive
});

test('with several at that time, the most confident', () => {
    assert.equal(pickLaneLabelAt(labels, 6.5)?.id, 'pipit-6');
    assert.equal(pickLaneLabelAt(labels, 8)?.id, 'pipit-6');
    assert.equal(pickLaneLabelAt(labels, 10)?.id, 'x-7');
});

test('the layer binds the columns and reuses the strip click', () => {
    const src = readFileSync(new URL('../src/domain/annotations.ts', import.meta.url), 'utf8');
    assert.match(src, /this\._bindLaneColumns\(wrapper\);/);
    assert.match(src, /_readOnly && this\._lanes\.size > 0/);
    assert.equal((src.match(/this\._clickLabel\(label\);/g) || []).length, 2);
});
