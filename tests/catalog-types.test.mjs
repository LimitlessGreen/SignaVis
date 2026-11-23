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

test('fixedClockLabel', async () => {
    const { fixedClockLabel } = await import('../src/domain/catalog/catalog-types.ts');
    assert.equal(fixedClockLabel(60), 'UTC+01:00');
    assert.equal(fixedClockLabel(-330), 'UTC-05:30');
    assert.equal(fixedClockLabel(0), 'UTC+00:00');
});

test('formatDuration', async () => {
    const { formatDuration } = await import('../src/ui/panels/library/library-view.ts');
    assert.equal(formatDuration(720), '12 min');
    assert.equal(formatDuration(3.4 * 3600), '3.4 h');
});

test('profile files round-trip and reject foreign JSON', async () => {
    const { profileToFile, profileFromFile } = await import('../src/domain/catalog/catalog-types.ts');
    const p = { name: 'SK', patterns: ['{a}.wav'], mappings: [{ field: 'a', role: 'site', format: 'Site {}' }], utcOffsetMin: 60, tz: null, derivedDirs: ['backup'] };
    assert.deepEqual(profileFromFile(profileToFile(p)), p);
    assert.throws(() => profileFromFile('{"name":"x"}'), /Not a SignaVis import profile/);
    assert.throws(() => profileFromFile('nope'), /Not a JSON file/);
});

test('periodsWithShift adds the change after the existing clock', async () => {
    const { periodsWithShift } = await import('../src/domain/catalog/catalog-types.ts');
    const jump = { deviceId: 1, device: 'R', from: '2023-03-27T18:00:02', shiftMin: 60, clockBefore: 'UTC+01:00', clockAfter: 'UTC+02:00', kind: 'jump' };
    assert.deepEqual(periodsWithShift([], jump).map((p) => [p.from, p.clock]), [[null, 'UTC+01:00'], ['2023-03-27T18:00:02', 'UTC+02:00']]);
    assert.deepEqual(periodsWithShift([{ from: null, clock: 'UTC+00:00' }], jump).map((p) => p.clock), ['UTC+00:00', 'UTC+02:00']);
    assert.deepEqual(periodsWithShift([], { ...jump, kind: 'like-others' }).map((p) => [p.from, p.clock]), [[null, 'UTC+02:00']]);
});

test('pickRows: click, ctrl toggle, shift range', async () => {
    const { pickRows } = await import('../src/domain/catalog/catalog-types.ts');
    const ids = [10, 11, 12, 13, 14];
    let s = pickRows(ids, new Set(), null, 1, {});
    assert.deepEqual([...s.picked], [11]);
    s = pickRows(ids, s.picked, s.anchor, 3, { shift: true });
    assert.deepEqual([...s.picked].sort(), [11, 12, 13]);
    assert.equal(s.anchor, 1, 'shift keeps the anchor');
    s = pickRows(ids, s.picked, s.anchor, 2, { ctrl: true });
    assert.deepEqual([...s.picked].sort(), [11, 13]);
    s = pickRows(ids, s.picked, s.anchor, 4, { ctrl: true, shift: true });
    assert.deepEqual([...s.picked].sort(), [11, 12, 13, 14], 'ctrl+shift adds the range');
    s = pickRows(ids, s.picked, s.anchor, 0, {});
    assert.deepEqual([...s.picked], [10]);
});

test('parseCoords accepts map copies and rejects nonsense', async () => {
    const { parseCoords } = await import('../src/domain/catalog/catalog-types.ts');
    assert.deepEqual(parseCoords('52.1234, 8.5678'), { lat: 52.1234, lon: 8.5678 });
    assert.deepEqual(parseCoords('52,1234 8,5678'), { lat: 52.1234, lon: 8.5678 });
    assert.deepEqual(parseCoords(' -33.9;18.4 '), { lat: -33.9, lon: 18.4 });
    assert.equal(parseCoords('95, 8'), null);
    assert.equal(parseCoords('Moor'), null);
});

test('dayRanges compresses consecutive days', async () => {
    const { dayRanges } = await import('../src/domain/catalog/catalog-types.ts');
    assert.deepEqual(dayRanges(['2023-03-16', '2023-03-15', '2023-03-20', '2023-03-31', '2023-04-01']), ['03-15–03-16', '03-20', '03-31–04-01']);
    assert.deepEqual(dayRanges([]), []);
});

test('coverageMatrix keeps empty weeks and sites in order', async () => {
    const { coverageMatrix } = await import('../src/domain/catalog/catalog-types.ts');
    const m = coverageMatrix({
        sites: [[2, 'Site 2'], [null, '']],
        weeks: [
            { siteId: 2, week: '2023-03-13', recordings: 6, seconds: 0, days: 2 },
            { siteId: null, week: '2023-03-27', recordings: 1, seconds: 0, days: 1 },
        ],
    });
    assert.deepEqual(m.weeks, ['2023-03-13', '2023-03-20', '2023-03-27']);
    assert.equal(m.rows[1].name, '(no site)');
    assert.deepEqual(m.rows[0].cells.map((c) => c?.recordings ?? 0), [6, 0, 0]);
    assert.deepEqual(m.rows[1].cells.map((c) => c?.recordings ?? 0), [0, 0, 1]);
    const noTime = coverageMatrix({ sites: [[2, 'Site 2'], [null, '']], weeks: [{ siteId: 2, week: '2023-03-13', recordings: 1, seconds: 0, days: 1 }] });
    assert.equal(noTime.rows.length, 1, 'no-site row without any week is dropped');
});

test('bulkReportText', async () => {
    const { bulkReportText } = await import('../src/domain/catalog/catalog-types.ts');
    const r = { recordings: 9, siteChanged: 0, deviceChanged: 0, tagsAdded: 9, tagsRemoved: 0, metaSet: 0, reclocked: 0 };
    assert.equal(bulkReportText(r), '9 recordings: 9 tags added');
    assert.equal(bulkReportText({ ...r, tagsAdded: 0 }), '9 recordings: nothing changed');
});

test('cellDegForZoom halves per zoom level', async () => {
    const { cellDegForZoom } = await import('../src/domain/catalog/catalog-types.ts');
    assert.equal(cellDegForZoom(0, 256), 360);
    assert.equal(cellDegForZoom(10) * 2, cellDegForZoom(9));
});

test('matchReportText', async () => {
    const { matchReportText } = await import('../src/domain/catalog/catalog-types.ts');
    assert.equal(matchReportText({ candidates: 0, positioned: 0, kept: 0, tooFar: 0 }), 'No recordings in the time span of the track.');
    assert.equal(matchReportText({ candidates: 10, positioned: 7, kept: 2, tooFar: 1 }),
        "7 of 10 recordings in the track's time span got a position; 2 kept their position from the recorder or set by hand; 1 had no track point near enough in time.");
});
