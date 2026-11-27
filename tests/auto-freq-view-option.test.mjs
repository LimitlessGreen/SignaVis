// The automatic frequency view (zoom to where the recording has content) can be turned off,
// e.g. by a host app; off shows the full range at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayerState } from '../src/app/PlayerState.ts';

function fake(bandProfile = {}) {
    const calls = [];
    return {
        calls,
        bandProfile,
        applyAutoFreqView() { calls.push('auto'); },
        _freqZoom: { reset() { calls.push('reset'); }, refresh() { calls.push('refresh'); } },
    };
}

test('turning the auto view off shows the full range', () => {
    const s = fake();
    PlayerState.prototype.setAutoFreqView.call(s, false);
    assert.equal(s.autoFreqView, false);
    assert.deepEqual(s.calls, ['reset', 'refresh']);
});

test('turning it on frames the loaded recording', () => {
    const s = fake();
    PlayerState.prototype.setAutoFreqView.call(s, true);
    assert.deepEqual(s.calls, ['auto']);
});

test('without a spectrogram only the setting changes', () => {
    const s = fake(null);
    PlayerState.prototype.setAutoFreqView.call(s, false);
    assert.deepEqual(s.calls, []);
});
