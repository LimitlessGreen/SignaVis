// Lanes (BirdNET strips) stay calm: framed strips, no dashed edges, no colour dot or bar meter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const scss = readFileSync(new URL('../src/styles/components/_spectrogram-labels.scss', import.meta.url), 'utf8');
const start = scss.indexOf('/* ── Lanes:');
const end = scss.indexOf('/* Snap preview');
const lanes = scss.slice(start, end);

test('lane styles have no dashed edges', () => {
    assert.ok(start > 0 && end > start);
    assert.doesNotMatch(lanes, /dashed/);
});

test('lanes hide the colour dot and the bar meter', () => {
    assert.match(lanes, /&:not\(\.active\) \.spectrogram-label-text::before \{ display: none; \}/);
    assert.match(lanes, /\.spectrogram-label-conf-meter \{ display: none; \}/);
});
