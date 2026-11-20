import test from 'node:test';
import assert from 'node:assert/strict';

import { templateFields, syncMappings, guessRole, localTime, formatBytes } from '../src/domain/catalog/catalog-types.ts';

test('templateFields: names in order, time fields flagged, {*} and repeats skipped', () => {
    const f = templateFields([
        'Rekorder_{rec}_Standort_{loc}/Woche_{week:int}*/SK{rec}_{t:%Y_%m_%d_%H_%M_%S}.wav',
        'Rekorder_{*}_Standort_{*}/x/{day:%Y-%m-%d}.wav',
    ]);
    assert.deepEqual(f, [
        { name: 'rec', isTime: false }, { name: 'loc', isTime: false }, { name: 'week', isTime: false },
        { name: 't', isTime: true }, { name: 'day', isTime: true },
    ]);
});

test('guessRole uses name hints', () => {
    assert.equal(guessRole('Standort', false), 'site');
    assert.equal(guessRole('rec', false), 'device');
    assert.equal(guessRole('week', false), 'meta:week');
    assert.equal(guessRole('t', true), 'start');
    assert.equal(guessRole('datum', true), 'date');
    assert.equal(guessRole('clock', true), 'time');
});

test('syncMappings keeps edited roles and drops vanished fields', () => {
    const prev = [{ field: 'loc', role: 'site', format: 'Site {}' }, { field: 'gone', role: 'ignore' }];
    const m = syncMappings(['{loc}/{x:%H%M}.wav'], prev);
    assert.deepEqual(m, [{ field: 'loc', role: 'site', format: 'Site {}' }, { field: 'x', role: 'start' }]);
});

test('localTime applies the stored offset', () => {
    assert.equal(localTime({ startMs: Date.UTC(2023, 2, 13, 16, 0, 1), localOffsetMin: 60 }), '2023-03-13 17:00:01');
    assert.equal(localTime({ startMs: null, localOffsetMin: null }), '');
});

test('formatBytes', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(813e9), '813 GB');
    assert.equal(formatBytes(1.5e6), '1.5 MB');
});

test('continuousDays fills gaps between recording weeks', async () => {
    const { continuousDays } = await import('../src/ui/panels/library/library-view.ts');
    assert.deepEqual(continuousDays(['2023-03-15', '2023-03-13']), ['2023-03-13', '2023-03-14', '2023-03-15']);
    assert.deepEqual(continuousDays([]), []);
});

test('profileFromSuggestions keeps the first meaning per field', async () => {
    const { profileFromSuggestions, emptyProfile } = await import('../src/domain/catalog/catalog-types.ts');
    const p = profileFromSuggestions(emptyProfile('x'), [
        { pattern: 'A_{rec}/{start:%Y}.wav', mappings: [{ field: 'rec', role: 'device', format: 'Rec {}' }, { field: 'start', role: 'start' }], matches: 3, example: '' },
        { pattern: '{*}/A_{rec}/{start:%Y}.wav', mappings: [{ field: 'rec', role: 'meta:rec' }], matches: 1, example: '' },
    ]);
    assert.deepEqual(p.patterns, ['A_{rec}/{start:%Y}.wav', '{*}/A_{rec}/{start:%Y}.wav']);
    assert.deepEqual(p.mappings.map((m) => m.role), ['device', 'start']);
    assert.equal(p.name, 'x');
});
