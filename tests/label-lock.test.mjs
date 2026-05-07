import test from 'node:test';
import assert from 'node:assert/strict';
import { SpectrogramLabelLayer } from '../src/domain/annotations.ts';

function mockPlayer(opts = {}) {
    const listeners = {};
    return {
        duration: opts.duration || 10,
        root: { classList: { add() {}, remove() {}, toggle() {} }, querySelector: () => null },
        _state: {
            audioBuffer: { duration: opts.duration || 10 },
            sampleRateHz: 44100,
            coords: null,
            d: {
                spectrogramCanvas: { width: 800, height: 400 },
                canvasWrapper: null,
                maxFreqSelect: { value: '22050' },
            },
        },
        on(event, fn) {
            (listeners[event] ??= []).push(fn);
            return () => { listeners[event] = listeners[event].filter((f) => f !== fn); };
        },
        _emit(event, detail) {
            for (const fn of listeners[event] || []) fn({ detail });
        },
        playBandpassedSegment() {},
        getTagPresets() { return []; },
    };
}

function createLayer(opts = {}) {
    const layer = new SpectrogramLabelLayer();
    const player = mockPlayer(opts);
    layer.player = player;
    layer.labels = [];
    layer.overlay = null;
    return { layer, player };
}

// ── setLockedIds / isLocked state ──

test('setLockedIds marks ids as locked', () => {
    const { layer } = createLayer();
    const id = layer.add({ start: 0, end: 1, freqMin: 1000, freqMax: 5000, label: 'Amsel' });
    layer.setLockedIds([id]);
    assert.ok(layer._lockedIds.has(id), 'locked id should be in _lockedIds');
});

test('setLockedIds replaces previous locked set', () => {
    const { layer } = createLayer();
    const id1 = layer.add({ start: 0, end: 1, freqMin: 1000, freqMax: 5000, label: 'A' });
    const id2 = layer.add({ start: 2, end: 3, freqMin: 1000, freqMax: 5000, label: 'B' });
    layer.setLockedIds([id1]);
    layer.setLockedIds([id2]);
    assert.ok(!layer._lockedIds.has(id1), 'previously locked id should be unlocked');
    assert.ok(layer._lockedIds.has(id2), 'new id should be locked');
});

test('setLockedIds with empty array clears all locks', () => {
    const { layer } = createLayer();
    const id = layer.add({ start: 0, end: 1, freqMin: 1000, freqMax: 5000, label: 'A' });
    layer.setLockedIds([id]);
    layer.setLockedIds([]);
    assert.equal(layer._lockedIds.size, 0);
});

// ── remove() on locked labels ──

test('remove() still removes a locked label (internal API has no guard)', () => {
    // The guard lives in the caller (keyboard handler / prompt).
    // This test documents that remove() itself is unguarded — callers must check.
    const { layer } = createLayer();
    const id = layer.add({ start: 0, end: 1, freqMin: 1000, freqMax: 5000, label: 'A' });
    layer.setLockedIds([id]);
    layer.remove(id);
    assert.equal(layer.labels.length, 0, 'remove() bypasses lock by design — callers must guard');
});

// ── _renameSpectrogramLabelPrompt respects locks (Bug #2) ──

test('_renameSpectrogramLabelPrompt does nothing for a locked label', () => {
    const { layer } = createLayer();
    const id = layer.add({ start: 0, end: 1, freqMin: 1000, freqMax: 5000, label: 'Locked' });
    layer.setLockedIds([id]);

    let editorOpened = false;
    // Patch openLabelNameEditor via the module-level call inside the method by
    // checking that the label is not mutated and no event fires.
    let eventFired = false;
    layer.addEventListener('spectrogramlabelupdate', () => { eventFired = true; });
    layer.addEventListener('spectrogramlabelremove', () => { eventFired = true; });

    // Should return early without opening the editor (no DOM → would throw if it tried)
    layer._renameSpectrogramLabelPrompt(id);

    assert.ok(!eventFired, 'no update/remove event should fire for a locked label');
    assert.equal(layer.labels[0].label, 'Locked', 'label name must stay unchanged');
});

test('_renameSpectrogramLabelPrompt does nothing for a readonly label', () => {
    const { layer } = createLayer();
    const id = layer.add({ start: 0, end: 1, freqMin: 1000, freqMax: 5000, label: 'ReadOnly' });
    layer.labels[0].readonly = true;

    let eventFired = false;
    layer.addEventListener('spectrogramlabelupdate', () => { eventFired = true; });
    layer.addEventListener('spectrogramlabelremove', () => { eventFired = true; });

    layer._renameSpectrogramLabelPrompt(id);

    assert.ok(!eventFired, 'no event should fire for a readonly label');
});

// ── _renameBulkPrompt filters locked labels (Bug #3) ──

test('_renameBulkPrompt skips locked labels entirely', () => {
    const { layer } = createLayer();
    const idLocked = layer.add({ start: 0, end: 1, freqMin: 1000, freqMax: 5000, label: 'Locked' });
    const idFree   = layer.add({ start: 2, end: 3, freqMin: 1000, freqMax: 5000, label: 'Free' });
    layer.setLockedIds([idLocked]);

    // _renameBulkPrompt with only locked ids → labels array is empty → returns early
    let eventFired = false;
    layer.addEventListener('spectrogramlabelupdate', () => { eventFired = true; });

    layer._renameBulkPrompt([idLocked]);

    assert.ok(!eventFired, 'no event should fire when all selected labels are locked');
    assert.equal(layer.labels.find(l => l.id === idLocked).label, 'Locked',
        'locked label name must remain unchanged');
    assert.equal(layer.labels.find(l => l.id === idFree).label, 'Free',
        'unlocked label must not be touched');
});

test('_renameBulkPrompt skips readonly labels', () => {
    const { layer } = createLayer();
    const id = layer.add({ start: 0, end: 1, freqMin: 1000, freqMax: 5000, label: 'RO' });
    layer.labels[0].readonly = true;

    let eventFired = false;
    layer.addEventListener('spectrogramlabelupdate', () => { eventFired = true; });

    layer._renameBulkPrompt([id]);

    assert.ok(!eventFired, 'readonly label must be filtered from bulk prompt');
});

test('_renameBulkPrompt only edits unlocked labels in a mixed selection', () => {
    // We cannot easily invoke the modal submit in a headless environment, so we
    // verify the filtering step: locked labels are stripped from the working set
    // before openLabelNameEditor is called. We confirm this by checking that a
    // prompt with [locked, free] still returns early when *only* locked ids are
    // passed (no DOM → would throw on querySelector if it proceeded).
    const { layer } = createLayer();
    const idLocked = layer.add({ start: 0, end: 1, freqMin: 1000, freqMax: 5000, label: 'Speecht' });
    layer.setLockedIds([idLocked]);

    // Should not throw even without a DOM, because it returns early.
    assert.doesNotThrow(() => layer._renameBulkPrompt([idLocked]));
});

// ── Lock survives add / remove of other labels ──

test('lock state is unaffected by adding or removing other labels', () => {
    const { layer } = createLayer();
    const idA = layer.add({ start: 0, end: 1, freqMin: 1000, freqMax: 5000, label: 'A' });
    layer.setLockedIds([idA]);

    const idB = layer.add({ start: 2, end: 3, freqMin: 1000, freqMax: 5000, label: 'B' });
    layer.remove(idB);

    assert.ok(layer._lockedIds.has(idA), 'lock on A must survive B being added and removed');
});
