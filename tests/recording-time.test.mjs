// recording-time.test.mjs — recording start from metadata and file names
import test from 'node:test';
import assert from 'node:assert/strict';
import { readRecordingStart, recordingStartFromFileName, isoClockTime, ravenClock, utcLabel } from '../src/domain/recordingTime.ts';
import { buildRavenSelectionTable } from '../src/infrastructure/export/ravenSelectionTable.ts';

function riff(chunks) {
    const parts = chunks.map(([id, body]) => {
        const b = typeof body === 'string' ? new TextEncoder().encode(body) : body;
        const out = new Uint8Array(8 + b.length + (b.length & 1));
        out.set(new TextEncoder().encode(id), 0);
        new DataView(out.buffer).setUint32(4, b.length, true);
        out.set(b, 8);
        return out;
    });
    const size = parts.reduce((n, p) => n + p.length, 4);
    const out = new Uint8Array(8 + size);
    out.set(new TextEncoder().encode('RIFF'), 0);
    new DataView(out.buffer).setUint32(4, size, true);
    out.set(new TextEncoder().encode('WAVE'), 8);
    let o = 12;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out.buffer;
}

function info(sub, value) {
    const v = new TextEncoder().encode(value + '\0');
    const b = new Uint8Array(4 + 8 + v.length + (v.length & 1));
    b.set(new TextEncoder().encode('INFO'), 0);
    b.set(new TextEncoder().encode(sub), 4);
    new DataView(b.buffer).setUint32(8, v.length, true);
    b.set(v, 12);
    return b;
}

test('AudioMoth comment with time zone', () => {
    const buf = riff([['fmt ', new Uint8Array(16)], ['LIST', info('ICMT', 'Recorded at 19:00:00 12/05/2023 (UTC+1) by AudioMoth 24A04F0000000000')], ['data', new Uint8Array(4)]]);
    const s = readRecordingStart(buf, 'x.wav');
    assert.equal(s.source, 'AudioMoth');
    assert.equal(s.tz, 60);
    assert.equal(isoClockTime(s, 3.5), '2023-05-12T19:00:03.500+01:00');
});

test('GUANO timestamp wins over the file name', () => {
    const buf = riff([['data', new Uint8Array(4)], ['guan', 'GUANO|Version: 1.0\nTimestamp: 2022-08-01T22:15:30Z\n']]);
    const s = readRecordingStart(buf, '20200101_000000.wav');
    assert.equal(s.source, 'GUANO');
    assert.equal(s.tz, 0);
    assert.equal(isoClockTime(s), '2022-08-01T22:15:30.000Z');
});

test('BWF bext origination date and time', () => {
    const b = new Uint8Array(400);
    b.set(new TextEncoder().encode('2021-03-04'), 320);
    b.set(new TextEncoder().encode('05:06:07'), 330);
    const s = readRecordingStart(riff([['bext', b]]), 'x.wav');
    assert.equal(s.source, 'BWF');
    assert.equal(s.tz, null);
    assert.deepEqual(ravenClock(s, 1, 2), ['2021-03-04', '05:06:08.000', '05:06:09.000']);
});

test('file names', () => {
    assert.equal(recordingStartFromFileName('SMA01234_20230512_190000.wav').ms, Date.UTC(2023, 4, 12, 19, 0, 0));
    assert.equal(recordingStartFromFileName('2023-05-12 19-00-00.flac').ms, Date.UTC(2023, 4, 12, 19, 0, 0));
    assert.equal(recordingStartFromFileName('20230431_190000.wav'), null); // 31 April
    assert.equal(recordingStartFromFileName('birdsong.wav'), null);
    assert.equal(readRecordingStart(new ArrayBuffer(4), 'folder/20230512T190000.mp3').source, 'fileName');
});

test('utcLabel', () => {
    assert.equal(utcLabel(null), '');
    assert.equal(utcLabel(0), 'UTC');
    assert.equal(utcLabel(330), 'UTC+5:30');
    assert.equal(utcLabel(-300), 'UTC-5');
});

test('Raven table gets clock-time columns only with a known start', () => {
    const labels = [{ start: 1, end: 2, label: 'x' }];
    assert.ok(!buildRavenSelectionTable(labels).includes('Begin Clock Time'));
    const t = buildRavenSelectionTable(labels, { recordingStart: { ms: Date.UTC(2023, 0, 1, 6, 0, 0), tz: null, source: 'fileName' } });
    const [head, row] = t.trim().split('\n').map((l) => l.split('\t'));
    assert.deepEqual(head.slice(-3), ['Begin Date', 'Begin Clock Time', 'End Clock Time']);
    assert.deepEqual(row.slice(-3), ['2023-01-01', '06:00:01.000', '06:00:02.000']);
});
