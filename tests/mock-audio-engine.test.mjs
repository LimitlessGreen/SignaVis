// ═══════════════════════════════════════════════════════════════════════
// mock-audio-engine.test.mjs — Tests for MockAudioEngine
//
// Verifies that MockAudioEngine correctly implements the AudioEngineBase
// contract for headless / test use without AudioContext or WaveSurfer.
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { MockAudioEngine } from '../src/infrastructure/audio/MockAudioEngine.ts';
import { AudioEngineBase } from '../src/infrastructure/audio/AudioEngineBase.ts';

// ─── Class relationship ───────────────────────────────────────────────

test('MockAudioEngine: extends AudioEngineBase', () => {
    const engine = new MockAudioEngine();
    assert.ok(engine instanceof AudioEngineBase);
});

test('MockAudioEngine: extends EventTarget', () => {
    const engine = new MockAudioEngine();
    assert.ok(engine instanceof EventTarget);
});

// ─── Initial state ────────────────────────────────────────────────────

test('MockAudioEngine: initial state', () => {
    const engine = new MockAudioEngine();
    assert.equal(engine.audioBuffer, null);
    assert.equal(engine.wavesurfer, null);
    assert.equal(engine.volume, 0.8);
    assert.equal(engine.muted, false);
    assert.equal(engine.playbackMode, 'normal');
    assert.equal(engine.isPlaying(), false);
    assert.equal(engine.getCurrentTime(), 0);
    assert.equal(engine.loopPlayback, false);
});

// ─── loadFromUrl ──────────────────────────────────────────────────────

test('MockAudioEngine: loadFromUrl sets audioBuffer and emits ready', async () => {
    const engine = new MockAudioEngine();
    let ready = null;
    engine.addEventListener('ready', (e) => { ready = /** @type {CustomEvent} */ (e).detail; });
    const result = await engine.loadFromUrl('https://example.com/audio.wav');
    assert.ok(engine.audioBuffer !== null, 'audioBuffer should be set after load');
    assert.ok(result.duration > 0);
    assert.ok(result.sampleRate > 0);
    assert.deepEqual(ready, { duration: result.duration, sampleRate: result.sampleRate });
});

// ─── Transport ────────────────────────────────────────────────────────

test('MockAudioEngine: playPause transitions to playing and emits events', async () => {
    const engine = new MockAudioEngine();
    await engine.loadFromUrl('https://example.com/audio.wav');
    const events = [];
    engine.addEventListener('transportstatechange', (e) => events.push(/** @type {CustomEvent} */ (e).detail.state));
    engine.addEventListener('play', () => events.push('play'));
    engine.playPause();
    assert.ok(events.includes('playing'));
    assert.ok(events.includes('play'));
    assert.equal(engine.isPlaying(), true);
});

test('MockAudioEngine: playPause twice toggles back to paused', async () => {
    const engine = new MockAudioEngine();
    await engine.loadFromUrl('https://example.com/audio.wav');
    engine.playPause();
    engine.playPause();
    assert.equal(engine.isPlaying(), false);
});

test('MockAudioEngine: stop resets time to 0 and emits stopped', async () => {
    const engine = new MockAudioEngine();
    await engine.loadFromUrl('https://example.com/audio.wav');
    engine.seekToTime(5);
    let stoppedState = null;
    engine.addEventListener('transportstatechange', (e) => {
        if (/** @type {CustomEvent} */ (e).detail.state === 'stopped') stoppedState = 'stopped';
    });
    engine.stop();
    assert.equal(engine.getCurrentTime(), 0);
    assert.equal(stoppedState, 'stopped');
});

// ─── Seek ─────────────────────────────────────────────────────────────

test('MockAudioEngine: seekToTime updates currentTime and emits uiupdate', async () => {
    const engine = new MockAudioEngine();
    await engine.loadFromUrl('https://example.com/audio.wav');
    let uiTime = null;
    engine.addEventListener('uiupdate', (e) => { uiTime = /** @type {CustomEvent} */ (e).detail.time; });
    engine.seekToTime(3.5);
    assert.equal(engine.getCurrentTime(), 3.5);
    assert.equal(uiTime, 3.5);
});

