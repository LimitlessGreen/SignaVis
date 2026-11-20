import test from 'node:test';
import assert from 'node:assert/strict';

import { fmtDuration, fmtRate, qualityLetter, yesNo, splitSpecies, fmtLongDate } from '../src/ui/mobile/details.ts';

test('fmtDuration: seconds, minutes, hours', () => {
    assert.equal(fmtDuration(12.44), '12.4 s');
    assert.equal(fmtDuration(187), '3:07');
    assert.equal(fmtDuration(3903), '1:05:03');
    assert.equal(fmtDuration(0), '');
    assert.equal(fmtDuration(null), '');
});

test('fmtRate in kHz', () => {
    assert.equal(fmtRate(48000), '48 kHz');
    assert.equal(fmtRate(22050), '22.05 kHz');
    assert.equal(fmtRate(undefined), '');
});

test('qualityLetter keeps only A–E', () => {
    assert.equal(qualityLetter('a'), 'A');
    assert.equal(qualityLetter(' E '), 'E');
    assert.equal(qualityLetter('no score'), '');
    assert.equal(qualityLetter(null), '');
});

test('yesNo reads XC fields', () => {
    assert.equal(yesNo('yes'), 'yes');
    assert.equal(yesNo('No'), 'no');
    assert.equal(yesNo('unknown'), '');
    assert.equal(yesNo('?'), '');
});

test('splitSpecies from list or string', () => {
    assert.deepEqual(splitSpecies(['Turdus merula', '', 'Erithacus rubecula']), ['Turdus merula', 'Erithacus rubecula']);
    assert.deepEqual(splitSpecies('Turdus merula, Erithacus rubecula'), ['Turdus merula', 'Erithacus rubecula']);
    assert.deepEqual(splitSpecies(undefined), []);
});

test('fmtLongDate: full dates localized, partial ones kept', () => {
    assert.match(fmtLongDate('2024-05-12', 'en'), /Sunday.*May.*2024/);
    assert.match(fmtLongDate('2024-05-12', 'de'), /Sonntag.*Mai.*2024/);
    assert.equal(fmtLongDate('2024-05', 'en'), '2024-05');
    assert.equal(fmtLongDate(null), '');
});
