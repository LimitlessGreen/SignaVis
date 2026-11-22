// startRecording loads the recorder on first use; a second call while it loads
// must be refused like one during a recording.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BirdNETPlayer } from '../src/app/BirdNETPlayer.ts';

function bare() {
    const p = Object.create(BirdNETPlayer.prototype);
    Object.assign(p, {
        _liveRecorder: null, _liveView: null, _liveLoading: false,
        _state: { d: {}, _showSpectrogram: false }, container: {},
        pause() {}, _emit() {},
    });
    return p;
}

test('recordingSupported answers without loading the recorder', () => {
    assert.equal(typeof BirdNETPlayer.recordingSupported, 'boolean');
});

test('second startRecording while the recorder loads is refused', async () => {
    const p = bare();
    const first = p.startRecording().catch((e) => e);   // fails later (no DOM / mic in node)
    await assert.rejects(p.startRecording(), /Already recording/);
    await first;
    assert.equal(p._liveLoading, false);
});
