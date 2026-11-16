// live-recorder.test.mjs — WAV of a microphone recording carries its start time
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, recordingFileName } from '../src/infrastructure/audio/LiveRecorder.ts';
import { readRecordingStart } from '../src/domain/recordingTime.ts';

test('encodeWav writes mono 16-bit PCM with an INFO start time', async () => {
    const chunks = [Float32Array.from([0, 0.5, -0.5]), Float32Array.from([1, -1])];
    const blob = encodeWav(chunks, 48000, { ICRD: '2026-11-15T14:30:12+01:00', ISFT: 'SignaVis' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    const v = new DataView(buf.buffer);
    const tag = (o) => String.fromCharCode(...buf.subarray(o, o + 4));
    assert.equal(tag(0), 'RIFF');
    assert.equal(v.getUint32(4, true), buf.length - 8);
    assert.equal(v.getUint16(22, true), 1);
    assert.equal(v.getUint32(24, true), 48000);
    const dataAt = buf.length - 10 - 8;
    assert.equal(tag(dataAt), 'data');
    assert.equal(v.getUint32(dataAt + 4, true), 10);
    assert.deepEqual([...new Int16Array(buf.slice(dataAt + 8).buffer)], [0, 16383, -16384, 32767, -32768]);

    const start = readRecordingStart(buf.buffer, 'Recording.wav');
    assert.equal(start.source, 'WAV INFO');
    assert.equal(start.tz, 60);
    assert.equal(start.ms, Date.UTC(2026, 10, 15, 14, 30, 12));
});

test('recordingFileName uses the local date and time', () => {
    assert.equal(recordingFileName(new Date(2026, 0, 2, 3, 4, 5)), 'Recording_20260102_030405.wav');
});

test('a recorder stopped before start() never opens the microphone', async () => {
    const { LiveRecorder } = await import('../src/infrastructure/audio/LiveRecorder.ts');
    let asked = 0, stopped = 0;
    const g = globalThis;
    const saved = { nav: Object.getOwnPropertyDescriptor(g, 'navigator'), ac: g.AudioContext };
    let grant;
    Object.defineProperty(g, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => { asked++; return new Promise((r) => { grant = r; }); } } } });
    g.AudioContext = class { constructor() { throw new Error('graph must not be built'); } };
    try {
        const rec = new LiveRecorder();
        const starting = rec.start();
        await new Promise((r) => setTimeout(r, 0));
        assert.equal(await rec.stop(), null);       // cancelled while permission is pending
        grant({ getTracks: () => [{ stop: () => { stopped++; } }] });
        await assert.rejects(starting, /cancelled/);
        assert.equal(asked, 1);
        assert.equal(stopped, 1);                   // the late stream is released
        assert.equal(rec.recording, false);
    } finally {
        if (saved.nav) Object.defineProperty(g, 'navigator', saved.nav); else delete g.navigator;
        g.AudioContext = saved.ac;
    }
});
