import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileMetadata } from '../src/domain/fileMetadata.ts';
import { contextFromStart, resolveRecordingContext } from '../src/app/recording-context.ts';
import { mapXenoCantoLabelsToSpectrogram } from '../src/infrastructure/xeno-canto/xenoCantoRecordingsApi.ts';

const enc = new TextEncoder();
function chunk(id, body) {
    const pad = body.length & 1;
    const out = new Uint8Array(8 + body.length + pad);
    out.set(enc.encode(id), 0);
    new DataView(out.buffer).setUint32(4, body.length, true);
    out.set(body, 8);
    return out;
}
function wav(...chunks) {
    const body = [enc.encode('WAVE'), ...chunks];
    const size = body.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(8 + size);
    out.set(enc.encode('RIFF'), 0);
    new DataView(out.buffer).setUint32(4, size, true);
    let p = 8;
    for (const c of body) { out.set(c, p); p += c.length; }
    return out;
}
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
function bext({ desc = '', orig = '', date = '', time = '', history = '' }) {
    const b = new Uint8Array(602 + history.length);
    b.set(enc.encode(desc), 0); b.set(enc.encode(orig), 256); b.set(enc.encode(date), 320); b.set(enc.encode(time), 330);
    b.set(enc.encode(history), 602);
    return b;
}

test('reads GUANO, bext, INFO and AudioMoth groups', () => {
    const info = cat(enc.encode('INFO'),
        chunk('INAM', enc.encode('Dawn chorus\0')),
        chunk('ICMT', enc.encode('Recorded at 05:30:00 12/05/2024 (UTC+2) by AudioMoth 24F31901 at medium gain\0')),
        chunk('ISFT', enc.encode('Lavf60\0')));
    const g = readFileMetadata(wav(
        chunk('fmt ', new Uint8Array(16)),
        chunk('guan', enc.encode('GUANO|Version:1.0\nMake:Wildlife Acoustics\nWA|Song Meter|Prefix:SMM\nTemperature Int:12.5\n')),
        chunk('bext', bext({ desc: 'Forest edge', orig: 'ZOOM F3', date: '2024-05-12', time: '05:30:00', history: 'A=PCM,F=48000' })),
        chunk('LIST', info),
    ));
    const by = Object.fromEntries(g.map((x) => [x.source, Object.fromEntries(x.entries)]));
    assert.deepEqual(by.GUANO, { Make: 'Wildlife Acoustics', 'WA|Song Meter|Prefix': 'SMM', 'Temperature Int': '12.5' });
    assert.equal(by.BWF.Description, 'Forest edge');
    assert.equal(by.BWF.Originator, 'ZOOM F3');
    assert.equal(by.BWF.Origination, '2024-05-12 05:30:00');
    assert.equal(by.BWF['Coding history'], 'A=PCM,F=48000');
    assert.deepEqual(by['WAV INFO'], { Title: 'Dawn chorus', Software: 'Lavf60' });
    assert.match(by.AudioMoth.Comment, /^Recorded at 05:30:00 .* AudioMoth 24F31901/);
});

test('no metadata → no groups; AudioMoth comment found in a non-WAV head', () => {
    assert.deepEqual(readFileMetadata(wav(chunk('fmt ', new Uint8Array(16)))), []);
    assert.deepEqual(readFileMetadata(null), []);
    const flac = cat(enc.encode('fLaC'), new Uint8Array(40), enc.encode('Recorded at 19:00:00 01/06/2023 (UTC) by AudioMoth 1234 at low gain\0'));
    assert.equal(readFileMetadata(flac)[0].source, 'AudioMoth');
});

test('contextFromStart: header sources only, wall-clock time kept', () => {
    const ms = Date.UTC(2024, 4, 12, 5, 30, 0);
    assert.deepEqual(contextFromStart({ ms, source: 'BWF' }), { date: '2024-05-12', time: '05:30' });
    assert.deepEqual(contextFromStart({ ms, source: 'fileName' }), {});
    assert.deepEqual(contextFromStart(null), {});
});

test('header start ranks below GUANO and above the file name', () => {
    const start = { ms: Date.UTC(2024, 4, 12, 5, 30), source: 'AudioMoth' };
    const a = resolveRecordingContext({ start, filename: '20230101_120000.wav' });
    assert.equal(a.date.value, '2024-05-12'); assert.equal(a.date.source, 'header');
    const b = resolveRecordingContext({ start, guano: { Timestamp: '2022-02-02T02:02:00' } });
    assert.equal(b.date.source, 'guano');
});

test('XC import keeps device, microphone, sound type, sex, stage and temperature', () => {
    const { recordingMeta } = mapXenoCantoLabelsToSpectrogram([], {
        xcId: '123', recording: { gen: 'Turdus', sp: 'merula', rec: 'A. B.', type: 'song', sex: 'male', stage: 'adult', dvc: 'Zoom H5', mic: 'Telinga', temp: '14 °C' },
    });
    assert.equal(recordingMeta.soundType, 'song');
    assert.equal(recordingMeta.sex, 'male');
    assert.equal(recordingMeta.stage, 'adult');
    assert.equal(recordingMeta.device, 'Zoom H5');
    assert.equal(recordingMeta.microphone, 'Telinga');
    assert.equal(recordingMeta.temperature, '14 °C');
});
