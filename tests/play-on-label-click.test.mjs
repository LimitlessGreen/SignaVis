// options.playOnLabelClick: a label the user clicks also plays; selectLabel() from the host,
// ctrl-click and hover do not. Playing waits for the click's own handlers (a seek there stops segments).
import test from 'node:test';
import assert from 'node:assert/strict';
import { BirdNETPlayer } from '../src/app/BirdNETPlayer.ts';

function bare(options) {
    const p = Object.create(BirdNETPlayer.prototype);
    const played = [];
    Object.assign(p, {
        options,
        _linkedLabels: new Map([['a', { id: 'a', start: 1, end: 2 }]]),
        playLabelSegment: (l) => played.push(l.id),
    });
    return { p, played };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('with playOnLabelClick a clicked label plays after the click handlers', async () => {
    const { p, played } = bare({ playOnLabelClick: true });
    p._playClickedLabel({ id: 'a', source: 'spectrogram', interaction: 'click' });
    assert.deepEqual(played, [], 'not yet: the click may still seek');
    await tick();
    assert.deepEqual(played, ['a']);
    p._playClickedLabel({ id: 'a', source: 'table', interaction: 'click' });
    await tick();
    assert.deepEqual(played, ['a', 'a']);
});

test('selectLabel(), ctrl-click, hover, unknown ids and the default do not play', async () => {
    const { p, played } = bare({ playOnLabelClick: true });
    p._playClickedLabel({ id: 'a', source: 'api', interaction: 'click' });
    p._playClickedLabel({ id: 'a', source: 'spectrogram', interaction: 'ctrl-click' });
    p._playClickedLabel({ id: 'a', source: 'spectrogram', interaction: 'hover' });
    p._playClickedLabel({ id: 'x', source: 'spectrogram', interaction: 'click' });
    p._playClickedLabel({ id: null, source: 'spectrogram', interaction: 'click' });
    const off = bare({});
    off.p._playClickedLabel({ id: 'a', source: 'spectrogram', interaction: 'click' });
    await tick();
    assert.deepEqual(played, []);
    assert.deepEqual(off.played, []);
});
