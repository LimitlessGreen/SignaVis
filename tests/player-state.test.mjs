// ═══════════════════════════════════════════════════════════════════════
// player-state.test.mjs — Unit tests for PlayerState
//
// Covers:
//   1. sanitizePlaybackViewportConfig (pure function, no DOM)
//   2. PlayerState constructor guard-clauses
//   3. Headless construction via MockAudioEngine + InMemoryStorageAdapter
//   4. updatePlaybackViewportConfig / getPlaybackViewportConfig round-trip
//   5. dispose() runs without throwing
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePlaybackViewportConfig, PlayerState } from '../src/app/PlayerState.ts';
import { MockAudioEngine } from '../src/infrastructure/audio/MockAudioEngine.ts';
import { InMemoryStorageAdapter } from '../src/infrastructure/storage/InMemoryStorageAdapter.ts';

// ── Browser API stubs (Node has none of these) ────────────────────────

if (typeof globalThis.requestAnimationFrame === 'undefined') {
    globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
    globalThis.cancelAnimationFrame  = (id) => clearTimeout(id);
}

// GpuColorizer calls document.createElement('canvas') but handles null WebGL gracefully.
// DocumentEventsController binds to document itself (keydown, mousedown, etc.).
// WindowEventsController binds to window (resize, beforeunload).
if (typeof globalThis.document === 'undefined') {
    globalThis.document = {
        addEventListener:    () => {},
        removeEventListener: () => {},
        createElement: (tag) => ({
            tagName: (tag || '').toUpperCase(),
            width: 0, height: 0, style: {},
            getContext: () => null,
            addEventListener:    () => {},
            removeEventListener: () => {},
        }),
    };
}
if (typeof globalThis.window === 'undefined') {
    globalThis.window = {
        addEventListener:    () => {},
        removeEventListener: () => {},
    };
}

// ── Minimal fake DOM container ────────────────────────────────────────

function makeClassList() {
    const classes = new Set();
    return {
        add:      (...c) => c.forEach(x => classes.add(x)),
        remove:   (...c) => c.forEach(x => classes.delete(x)),
        toggle:   (c, force) => {
            if (typeof force === 'boolean') { force ? classes.add(c) : classes.delete(c); }
            else { classes.has(c) ? classes.delete(c) : classes.add(c); }
        },
        contains: (c) => classes.has(c),
    };
}

function createFakeContainer() {
    return {
        classList:          makeClassList(),
        querySelector:      () => null,
        querySelectorAll:   () => [],
        addEventListener:   () => {},
        removeEventListener:() => {},
        appendChild:        () => {},
        style:              {},
        dataset:            {},
    };
}

// ─── 1. sanitizePlaybackViewportConfig — pure function ───────────────

test('PlayerState: sanitizePlaybackViewportConfig returns all ten defaults', () => {
    const cfg = sanitizePlaybackViewportConfig();
    assert.strictEqual(cfg.followGuardLeftRatio,       0.35);
    assert.strictEqual(cfg.followGuardRightRatio,      0.65);
    assert.strictEqual(cfg.followTargetRatio,          0.5);
    assert.strictEqual(cfg.followCatchupDurationMs,    240);
    assert.strictEqual(cfg.followCatchupSeekDurationMs,360);
    assert.strictEqual(cfg.smoothLerp,                 0.18);
    assert.ok(typeof cfg.smoothSeekLerp        === 'number', 'smoothSeekLerp is a number');
    assert.ok(typeof cfg.smoothMinStepRatio    === 'number', 'smoothMinStepRatio is a number');
    assert.ok(typeof cfg.smoothSeekMinStepRatio=== 'number', 'smoothSeekMinStepRatio is a number');
    assert.ok(typeof cfg.smoothSeekFocusMs     === 'number', 'smoothSeekFocusMs is a number');
});

test('PlayerState: sanitizePlaybackViewportConfig clamps below-minimum values', () => {
    const cfg = sanitizePlaybackViewportConfig({
        followGuardLeftRatio:  -5,    // min 0.05
        followCatchupDurationMs: 0,   // min 80
        smoothLerp:            -1,    // min 0.02
    });
    assert.strictEqual(cfg.followGuardLeftRatio,    0.05);
    assert.strictEqual(cfg.followCatchupDurationMs, 80);
    assert.strictEqual(cfg.smoothLerp,              0.02);
});

test('PlayerState: sanitizePlaybackViewportConfig clamps above-maximum values', () => {
    const cfg = sanitizePlaybackViewportConfig({
        followGuardRightRatio: 2,     // max 0.95
        smoothLerp:            1.5,   // max 0.95
    });
    assert.strictEqual(cfg.followGuardRightRatio, 0.95);
    assert.strictEqual(cfg.smoothLerp,            0.95);
});

test('PlayerState: sanitizePlaybackViewportConfig falls back to `current` when partial is missing', () => {
    const current = { followTargetRatio: 0.7, smoothLerp: 0.3 };
    const cfg = sanitizePlaybackViewportConfig({}, current);
    assert.strictEqual(cfg.followTargetRatio, 0.7);
    assert.strictEqual(cfg.smoothLerp,        0.3);
});

test('PlayerState: sanitizePlaybackViewportConfig ignores NaN (falls back to built-in default)', () => {
    const cfg = sanitizePlaybackViewportConfig({ followTargetRatio: NaN });
    assert.strictEqual(cfg.followTargetRatio, 0.5);
});

