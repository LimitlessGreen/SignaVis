// ═══════════════════════════════════════════════════════════════════════
// audio-engine.test.mjs — Characterization tests for AudioEngine state
//
// Scope: DOM-free / AudioContext-free units only.
//   AudioEngine can be instantiated with a mock WaveSurfer constructor
//   because the constructor does not call it — WaveSurfer is only
//   instantiated inside _setupWaveSurfer() which requires a loaded source.
//
// What is NOT covered here (requires AudioContext / WaveSurfer):
//   - playSegment() / playBandpassedSegment() actual playback
//   - _segmentPlayToken race-condition prevention during concurrent calls
//   - _setupWaveSurfer WaveSurfer event wiring
//   - loadFromArrayBuffer / loadFromUrl / loadFromFile
//   - The custom AudioContext bandpass playback pipeline
//
// Those contracts will be covered once IAudioEngine is extracted (Phase 1)
// and a MockAudioEngine is available for integration-style tests (Phase 1).
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine } from '../src/infrastructure/audio/AudioEngine.ts';

// Minimal stub — constructor never calls WaveSurferCtor.
const MOCK_WS_CTOR = () => {};

// Helper: fake AudioBuffer with a given duration
function fakeAudioBuffer(duration = 10) {
    return { duration, sampleRate: 44100 };
}

// ─── Constructor / initial state ─────────────────────────────────────

test('AudioEngine: initial state after construction', () => {
    const engine = new AudioEngine(MOCK_WS_CTOR);
    assert.equal(engine.audioBuffer, null);
    assert.equal(engine.wavesurfer, null);
    assert.equal(engine.volume, 0.8);
    assert.equal(engine.muted, false);
    assert.equal(engine.preMuteVolume, 0.8);
    assert.equal(engine._segmentMode, false);
    assert.equal(engine._activeSegmentLabelId, null);
    assert.equal(engine._activeSegmentFilter, null);
    assert.equal(engine._activeSegmentStart, null);
    assert.equal(engine._activeSegmentEnd, null);
    assert.equal(engine._suppressNextPauseHandler, false);
    assert.equal(engine._segmentPlayToken, 0);
    assert.equal(engine._customSegmentPlayback, null);
    assert.equal(engine.pixelsPerSecond, 100);
    assert.equal(engine.loopPlayback, false);
});

test('AudioEngine: playbackMode is "normal" initially', () => {
    const engine = new AudioEngine(MOCK_WS_CTOR);
    assert.equal(engine.playbackMode, 'normal');
});

// ─── playbackMode getter/setter ──────────────────────────────────────

test('AudioEngine: playbackMode setter "segment" sets _segmentMode = true', () => {
    const engine = new AudioEngine(MOCK_WS_CTOR);
    engine.playbackMode = 'segment';
    assert.equal(engine._segmentMode, true);
    assert.equal(engine.playbackMode, 'segment');
});

test('AudioEngine: playbackMode setter "normal" sets _segmentMode = false', () => {
    const engine = new AudioEngine(MOCK_WS_CTOR);
    engine.playbackMode = 'segment';
    engine.playbackMode = 'normal';
    assert.equal(engine._segmentMode, false);
    assert.equal(engine.playbackMode, 'normal');
});

// ─── setVolume ───────────────────────────────────────────────────────

test('AudioEngine: setVolume stores the clamped value', () => {
    const engine = new AudioEngine(MOCK_WS_CTOR);
    engine.setVolume(0.5);
    assert.equal(engine.volume, 0.5);
});

test('AudioEngine: setVolume clamps below 0 to 0', () => {
    const engine = new AudioEngine(MOCK_WS_CTOR);
    engine.setVolume(-1);
    assert.equal(engine.volume, 0);
});

test('AudioEngine: setVolume clamps above 1 to 1', () => {
    const engine = new AudioEngine(MOCK_WS_CTOR);
    engine.setVolume(2);
    assert.equal(engine.volume, 1);
});

test('AudioEngine: setVolume(0) is valid (not clamped to a minimum)', () => {
    const engine = new AudioEngine(MOCK_WS_CTOR);
    engine.setVolume(0);
    assert.equal(engine.volume, 0);
});

// ─── toggleMute ──────────────────────────────────────────────────────

test('AudioEngine: toggleMute sets muted=true and saves preMuteVolume', () => {
    const engine = new AudioEngine(MOCK_WS_CTOR);
    engine.setVolume(0.7);
    engine.toggleMute();
    assert.equal(engine.muted, true);
    assert.equal(engine.preMuteVolume, 0.7, 'volume before mute should be saved');
});

test('AudioEngine: toggleMute twice restores original volume', () => {
    const engine = new AudioEngine(MOCK_WS_CTOR);
    engine.setVolume(0.6);
    engine.toggleMute(); // mute
    engine.toggleMute(); // unmute
    assert.equal(engine.muted, false);
    assert.equal(engine.volume, 0.6, 'volume should be restored after unmute');
});

