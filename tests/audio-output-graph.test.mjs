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

function wsSetup() {
    const env = fakeEnv();
    let playing = true, time = 2.5, segEnd = null;
    const events = {};
    const ws = {
        getMediaElement: () => env.el, setVolume() {}, isPlaying: () => playing, getCurrentTime: () => time,
        setTime: (t) => { time = t; }, pause: () => { playing = false; },
        on: (t, f) => { events[t] = f; }, load() {}, loadBlob() {}, zoom() {}, destroy() {},
    };
    env.engine.wavesurfer = null;
    env.engine._WaveSurferCtor = { create: () => ws };
    env.engine._setupWaveSurfer(null, 'x');
    env.engine.setVolume(0.8);
    env.el.fire('play');
    return { ...env, ws, time: () => time, setSegEnd: (v) => { env.engine._activeSegmentEnd = v; } };
}

test('pause lands on the audible position (clock minus output latency), not ahead of the playhead', () => {
    const { ws, time } = wsSetup();
    ws.pause();
    assert.ok(Math.abs(time() - (2.5 - 0.048)) < 1e-9, `${time()}`);
    ws.pause();                       // already paused: no further step back
    assert.ok(Math.abs(time() - (2.5 - 0.048)) < 1e-9);
});

test('pause at the end of a played segment stays at the end', () => {
    const { ws, time, setSegEnd } = wsSetup();
    setSegEnd(2.5);
    ws.pause();
    assert.equal(time(), 2.5);
});

test('pause uses the position the display shows, when it is plausible', () => {
    const { engine, ws, time } = wsSetup();
    engine.shownPlaybackTime = () => 2.42;   // playhead trails the audible 2.452 a little
    ws.pause();
    assert.equal(time(), 2.42);
});

test('an implausible shown position (seek, stale) falls back to clock minus latency', () => {
    const { engine, ws, time } = wsSetup();
    engine.shownPlaybackTime = () => 1.0;
    ws.pause();
    assert.ok(Math.abs(time() - 2.452) < 1e-9, `${time()}`);
});
