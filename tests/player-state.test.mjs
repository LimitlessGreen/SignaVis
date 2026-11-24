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
    assert.strictEqual(cfg.followGuardLeftRatio,       0.1);
    assert.strictEqual(cfg.followGuardRightRatio,      0.8);
    assert.strictEqual(cfg.followTargetRatio,          0.33);
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
    assert.strictEqual(cfg.followTargetRatio, 0.33);
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
    assert.strictEqual(before.followTargetRatio, 0.33);

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

// ─── View mode at runtime ─────────────────────────────────────────────

function headlessWithAudio(viewMode) {
    const emitted = [];
    const container = createFakeContainer();
    container.classList.add('daw-shell', `view-mode-${viewMode}`);
    const ps = new PlayerState(container, null, (name, detail) => emitted.push({ name, detail }), {
        engine: new MockAudioEngine(), storage: new InMemoryStorageAdapter(),
        viewMode, enableTouchGestures: false, enablePerfOverlay: false,
    });
    const buffer = { duration: 600, sampleRate: 48000, numberOfChannels: 1, getChannelData: () => new Float32Array(0) };
    Object.defineProperty(ps, 'audioBuffer', { get: () => buffer });
    const generated = [];
    ps._spectro.generate = async (opts) => { generated.push(opts); };
    Object.defineProperty(ps._spectro, 'hasData', { get: () => generated.length > 0, configurable: true });
    let held = buffer; // what the controller got from setAudio
    Object.defineProperty(ps._spectro, 'currentAudio', { get: () => held, configurable: true });
    const hold = (b) => { held = b; };
    return { ps, generated, emitted, container, hold };
}

test('PlayerState: no spectrogram generation before the controller holds the loaded buffer', async () => {
    const { ps, generated, hold } = headlessWithAudio('both');
    hold({ duration: 1 }); // still the previous file
    await ps._generateSpectrogram();
    assert.strictEqual(generated.length, 0);
    assert.strictEqual(ps._spectroGeneration, null);
    ps.dispose();
});

test('PlayerState: the deferred generation waits while the spectrogram is hidden again', async () => {
    const { ps, generated } = headlessWithAudio('both');
    let finish;
    ps._spectro.generate = (opts) => { generated.push(opts); return new Promise((r) => { finish = r; }); };
    const first = ps._generateSpectrogram();
    ps._setViewMode('waveform');
    ps._regenerateSpectrogram();
    ps._setViewMode('both');                 // registers the continuation
    const again = ps._generateSpectrogram();
    ps._setViewMode('waveform');             // hidden again before the run ends
    finish();
    await first; await again;
    assert.strictEqual(generated.length, 1, 'nothing computed while hidden');
    assert.strictEqual(ps._spectroStale, true, 'still recomputed when shown');
    ps.dispose();
});

test('PlayerState: a setting changed while hidden during a running generation is computed after it', async () => {
    const { ps, generated } = headlessWithAudio('both');
    let finish;
    ps._spectro.generate = (opts) => { generated.push(opts); return new Promise((r) => { finish = r; }); };
    const first = ps._generateSpectrogram();
    ps._setViewMode('waveform');
    ps._regenerateSpectrogram();            // hidden: only marked stale
    ps._setViewMode('both');                // reuses the running generation …
    const again = ps._generateSpectrogram();
    finish();
    await first;
    await new Promise((r) => setTimeout(r, 0));
    finish?.();
    await again;
    assert.strictEqual(generated.length, 2, '… and computes again once it ends');
    assert.strictEqual(ps._spectroStale, false);
    ps.dispose();
});

test('PlayerState: a hidden spectrogram is computed only once it is shown', async () => {
    const { ps, generated, emitted, container } = headlessWithAudio('waveform');

    ps._regenerateSpectrogram();
    assert.strictEqual(generated.length, 0, 'not computed while hidden');

    ps._setViewMode('both');
    await ps._spectroGeneration;
    assert.strictEqual(generated.length, 1, 'computed when shown');
    assert.strictEqual(ps._showSpectrogram, true);
    assert.ok(container.classList.contains('view-mode-both'), 'the shell shows the new mode');
    assert.ok(!container.classList.contains('view-mode-waveform'));
    assert.deepStrictEqual(emitted.at(-1), { name: 'viewmodechange', detail: { mode: 'both' } });

    ps._setViewMode('waveform');
    ps._setViewMode('both');
    await ps._spectroGeneration;
    assert.strictEqual(generated.length, 1, 'not recomputed when shown again');
    ps.dispose();
});

