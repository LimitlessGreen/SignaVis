import test from 'node:test';
import assert from 'node:assert/strict';

import {
    parseCoords, formatCoords, contextFromXc, contextFromGuano, contextFromFilename, resolveRecordingContext,
} from '../src/app/recording-context.ts';

test('parseCoords accepts common pasted forms', () => {
    assert.deepEqual(parseCoords('51.5074, -0.1278'), { lat: 51.5074, lon: -0.1278 });
    assert.deepEqual(parseCoords('51.5074 -0.1278'), { lat: 51.5074, lon: -0.1278 });
    assert.deepEqual(parseCoords('51,5074; -0,1278'), { lat: 51.5074, lon: -0.1278 });
    assert.deepEqual(parseCoords('51.5074N 0.1278W'), { lat: 51.5074, lon: -0.1278 });
    assert.equal(parseCoords('91, 10'), null);
    assert.equal(parseCoords('51.5'), null);
    assert.equal(parseCoords(''), null);
    assert.equal(formatCoords({ lat: 51.5, lon: -0.12 }), '51.5000, -0.1200');
});

test('contextFromXc reads raw v3 and normalized metadata', () => {
    const raw = contextFromXc({ lat: '51.3', lon: '12.4', date: '2024-05-00', time: '5:30', loc: 'Leipzig', cnt: 'Germany', dvc: 'Zoom H5' });
    assert.deepEqual(raw.coords, { lat: 51.3, lon: 12.4 });
    assert.equal(raw.date, ''); // unknown day
    assert.equal(raw.time, '05:30');
    assert.equal(raw.locality, 'Leipzig, Germany');
    assert.equal(raw.device, 'Zoom H5');
    assert.deepEqual(contextFromXc({ lat: 1, lng: 2 }).coords, { lat: 1, lon: 2 });
    assert.equal(contextFromXc({ lat: '', lng: '' }).coords, null);
});

test('contextFromGuano reads position, timestamp and device', () => {
    const c = contextFromGuano({ 'Loc Position': '51.5 -0.12', Timestamp: '2024-06-01T22:15:03+01:00', Make: 'Wildlife Acoustics', Model: 'SM4BAT' });
    assert.deepEqual(c.coords, { lat: 51.5, lon: -0.12 });
    assert.equal(c.date, '2024-06-01');
    assert.equal(c.time, '22:15');
    assert.equal(c.device, 'Wildlife Acoustics SM4BAT');
});

test('contextFromFilename finds recorder timestamps', () => {
    assert.deepEqual(contextFromFilename('20240512_053000.WAV'), { date: '2024-05-12', time: '05:30' });
    assert.deepEqual(contextFromFilename('SM4_20240512_053000.wav'), { date: '2024-05-12', time: '05:30' });
    assert.deepEqual(contextFromFilename('rec 2024-05-12.wav'), { date: '2024-05-12' });
    assert.deepEqual(contextFromFilename('XC12345.mp3'), {});
});

test('resolveRecordingContext: manual > XC > GUANO > file name, with sources', () => {
    const r = resolveRecordingContext({
        manual: { coords: { lat: 1, lon: 2 } },
        xc: { date: '2024-05-12', lat: 51, lng: 12 },
        guano: { Timestamp: '2023-01-01T10:00:00', Make: 'AudioMoth' },
        filename: '20220101_090000.wav',
    });
    assert.deepEqual(r.coords, { value: { lat: 1, lon: 2 }, source: 'manual' });
    assert.deepEqual(r.date, { value: '2024-05-12', source: 'xc' });
    assert.deepEqual(r.time, { value: '10:00', source: 'guano' });
    assert.deepEqual(r.device, { value: 'AudioMoth', source: 'guano' });
    assert.deepEqual(r.locality, { value: null, source: null });
});