// ─── 2. Constructor guard-clauses ─────────────────────────────────────

test('PlayerState: throws without container', () => {
    assert.throws(
        () => new PlayerState(null, null, null, {
            engine:  new MockAudioEngine(),
            storage: new InMemoryStorageAdapter(),
        }),
        /container element required/,
    );
});

test('PlayerState: throws without WaveSurfer and without options.engine', () => {
    const container = createFakeContainer();
    assert.throws(
        () => new PlayerState(container, null, null, {
            storage: new InMemoryStorageAdapter(),
        }),
        /WaveSurfer reference or options\.engine required/,
    );
});

// ─── 3. Headless construction ─────────────────────────────────────────

test('PlayerState: constructs headlessly with MockAudioEngine', () => {
    const container = createFakeContainer();
    const engine    = new MockAudioEngine();
    const storage   = new InMemoryStorageAdapter();

    const ps = new PlayerState(container, null, null, {
        engine,
        storage,
        enableTouchGestures: false,
        enablePerfOverlay:   false,
    });

    // Initial invariants
    assert.strictEqual(ps.audioBuffer,    null, 'no audio loaded yet');
    assert.strictEqual(ps.transportState, 'idle');
    assert.ok(ps.pixelsPerSecond > 0, 'pixelsPerSecond has a positive default');
    assert.ok(typeof ps.sampleRateHz === 'number', 'sampleRateHz is a number');

    ps.dispose();
});

test('PlayerState: constructs with all three view modes', () => {
    for (const viewMode of ['both', 'spectrogram', 'waveform']) {
        const container = createFakeContainer();
        const engine    = new MockAudioEngine();
        const storage   = new InMemoryStorageAdapter();

        const ps = new PlayerState(container, null, null, {
            engine, storage,
            viewMode,
            enableTouchGestures: false,
            enablePerfOverlay:   false,
        });
        assert.ok(ps, `constructs with viewMode="${viewMode}"`);
        ps.dispose();
    }
});

test('PlayerState: accepts emitHostEvent callback', () => {
    const container  = createFakeContainer();
    const engine     = new MockAudioEngine();
    const storage    = new InMemoryStorageAdapter();
    const hostEvents = [];
    const emit       = (name, detail) => hostEvents.push({ name, detail });

    const ps = new PlayerState(container, null, emit, {
        engine, storage,
        enableTouchGestures: false,
        enablePerfOverlay:   false,
    });
    assert.ok(ps);
    ps.dispose();
});

// ─── 4. updatePlaybackViewportConfig / getPlaybackViewportConfig ──────

test('PlayerState: updatePlaybackViewportConfig partial update preserves other fields', () => {
    const container = createFakeContainer();
    const engine    = new MockAudioEngine();
    const storage   = new InMemoryStorageAdapter();

    const ps = new PlayerState(container, null, null, {
        engine, storage,
        enableTouchGestures: false,
        enablePerfOverlay:   false,
    });

    const before = ps.getPlaybackViewportConfig();
    assert.strictEqual(before.followTargetRatio, 0.5);

    ps.updatePlaybackViewportConfig({ followTargetRatio: 0.6 });

    const after = ps.getPlaybackViewportConfig();
    assert.strictEqual(after.followTargetRatio,      0.6,                       'updated field');
    assert.strictEqual(after.followGuardLeftRatio,   before.followGuardLeftRatio, 'untouched field');
    assert.strictEqual(after.followGuardRightRatio,  before.followGuardRightRatio,'untouched field');
    assert.strictEqual(after.smoothLerp,             before.smoothLerp,          'untouched field');

    ps.dispose();
});

test('PlayerState: updatePlaybackViewportConfig clamps out-of-range values', () => {
    const container = createFakeContainer();
    const engine    = new MockAudioEngine();
    const storage   = new InMemoryStorageAdapter();

    const ps = new PlayerState(container, null, null, {
        engine, storage,
        enableTouchGestures: false,
        enablePerfOverlay:   false,
    });

    ps.updatePlaybackViewportConfig({ smoothLerp: 99 });
    assert.strictEqual(ps.getPlaybackViewportConfig().smoothLerp, 0.95);

    ps.dispose();
});

// ─── 5. dispose() ─────────────────────────────────────────────────────

test('PlayerState: dispose() does not throw', () => {
    const container = createFakeContainer();
    const engine    = new MockAudioEngine();
    const storage   = new InMemoryStorageAdapter();

    const ps = new PlayerState(container, null, null, {
        engine, storage,
        enableTouchGestures: false,
        enablePerfOverlay:   false,
    });

    assert.doesNotThrow(() => ps.dispose());
});

// ─── 6. options passed via constructor propagate to initial config ─────

test('PlayerState: constructor options.followTargetRatio propagates to config', () => {
    const container = createFakeContainer();
    const engine    = new MockAudioEngine();
    const storage   = new InMemoryStorageAdapter();

    const ps = new PlayerState(container, null, null, {
        engine, storage,
        followTargetRatio:    0.3,
        followGuardLeftRatio: 0.1,
        enableTouchGestures:  false,
        enablePerfOverlay:    false,
    });

    const cfg = ps.getPlaybackViewportConfig();
    assert.strictEqual(cfg.followTargetRatio,    0.3);
    assert.strictEqual(cfg.followGuardLeftRatio, 0.1);

    ps.dispose();
});