test('MockAudioEngine: seekToTime clamps to [0, duration]', async () => {
    const engine = new MockAudioEngine();
    await engine.loadFromUrl('https://example.com/audio.wav');
    const dur = engine.audioBuffer.duration;
    engine.seekToTime(-5);
    assert.equal(engine.getCurrentTime(), 0);
    engine.seekToTime(dur + 100);
    assert.equal(engine.getCurrentTime(), dur);
});

test('MockAudioEngine: seekToTime no-op when no audioBuffer', () => {
    const engine = new MockAudioEngine();
    let fired = 0;
    engine.addEventListener('uiupdate', () => fired++);
    engine.seekToTime(5);
    assert.equal(fired, 0);
    assert.equal(engine.getCurrentTime(), 0);
});

test('MockAudioEngine: seekByDelta moves time relatively', async () => {
    const engine = new MockAudioEngine();
    await engine.loadFromUrl('https://example.com/audio.wav');
    engine.seekToTime(4);
    engine.seekByDelta(2);
    assert.equal(engine.getCurrentTime(), 6);
});

// ─── Volume / Mute ────────────────────────────────────────────────────

test('MockAudioEngine: setVolume clamps to [0, 1]', () => {
    const engine = new MockAudioEngine();
    engine.setVolume(1.5);
    assert.equal(engine.volume, 1);
    engine.setVolume(-0.1);
    assert.equal(engine.volume, 0);
});

test('MockAudioEngine: toggleMute saves and restores volume', () => {
    const engine = new MockAudioEngine();
    engine.setVolume(0.6);
    engine.toggleMute();
    assert.equal(engine.muted, true);
    assert.equal(engine.preMuteVolume, 0.6);
    engine.toggleMute();
    assert.equal(engine.muted, false);
    assert.equal(engine.volume, 0.6);
});

// ─── Segment playback ─────────────────────────────────────────────────

test('MockAudioEngine: playSegment switches to segment mode and emits segmentstart', async () => {
    const engine = new MockAudioEngine();
    await engine.loadFromUrl('https://example.com/audio.wav');
    let segDetail = null;
    engine.addEventListener('segmentstart', (e) => { segDetail = /** @type {CustomEvent} */ (e).detail; });
    engine.playSegment(2, 5);
    assert.equal(engine.playbackMode, 'segment');
    assert.equal(engine._activeSegmentStart, 2);
    assert.equal(engine._activeSegmentEnd, 5);
    assert.ok(segDetail, 'segmentstart should be emitted');
    assert.equal(segDetail.start, 2);
    assert.equal(segDetail.end, 5);
});

test('MockAudioEngine: stopSegmentPlayback clears segment state', async () => {
    const engine = new MockAudioEngine();
    await engine.loadFromUrl('https://example.com/audio.wav');
    engine.playSegment(2, 5);
    engine.stopSegmentPlayback('stopped', 5);
    assert.equal(engine.playbackMode, 'normal');
    assert.equal(engine._activeSegmentStart, null);
    assert.equal(engine._activeSegmentEnd, null);
});

// ─── updateActiveSegmentFromLabel ─────────────────────────────────────

test('MockAudioEngine: updateActiveSegmentFromLabel no-op when not in segment mode', async () => {
    const engine = new MockAudioEngine();
    await engine.loadFromUrl('https://example.com/audio.wav');
    engine.updateActiveSegmentFromLabel({ id: 'x', start: 1, end: 3 });
    assert.equal(engine._activeSegmentStart, null);
});

test('MockAudioEngine: updateActiveSegmentFromLabel updates bounds in segment mode', async () => {
    const engine = new MockAudioEngine();
    await engine.loadFromUrl('https://example.com/audio.wav');
    engine.playSegment(2, 5);
    engine._activeSegmentLabelId = 'lbl1';
    engine.updateActiveSegmentFromLabel({ id: 'lbl1', start: 3, end: 7 });
    assert.equal(engine._activeSegmentStart, 3);
    assert.equal(engine._activeSegmentEnd, 7);
});

// ─── destroy ─────────────────────────────────────────────────────────

test('MockAudioEngine: destroy clears audioBuffer and stops playing', async () => {
    const engine = new MockAudioEngine();
    await engine.loadFromUrl('https://example.com/audio.wav');
    engine.playPause();
    engine.destroy();
    assert.equal(engine.audioBuffer, null);
    assert.equal(engine.isPlaying(), false);
});
