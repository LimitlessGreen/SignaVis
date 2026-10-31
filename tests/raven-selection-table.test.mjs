import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRavenSelectionTable, ravenTablePath, RAVEN_COLUMNS } from '../src/infrastructure/export/ravenSelectionTable.ts';

test('raven table: header, sorting, frequencies, tags', () => {
    const txt = buildRavenSelectionTable([
        { id: 'b', start: 2.5, end: 3, freqMin: 2000, freqMax: 6000.04, scientificName: 'Turdus merula',
          commonName: 'Amsel', tags: { sound_type: 'song' }, author: 'JB', setId: 's1' },
        { id: 'a', start: 0.1234567, end: 1, label: 'Unknown\tbird', confidence: 0.87654, freqMin: 0, freqMax: 0 },
        { id: 'bad', start: 'x', end: 1 },
    ], { sampleRate: 48000, setName: (id) => (id === 's1' ? 'Mine' : id) });
    const lines = txt.trimEnd().split('\n');
    assert.equal(lines[0], RAVEN_COLUMNS.join('\t'));
    assert.equal(lines.length, 3);
    const first = lines[1].split('\t');
    assert.deepEqual(first.slice(0, 8), ['1', 'Spectrogram 1', '1', '0.123457', '1', '0', '24000', 'Unknown bird']);
    assert.equal(first[10], '0.8765');
    const second = lines[2].split('\t');
    assert.deepEqual(second.slice(3, 10), ['2.5', '3', '2000', '6000', 'Turdus merula', 'Amsel', 'song']);
    assert.equal(second[11], 'JB');
    assert.equal(second[12], 'Mine');
    assert.equal(second.length, RAVEN_COLUMNS.length);
});

test('raven table: no sample rate leaves high freq empty for time-only labels', () => {
    const row = buildRavenSelectionTable([{ start: 0, end: 1, freqMax: 500, freqUnset: true }]).split('\n')[1].split('\t');
    assert.equal(row[5], '0');
    assert.equal(row[6], '');
});

test('ravenTablePath follows the Raven naming convention', () => {
    assert.equal(ravenTablePath('aufnahmen/garten.wav'), 'aufnahmen/garten.Table.1.selections.txt');
    assert.equal(ravenTablePath('XC1.mp3'), 'XC1.Table.1.selections.txt');
    assert.equal(ravenTablePath('noext'), 'noext.Table.1.selections.txt');
});
