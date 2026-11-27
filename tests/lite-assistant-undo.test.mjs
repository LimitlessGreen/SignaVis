import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistantUndoChain } from '../src/app/lite/assistant-undo.ts';

test('assistant undo: changes while the toast shows share one undo, newest first', () => {
  let t = 0;
  const chain = new AssistantUndoChain(() => t, 8000);
  const log = [];
  chain.add('AI: deleted 1 label', () => log.push('a'));
  t = 3000;
  const second = chain.add('AI: deleted 1 label', () => log.push('b'));
  assert.equal(second.summary, 'AI: 2 changes (last: deleted 1 label)');
  second.undo();
  assert.deepEqual(log, ['b', 'a']);
  second.undo();                       // a second click does nothing
  assert.deepEqual(log, ['b', 'a']);
});

test('assistant undo: a change after the toast is gone starts a new step', () => {
  let t = 0;
  const chain = new AssistantUndoChain(() => t, 8000);
  const log = [];
  chain.add('AI: added 2 labels', () => log.push('a'));
  t = 9000;
  const next = chain.add('AI: deleted 1 label', () => log.push('b'));
  assert.equal(next.summary, 'AI: deleted 1 label');
  next.undo();
  assert.deepEqual(log, ['b']);
  t = 9500;                            // after an undo, the next change starts fresh
  const after = chain.add('AI: added 1 label', () => log.push('c'));
  assert.equal(after.summary, 'AI: added 1 label');
});
