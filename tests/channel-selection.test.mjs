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
