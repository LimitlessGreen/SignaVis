import test from 'node:test';
import assert from 'node:assert/strict';
import { UndoStack } from '../src/domain/undoStack.ts';

// ── Basic push / undo / redo ──

test('UndoStack starts empty', () => {
    const s = new UndoStack();
    assert.equal(s.size, 0);
    assert.equal(s.canUndo, false);
    assert.equal(s.canRedo, false);
});

test('push adds a snapshot', () => {
    const s = new UndoStack();
    s.push([{ id: '1' }]);
    assert.equal(s.size, 1);
    assert.equal(s.canUndo, false, 'need at least 2 entries to undo');
    s.push([{ id: '2' }]);
    assert.equal(s.size, 2);
    assert.equal(s.canUndo, true);
});

test('undo returns previous snapshot', () => {
    const s = new UndoStack();
    const s1 = [{ id: '1' }];
    const s2 = [{ id: '1' }, { id: '2' }];
    s.push(s1);
    s.push(s2);
    const result = s.undo();
    assert.deepEqual(result, s1);
    assert.equal(s.canUndo, false);
    assert.equal(s.canRedo, true);
});

test('redo returns next snapshot after undo', () => {
    const s = new UndoStack();
    s.push([{ id: 'a' }]);
    s.push([{ id: 'b' }]);
    s.undo();
    const result = s.redo();
    assert.deepEqual(result, [{ id: 'b' }]);
    assert.equal(s.canRedo, false);
});

test('undo at beginning returns null', () => {
    const s = new UndoStack();
    assert.equal(s.undo(), null);
    s.push([]);
    assert.equal(s.undo(), null);
});

test('redo at end returns null', () => {
    const s = new UndoStack();
    assert.equal(s.redo(), null);
    s.push([]);
    assert.equal(s.redo(), null);
});

test('push after undo discards redo history', () => {
    const s = new UndoStack();
    s.push([{ id: '1' }]);
    s.push([{ id: '2' }]);
    s.push([{ id: '3' }]);
    s.undo(); // back to 2
    s.push([{ id: '4' }]); // discard 3
    assert.equal(s.canRedo, false);
    assert.equal(s.size, 3); // [1, 2, 4]
    const undone = s.undo();
    assert.deepEqual(undone, [{ id: '2' }]);
});

// ── Max size enforcement ──

test('enforces max size by dropping oldest', () => {
    const s = new UndoStack(3);
    s.push([1]);
    s.push([2]);
    s.push([3]);
    s.push([4]); // drops [1]
    assert.equal(s.size, 3);
    // Undo should go: 4 -> 3 -> 2 (not 1)
    assert.deepEqual(s.undo(), [3]);
    assert.deepEqual(s.undo(), [2]);
    assert.equal(s.undo(), null);
});

// ── Multi-step undo/redo ──

test('multiple undo/redo steps work correctly', () => {
    const s = new UndoStack();
    s.push('A');
    s.push('B');
    s.push('C');
    s.push('D');
    assert.equal(s.undo(), 'C');
    assert.equal(s.undo(), 'B');
    assert.equal(s.redo(), 'C');
    assert.equal(s.redo(), 'D');
    assert.equal(s.redo(), null);
    assert.equal(s.undo(), 'C');
});

// ── clear() ──

test('clear resets the stack', () => {
    const s = new UndoStack();
    s.push([1]);
    s.push([2]);
    s.clear();
    assert.equal(s.size, 0);
    assert.equal(s.canUndo, false);
    assert.equal(s.canRedo, false);
    assert.equal(s.undo(), null);
});

// ── Command-Pattern (record / undo / redo) ──────────────────────────

test('record() stores a command without calling execute', () => {
    const s = new UndoStack();
    let executed = 0;
    s.record({ execute: () => executed++, undo: () => {} });
    assert.equal(executed, 0, 'execute should NOT be called by record()');
    assert.equal(s.size, 1);
});

test('undo() on a command entry calls command.undo() and returns null', () => {
    const s = new UndoStack();
    let undoCalls = 0;
    s.push('baseline');            // index 0
    s.record({ execute: () => {}, undo: () => undoCalls++, type: 'dsp-param' });
    assert.equal(s.undo(), null, 'command undo should return null, not a snapshot');
    assert.equal(undoCalls, 1);
});

test('redo() on a command entry calls command.execute() and returns null', () => {
    const s = new UndoStack();
    let execCalls = 0;
    s.push('baseline');
    s.record({ execute: () => execCalls++, undo: () => {} });
    s.undo();                 // undo the command
    const result = s.redo(); // redo the command
    assert.equal(result, null, 'command redo should return null');
    assert.equal(execCalls, 1);
});

test('commands and snapshots interleave correctly', () => {
    const s = new UndoStack();
    const log = [];
    s.push('snap-A');
    s.record({ execute: () => log.push('exec-B'), undo: () => log.push('undo-B') });
    s.push('snap-C');

    assert.equal(s.size, 3);

    // Undo snap-C: steps back to index 1 (command entry), so prev is a command → returns null
    assert.equal(s.undo(), null, 'undo of snap-C returns null because previous entry is a command');
    // Undo cmd-B: calls undo-B, steps back to index 0, returns null
    assert.equal(s.undo(), null, 'undo of command calls undo() and returns null');
    assert.deepEqual(log, ['undo-B']);
    // At index 0 — can't undo further
    assert.equal(s.undo(), null);
    assert.equal(s.canUndo, false);

    // Redo cmd-B: exec-B is called, returns null
    assert.equal(s.redo(), null);
    assert.deepEqual(log, ['undo-B', 'exec-B']);
    // Redo snap-C: returns snapshot data
    assert.equal(s.redo(), 'snap-C');
});

test('peekUndoKind returns correct kind', () => {
    const s = new UndoStack();
    s.push('snap');
    s.push('snap2');
    assert.equal(s.peekUndoKind(), 'snapshot');
    s.undo();
    s.record({ execute: () => {}, undo: () => {} });
    assert.equal(s.peekUndoKind(), 'command');
});

test('peekUndoDescription returns command description', () => {
    const s = new UndoStack();
    s.push('baseline');
    s.record({ execute: () => {}, undo: () => {}, description: 'Changed FFT size' });
    assert.equal(s.peekUndoDescription(), 'Changed FFT size');
});

test('canUndo is true even when only command entries remain', () => {
    const s = new UndoStack();
    s.push('baseline');
    s.record({ execute: () => {}, undo: () => {} });
    assert.equal(s.canUndo, true);
});

test('max size enforced across mixed entry types', () => {
    const s = new UndoStack(3);
    s.push('A');
    s.record({ execute: () => {}, undo: () => {}, type: 'cmd-B' });
    s.push('C');
    s.push('D');  // drops 'A'
    assert.equal(s.size, 3);
});
