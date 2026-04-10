import test from 'node:test';
import assert from 'node:assert/strict';
import { UndoStack } from '../src/undoStack.js';

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
