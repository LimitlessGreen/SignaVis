import test from 'node:test';
import assert from 'node:assert/strict';
import {
    channelSelectionKey, parseChannelSelection, effectiveSelection, mixChannels, selectedSamples,
    isChannelZero, channelLabel, getChannelSelection, setChannelSelection, onChannelSelectionChange,
} from '../src/shared/channels.ts';

/** Minimal AudioBuffer stand-in. */
function buffer(...channels) {
    const data = channels.map((c) => Float32Array.from(c));
    return { numberOfChannels: data.length, length: data[0].length, sampleRate: 48000, getChannelData: (c) => data[c] };
}

test('keys round-trip; junk falls back to mix', () => {
    for (const sel of [{ mode: 'mix' }, { mode: 'single', channel: 0 }, { mode: 'single', channel: 7 }]) {
        assert.deepEqual(parseChannelSelection(channelSelectionKey(sel)), sel);
    }
    assert.deepEqual(parseChannelSelection(null), { mode: 'mix' });
    assert.deepEqual(parseChannelSelection('ch:-1'), { mode: 'mix' });
});

test('effectiveSelection: mono is always channel 0, out-of-range channel becomes mix', () => {
    assert.deepEqual(effectiveSelection({ mode: 'mix' }, 1), { mode: 'single', channel: 0 });
    assert.deepEqual(effectiveSelection({ mode: 'single', channel: 3 }, 2), { mode: 'mix' });
    assert.deepEqual(effectiveSelection({ mode: 'single', channel: 1 }, 2), { mode: 'single', channel: 1 });
});

test('mixChannels averages', () => {
    assert.deepEqual([...mixChannels([[1, 2], [3, -2]], 2)], [2, 0]);
});

test('selectedSamples: a right-only call is visible in R and mix, not in L', () => {
    const buf = buffer([0, 0, 0], [0, 1, 0]);
    assert.deepEqual([...selectedSamples(buf, { mode: 'single', channel: 0 })], [0, 0, 0]);
    assert.deepEqual([...selectedSamples(buf, { mode: 'single', channel: 1 })], [0, 1, 0]);
    assert.deepEqual([...selectedSamples(buf, { mode: 'mix' })], [0, 0.5, 0]);
    assert.equal(selectedSamples(buf, { mode: 'mix' }), selectedSamples(buf, { mode: 'mix' }), 'mix is cached');
});

test('selectedSamples on mono returns the channel itself', () => {
    const buf = buffer([1, 2, 3]);
    assert.equal(selectedSamples(buf, { mode: 'mix' }), buf.getChannelData(0));
    assert.ok(isChannelZero(buf, { mode: 'mix' }));
    assert.ok(!isChannelZero(buffer([1], [2]), { mode: 'mix' }));
});

test('labels', () => {
    assert.equal(channelLabel({ mode: 'mix' }, 2), 'Mix');
    assert.equal(channelLabel({ mode: 'single', channel: 1 }, 2), 'R');
    assert.equal(channelLabel({ mode: 'single', channel: 2 }, 4), 'Ch 3');
});

test('global selection notifies listeners only on change', () => {
    const seen = [];
    const off = onChannelSelectionChange((s) => seen.push(channelSelectionKey(s)));
    const before = getChannelSelection();
    setChannelSelection({ mode: 'single', channel: 1 });
    setChannelSelection({ mode: 'single', channel: 1 });
    setChannelSelection(before);
    off();
    setChannelSelection({ mode: 'single', channel: 1 });
    setChannelSelection(before);
    assert.deepEqual(seen, ['ch:1', channelSelectionKey(before)]);
});

test('divisionNoiseLevel is cached per channel selection, not per buffer', async () => {
    const { divisionNoiseLevel } = await import('../src/infrastructure/audio/detectorRender.ts');
    const dsp = { divisionNoiseLevel: (s) => Math.max(...s.map(Math.abs)) };
    const buf = buffer([0.1, -0.1, 0.1, -0.1], [0.4, -0.4, 0.4, -0.4]);
    setChannelSelection({ mode: 'single', channel: 0 });
    const left = divisionNoiseLevel(dsp, buf);
    setChannelSelection({ mode: 'single', channel: 1 });
    const right = divisionNoiseLevel(dsp, buf);
    setChannelSelection({ mode: 'mix' });
    assert.ok(Math.abs(left - 0.1) < 1e-6, `left ${left}`);
    assert.ok(Math.abs(right - 0.4) < 1e-6, `right ${right}`);
});

test('spectrogram cache key differs per channel even when the sample fingerprint matches', async () => {
    const { withChannelKey } = await import('../src/shared/channels.ts');
    const { spectrogramCache } = await import('../src/infrastructure/SpectrogramCache.ts');
    // Same start, middle and end (the fingerprinted parts), different elsewhere.
    const n = 20000;
    const l = new Float32Array(n), r = new Float32Array(n);
    r[6000] = 1;
    const opts = { fftSize: 1024 };
    const keyOf = (data, sel) => spectrogramCache.computeKey(data, 48000, withChannelKey(opts, 2, sel));
    assert.notEqual(await keyOf(l, { mode: 'single', channel: 0 }), await keyOf(r, { mode: 'single', channel: 1 }));
    assert.equal(await keyOf(l, { mode: 'single', channel: 0 }), await keyOf(l, { mode: 'single', channel: 0 }));
    assert.equal(withChannelKey(opts, 1), opts, 'mono keys stay as they were');
});
