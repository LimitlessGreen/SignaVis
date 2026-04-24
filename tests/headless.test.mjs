// ═══════════════════════════════════════════════════════════════════════
// headless.test.mjs — Integration tests for headless / host-agnostic use
//
// Demonstrates that MockAudioEngine + InMemoryStorageAdapter enable the
// library to run without a browser, WaveSurfer, or AudioContext.
//
// Target use-cases verified here:
//   • Python wrappers (Gradio, Streamlit) embedding the player
//   • Storybook / demo environments without real audio
//   • Unit tests that need AudioEngine event behaviour
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { MockAudioEngine } from '../src/infrastructure/audio/MockAudioEngine.ts';
import { AudioEngineBase } from '../src/infrastructure/audio/AudioEngineBase.ts';
import { InMemoryStorageAdapter } from '../src/infrastructure/storage/InMemoryStorageAdapter.ts';
import { UndoStack } from '../src/domain/undoStack.ts';
import { FrequencyViewport } from '../src/app/FrequencyViewport.ts';

// ─── 1. MockAudioEngine satisfies AudioEngineBase contract ───────────

test('Headless: MockAudioEngine is an AudioEngineBase instance', () => {
    const engine = new MockAudioEngine();
    assert.ok(engine instanceof AudioEngineBase);
    assert.ok(engine instanceof EventTarget);
});

test('Headless: MockAudioEngine round-trip load → play → stop', async () => {
    const engine = new MockAudioEngine();
    const events = [];
    engine.addEventListener('transportstatechange', (e) => {
        events.push(/** @type {CustomEvent} */ (e).detail.state);
    });

    await engine.loadFromUrl('https://example.com/bird.wav');
    assert.ok(engine.audioBuffer !== null, 'audioBuffer should be set');

    engine.playPause();
    assert.equal(engine.isPlaying(), true);
    assert.ok(events.includes('playing'), 'should have transitioned to playing');

    engine.stop();
    assert.equal(engine.isPlaying(), false);
    assert.ok(events.includes('stopped'), 'should have transitioned to stopped');
});

test('Headless: MockAudioEngine segment playback emits events', async () => {
    const engine = new MockAudioEngine();
    const segEvents = [];
    engine.addEventListener('segmentstart', (e) => segEvents.push(/** @type {CustomEvent} */ (e).detail));

    await engine.loadFromUrl('https://example.com/bird.wav');
    engine.playSegment(1.5, 4.0);

    assert.equal(engine.playbackMode, 'segment');
    assert.equal(segEvents.length, 1);
    assert.equal(segEvents[0].start, 1.5);
    assert.equal(segEvents[0].end, 4.0);
});

// ─── 2. InMemoryStorageAdapter works without browser APIs ───────────

test('Headless: InMemoryStorageAdapter replaces localStorage cleanly', () => {
    const storage = new InMemoryStorageAdapter({
        'aw-favourite-preset': 'perch',
    });

    // Simulate PresetManager.getFavouritePreset()
    assert.equal(storage.getItem('aw-favourite-preset'), 'perch');

    // Simulate PresetManager.saveUserPresetsToStorage()
    const presets = { myPreset: { scale: 'mel', windowSize: 1024 } };
    storage.setItem('aw-user-presets', JSON.stringify(presets));
    const loaded = JSON.parse(storage.getItem('aw-user-presets') ?? '{}');
    assert.deepEqual(loaded, presets);

    // Simulate PlayerState label-section collapse persistence
    storage.setItem('aw-label-section-collapsed', '1');
    assert.equal(storage.getItem('aw-label-section-collapsed'), '1');
});

test('Headless: InMemoryStorageAdapter instances are isolated (no global state)', () => {
    const s1 = new InMemoryStorageAdapter({ key: 'value1' });
    const s2 = new InMemoryStorageAdapter({ key: 'value2' });
    assert.equal(s1.getItem('key'), 'value1');
    assert.equal(s2.getItem('key'), 'value2');
    s1.setItem('key', 'changed');
    assert.equal(s2.getItem('key'), 'value2', 'mutation in s1 must not affect s2');
});

// ─── 3. UndoStack works without DOM ─────────────────────────────────

test('Headless: UndoStack DSP command lifecycle without browser', () => {
    const stack = new UndoStack();
    const log = [];

    // Simulate adding a label (memento)
    const labelState = [{ id: 'lbl1', start: 0.5, end: 2.0 }];
    stack.push(labelState);
    stack.push([...labelState, { id: 'lbl2', start: 3.0, end: 4.5 }]);

    // Simulate DSP change (command)
    const before = { scale: 'mel', windowSize: 1024 };
    const after  = { scale: 'mel', windowSize: 2048 };
    stack.record({
        type: 'dsp-param',
        description: 'Window size 1024→2048',
        execute: () => log.push('apply-2048'),
        undo:    () => log.push('apply-1024'),
    });

    assert.equal(stack.peekUndoDescription(), 'Window size 1024→2048');
    assert.equal(stack.canUndo, true);

    // Undo DSP change → command.undo() called
    const r1 = stack.undo();
    assert.equal(r1, null, 'DSP undo returns null (not a snapshot)');
    assert.deepEqual(log, ['apply-1024'], 'undo should revert DSP settings');

    // Undo label add → snapshot returned
    const r2 = stack.undo();
    assert.deepEqual(r2, labelState, 'label undo returns previous snapshot');
});

// ─── 4. FrequencyViewport works without DOM ─────────────────────────

test('Headless: FrequencyViewport zoom/pan without AudioContext', () => {
    const vp = new FrequencyViewport();
    assert.equal(vp.isZoomed, false);

    vp.zoom(2, 5000, 10000);
    assert.ok(vp.isZoomed, 'should be zoomed after zoom(2, ...)');
    assert.ok(vp.min !== null && vp.min >= 0);
    assert.ok(vp.max !== null && vp.max <= 10000);

    vp.pan(500, 10000);
    const rangeAfterPan = (vp.max ?? 0) - (vp.min ?? 0);
    assert.ok(rangeAfterPan > 0, 'range should be positive after pan');

    vp.reset();
    assert.equal(vp.isZoomed, false);
});

// ─── 5. Export contract: all headless types are importable ───────────

test('Headless: all exported headless types are importable and instantiable', () => {
    // These are the types documented in types/index.d.ts
    // Verifying they exist and work without any browser API
    const engine  = new MockAudioEngine();
    const storage = new InMemoryStorageAdapter();
    const stack   = new UndoStack(50);
    const vp      = new FrequencyViewport();

    assert.ok(engine  instanceof AudioEngineBase);
    assert.ok(storage instanceof Object);
    assert.equal(stack.size,    0);
    assert.equal(vp.isZoomed, false);
});
