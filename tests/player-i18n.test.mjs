import test from 'node:test';
import assert from 'node:assert/strict';
import { translationFor, translateText, installPlayerTranslation } from '../src/ui/playerI18n.ts';

const de = translationFor('de');

test('player i18n: locale variants pick the German dictionary, English and unknown ones none', () => {
    assert.equal(translationFor('de-DE'), de);
    assert.equal(translationFor('de_AT'), de);
    assert.equal(translationFor('en'), null);
    assert.equal(translationFor('fi'), null);
    assert.equal(translationFor(undefined), null);
});

test('player i18n: exact UI text is translated, surrounding whitespace kept', () => {
    assert.equal(translateText(de, 'Follow'), 'Folgen');
    assert.equal(translateText(de, '  Settings\n'), '  Einstellungen\n');
});

test('player i18n: text with numbers goes through patterns', () => {
    assert.equal(translateText(de, '5 rows'), '5 Zeilen');
    assert.equal(translateText(de, 'Visible time span (100 px/s)'), 'Sichtbare Zeitspanne (100 px/s)');
    assert.equal(translateText(de, 'Normalize playback to -1 dBFS peak (max +40 dB) - this file: +30.7 dB'),
        'Wiedergabe auf −1 dBFS Spitze normalisieren (max. +40 dB) – diese Datei: +30.7 dB');
    assert.equal(translateText(de, 'Normalize playback to -1 dBFS peak (max +40 dB)'),
        'Wiedergabe auf −1 dBFS Spitze normalisieren (max. +40 dB)');
    assert.equal(translateText(de, 'Blue Jay (15.00s–18.00s) [read-only]'), 'Blue Jay (15.00s–18.00s) [schreibgeschützt]');
});

test('player i18n: unknown text and technical names stay as they are', () => {
    assert.equal(translateText(de, 'Blue Jay'), null);
    assert.equal(translateText(de, 'Viridis'), null);
    assert.equal(translateText(de, ''), null);
});

test('player i18n: no translation is itself a key (the observer would loop)', () => {
    for (const v of Object.values(de.text)) {
        if (v in de.text) assert.equal(de.text[v], v, v);
    }
});

test('player i18n: English needs no observer', () => {
    assert.equal(typeof installPlayerTranslation({}, 'en'), 'function');
});