test('PlayerState: a setting changed while hidden recomputes when shown', async () => {
    const { ps, generated } = headlessWithAudio('both');
    await ps._generateSpectrogram();
    ps._setViewMode('waveform');

    ps._regenerateSpectrogram({ autoAdjust: false });
    assert.strictEqual(generated.length, 1);

    ps._setViewMode('both');
    await ps._spectroGeneration;
    assert.strictEqual(generated.length, 2);
    ps.dispose();
});

test('PlayerState: loading ends the loading overlay while the spectrogram is hidden', async () => {
    const { ps, generated } = headlessWithAudio('waveform');
    const overlay = { hidden: false };
    ps.d.recomputingOverlay = overlay;
    for (const key of ['fileInfo', 'sampleRateInfo', 'totalTimeDisplay', 'currentTimeDisplay']) {
        ps.d[key] = { innerHTML: '', textContent: '', classList: makeClassList(), style: {} };
    }
    // Drawing needs canvases this headless state has none of.
    for (const name of ['_drawMainWaveform', '_drawOverviewWaveform', '_syncTrackWidth', '_syncOverviewWindowToViewport', '_seekToTime', '_setPixelsPerSecond']) {
        ps[name] = () => {};
    }

    await ps._onAudioLoaded({ duration: 600, sampleRate: 48000 }, 'long.wav');

    assert.strictEqual(generated.length, 0, 'the hidden spectrogram is not computed');
    assert.strictEqual(overlay.hidden, true);
    ps.dispose();
});

test('PlayerState: an unavailable spectrogram switches to the waveform and says why', () => {
    const { ps, emitted } = headlessWithAudio('both');
    const appended = [];
    const note = { dataset: {} };
    ps.d.fileInfo = { querySelector: () => (appended.length ? note : null), append: (...n) => appended.push(...n) };
    const realCreate = globalThis.document.createElement;
    globalThis.document.createElement = () => note;
    try {
        ps._spectro.dispatchEvent(new CustomEvent('unavailable', { detail: { reason: 'too-large' } }));
        ps._spectro.dispatchEvent(new CustomEvent('unavailable', { detail: { reason: 'too-large' } }));
    } finally { globalThis.document.createElement = realCreate; }
    assert.strictEqual(ps._viewMode, 'waveform');
    assert.strictEqual(ps._showSpectrogram, false);
    assert.strictEqual(note.dataset.aw, 'spectrogramUnavailable');
    assert.match(note.textContent, /Spectrogram unavailable/);
    assert.strictEqual(appended.filter(x => x === note).length, 1, 'the note is added once');
    assert.ok(emitted.some(e => e.name === 'spectrogramUnavailable'));
    ps.dispose();
});

test('PlayerState: dispose() removes the channel and waveform setting listeners', () => {
    globalThis.Option ??= class { constructor(text, value) { this.text = text; this.value = value; } };
    const ids = ['channelSelect', 'channelSettingSelect', 'waveformScaleSelect', 'waveformRefSelect', 'waveformDbRangeSelect', 'waveformRmsCheck'];
    const els = Object.fromEntries(ids.map((id) => {
        const listeners = new Set();
        return [id, {
            value: '', checked: false, options: [], hidden: false, style: {}, dataset: {}, listeners,
            addEventListener: (t, fn) => listeners.add(fn),
            removeEventListener: (t, fn) => listeners.delete(fn),
            add() {}, replaceChildren() {},
        }];
    }));
    const container = createFakeContainer();
    container.querySelector = (sel) => els[/data-aw="([^"]+)"/.exec(sel)?.[1]] ?? null;
    const ps = new PlayerState(container, null, null, {
        engine: new MockAudioEngine(), storage: new InMemoryStorageAdapter(),
        enableTouchGestures: false, enablePerfOverlay: false,
    });
    for (const id of ids) assert.equal(els[id].listeners.size, 1, `${id} bound`);
    ps.dispose();
    for (const id of ids) assert.equal(els[id].listeners.size, 0, `${id} left bound after dispose()`);
});
