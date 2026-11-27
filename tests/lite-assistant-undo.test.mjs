import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistantUndoChain } from '../src/app/lite/assistant-undo.ts';

test('assistant undo: changes while the toast shows share one undo, newest first', () => {
  let t = 0;
  const chain = new AssistantUndoChain(() => t, 8000, () => 0, () => {});
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
  const chain = new AssistantUndoChain(() => t, 8000, () => 0, () => {});
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

test('assistant undo: the person acting in between ends the chain', () => {
  let t = 0;
  const chain = new AssistantUndoChain(() => t, 8000, () => 0, () => {});
  const log = [];
  chain.add('AI: deleted 1 label', () => log.push('a'));
  chain.reset();                       // the person added a label
  t = 1000;
  const b = chain.add('AI: added 1 label', () => log.push('b'));
  assert.equal(b.summary, 'AI: added 1 label');
  b.undo();
  assert.deepEqual(log, ['b']);        // the earlier AI step is not undone over the person's edit
});

test('assistant undo: after a full snapshot, later steps are not kept; earlier steps run after it', () => {
  let t = 0;
  const chain = new AssistantUndoChain(() => t, 8000, () => 0, () => {});
  const log = [];
  chain.add('AI: BirdNET added 3', () => log.push('birdnet'));
  for (let i = 0; i < 50; i++) { t += 100; chain.add('AI: added 1 label', () => log.push(`s${i}`), { full: true }); }
  assert.equal(chain.held, 2);
  const last = chain.add('AI: deleted 1 label', () => log.push('late'), { full: true });
  assert.equal(last.summary, 'AI: 52 changes (last: deleted 1 label)');
  last.undo();
  assert.deepEqual(log, ['s0', 'birdnet']);
  assert.equal(chain.held, 0);
});

test('assistant undo: the chain is let go when its toast has gone', () => {
  let fire = null;
  const chain = new AssistantUndoChain(() => 0, 8000, (fn) => { fire = fn; return 1; }, () => {});
  chain.add('AI: added 1 label', () => {}, { full: true });
  assert.equal(chain.held, 1);
  fire();
  assert.equal(chain.held, 0);
});
