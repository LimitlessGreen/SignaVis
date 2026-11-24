// Output graph: the media element always plays through a running AudioContext (a bare element
// opens its output on every play: 0.1-0.5 s of silence). Idle for a while → suspended.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine } from '../src/infrastructure/audio/AudioEngine.ts';

function fakeEnv() {
    const listeners = {};
    const el = {
        paused: true,
        addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
        removeEventListener: (t, f) => { listeners[t] = (listeners[t] || []).filter((g) => g !== f); },
        fire: (t) => (listeners[t] || []).forEach((f) => f()),
        listeners,
    };
    const contexts = [];
    class FakeCtx {
        constructor() { this.state = 'suspended'; this.outputLatency = 0.048; this.baseLatency = 0.01; this.destination = {}; contexts.push(this); }
        createMediaElementSource() { return { connect() {} }; }
        createGain() { return { gain: { value: 1 }, connect() {} }; }
        resume() { this.state = 'running'; return Promise.resolve(); }
        suspend() { this.state = 'suspended'; return Promise.resolve(); }
        close() { this.state = 'closed'; return Promise.resolve(); }
    }
    globalThis.window = { AudioContext: FakeCtx };
    let volume = null;
    const engine = new AudioEngine(() => {});
    engine.wavesurfer = { getMediaElement: () => el, setVolume: (v) => { volume = v; } };
    return { engine, el, contexts, volume: () => volume };
}

test('without normalizing, playback still goes through the output context', () => {
    const { engine, contexts, volume } = fakeEnv();
    engine.setVolume(0.5);
    assert.equal(contexts.length, 1);
    assert.ok(engine._mediaGraph);
    assert.equal(engine._mediaGraph.gain.gain.value, 0.5);
    assert.equal(volume(), 1, 'level set by the GainNode, element at full volume');
    engine.toggleMute();
    assert.equal(engine._mediaGraph.gain.gain.value, 0);
});

test('outputLatency: the running context latency, 0 while suspended', () => {
    const { engine, el } = fakeEnv();
    engine.setVolume(0.8);
    assert.equal(engine.outputLatency(), 0);
    el.fire('play');
    assert.equal(engine.outputLatency(), 0.048);
});

test('idle after a pause: the context is suspended, play resumes it', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { engine, el, contexts } = fakeEnv();
    engine.setVolume(0.8);
    el.fire('play');
    el.paused = true;
    el.fire('pause');
    t.mock.timers.tick(AudioEngine.OUTPUT_IDLE_MS - 1);
    assert.equal(contexts[0].state, 'running');
    t.mock.timers.tick(1);
    assert.equal(contexts[0].state, 'suspended');
    el.fire('play');
    assert.equal(contexts[0].state, 'running');
    // Closing the graph removes the element listeners
    engine._closeMediaGraph();
    assert.equal((el.listeners.play || []).length, 0);
    assert.equal((el.listeners.pause || []).length, 0);
});
