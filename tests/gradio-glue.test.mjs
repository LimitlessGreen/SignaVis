// The script the Gradio component runs in the browser (python-wrapper/signavis/gradio.py,
// _JS_ON_LOAD), run against a stand-in player: a selection with play selects the detection
// and then plays it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const py = readFileSync(new URL('../python-wrapper/signavis/gradio.py', import.meta.url), 'utf8');
const script = py.match(/_JS_ON_LOAD = r"""([\s\S]*?)"""/)[1].replace('__OPTIONS__', '{}');

function run(value) {
    const calls = [];
    class Player {
        constructor() { this.ready = Promise.resolve(); this.options = {}; this.viewMode = 'spectrogram'; }
        on() {}
        loadUrl(src) { calls.push(['loadUrl', src]); return Promise.resolve(); }
        setSpectrogramLabels() {}
        selectLabel(id) { calls.push(['selectLabel', id]); }
        playSegment(s, e) { calls.push(['playSegment', s, e]); }
    }
    const node = () => ({ style: {}, textContent: '' });
    const root = node(), host = node();
    const element = { style: {}, querySelector: (q) => (q === '.signavis-host' ? host : root) };
    const window = { __signavisPortals: true, __signavisTheme: true, BirdNETPlayerModule: { BirdNETPlayer: Player } };
    const props = { value };
    const watch = () => {};
    new Function('element', 'props', 'watch', 'trigger', 'window', script)
        .call(null, element, props, watch, () => {}, window);
    return { calls, done: () => new Promise((r) => setTimeout(r, 20)) };
}

test('a selection with play selects the detection first, then plays it', async () => {
    const { calls, done } = run({ src: 'a.wav', select: { start: 1, end: 2, play: true, id: 'det-3', n: 1 } });
    await done();
    assert.deepEqual(calls.slice(1), [['selectLabel', 'det-3'], ['playSegment', 1, 2]]);
});

test('a selection without play only selects', async () => {
    const { calls, done } = run({ src: 'a.wav', select: { start: 1, end: 2, play: false, id: 'det-3', n: 1 } });
    await done();
    assert.deepEqual(calls.slice(1), [['selectLabel', 'det-3']]);
});