test('AudioEngine: toggleMute while already muted restores preMuteVolume', () => {
    const engine = new AudioEngine(MOCK_WS_CTOR);
    engine.setVolume(0.4);
    engine.toggleMute();  // mute → preMuteVolume = 0.4
    engine.toggleMute();  // unmute → volume = 0.4
    assert.equal(engine.volume, 0.4);
    assert.equal(engine.muted, false);
});

// ─── isPlaying ───────────────────────────────────────────────────────

test('AudioEngine: isPlaying() returns false without wavesurfer', () => {
    const engine = new AudioEngine(MOCK_WS_CTOR);
    assert.equal(engine.isPlaying(), false);
});

test('AudioEngine: isPlaying() returns false with no custom segment playback', () => {
    const engine = new AudioEngine(MOCK_WS_CTOR);
    engine._customSegmentPlayback = null;
    assert.equal(engine.isPlaying(), false);
});

// ─── getCurrentTime ───────────────────────────────────────────────────

test('AudioEngine: getCurrentTime() returns 0 without wavesurfer', () => {
    const engine = new AudioEngine(MOCK_WS_CTOR);
    assert.equal(engine.getCurrentTime(), 0);
});

// ─── seekToTime (early-return guard) ────────────────────────────────

test('AudioEngine: seekToTime() does nothing when audioBuffer is null', () => {
    const engine = new AudioEngine(MOCK_WS_CTOR);
    let fired = 0;
    engine.addEventListener('uiupdate', () => fired++);
    engine.seekToTime(5);
    assert.equal(fired, 0, 'should not emit uiupdate when no audio is loaded');
});

// ─── updateActiveSegmentFromLabel ────────────────────────────────────

test('AudioEngine: updateActiveSegmentFromLabel is no-op when not in segment mode', () => {
    const engine = new AudioEngine(MOCK_WS_CTOR);
    engine.audioBuffer = fakeAudioBuffer(10);
    engine.playbackMode = 'normal';
    engine.updateActiveSegmentFromLabel({ id: 'x', start: 2, end: 5 });
    // State should not change
    assert.equal(engine._activeSegmentStart, null);
    assert.equal(engine._activeSegmentEnd, null);
});

test('AudioEngine: updateActiveSegmentFromLabel clamps start to [0, duration]', () => {
    const engine = new AudioEngine(MOCK_WS_CTOR);
    engine.audioBuffer = fakeAudioBuffer(10);
    engine.playbackMode = 'segment';
    engine.updateActiveSegmentFromLabel({ id: 'x', start: -5, end: 3 });
    assert.equal(engine._activeSegmentStart, 0, 'start should be clamped to 0');
});

test('AudioEngine: updateActiveSegmentFromLabel clamps end to [start+0.01, duration]', () => {
    const engine = new AudioEngine(MOCK_WS_CTOR);
    engine.audioBuffer = fakeAudioBuffer(10);
    engine.playbackMode = 'segment';
    engine.updateActiveSegmentFromLabel({ id: 'x', start: 2, end: 50 });
    assert.equal(engine._activeSegmentEnd, 10, 'end should be clamped to duration');
});

test('AudioEngine: updateActiveSegmentFromLabel does nothing when no audioBuffer', () => {
    const engine = new AudioEngine(MOCK_WS_CTOR);
    engine.playbackMode = 'segment';
    engine.updateActiveSegmentFromLabel({ id: 'x', start: 1, end: 3 });
    assert.equal(engine._activeSegmentStart, null, 'should not update without audioBuffer');
});

test('AudioEngine: updateActiveSegmentFromLabel ignores mismatched labelId', () => {
    const engine = new AudioEngine(MOCK_WS_CTOR);
    engine.audioBuffer = fakeAudioBuffer(10);
    engine.playbackMode = 'segment';
    engine._activeSegmentLabelId = 'label-A';
    engine._activeSegmentStart = 1;
    engine._activeSegmentEnd = 4;
    // Different labelId — should be ignored
    engine.updateActiveSegmentFromLabel({ id: 'label-B', start: 6, end: 9 });
    assert.equal(engine._activeSegmentStart, 1, 'segment start should not change for different label');
    assert.equal(engine._activeSegmentEnd, 4, 'segment end should not change for different label');
});

// ─── Event emission ──────────────────────────────────────────────────

test('AudioEngine: extends EventTarget — addEventListener works', () => {
    const engine = new AudioEngine(MOCK_WS_CTOR);
    let received = null;
    engine.addEventListener('transportstatechange', (e) => {
        received = /** @type {CustomEvent} */ (e).detail;
    });
    // Manually trigger a known internal emit path via stop()
    // stop() returns early if no wavesurfer — but we can call _emit directly
    engine._emit('transportstatechange', { state: 'stopped', reason: 'test' });
    assert.deepEqual(received, { state: 'stopped', reason: 'test' });
});

test('AudioEngine: _emit fires CustomEvent with detail payload', () => {
    const engine = new AudioEngine(MOCK_WS_CTOR);
    let detail = null;
    engine.addEventListener('uiupdate', (e) => {
        detail = /** @type {CustomEvent} */ (e).detail;
    });
    engine._emit('uiupdate', { time: 3.5, fromPlayback: false });
    assert.equal(detail?.time, 3.5);
    assert.equal(detail?.fromPlayback, false);
});
