import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCommunityHint, writeCommunityHint, recordStart, shouldShowCommunityHint, COMMUNITY_HINT_KEY, COMMUNITY_URL } from '../src/app/labeling/community-hint.ts';

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
}

test('community link points to the Telegram group', () => {
  assert.equal(COMMUNITY_URL, 'https://t.me/SignaVis');
});

test('hint waits for the second start', () => {
  const s = memStorage();
  assert.equal(shouldShowCommunityHint(recordStart(s)), false);
  assert.equal(shouldShowCommunityHint(recordStart(s)), true);
  assert.equal(shouldShowCommunityHint(recordStart(s)), true);
});

test('closing hides it for good and stops counting', () => {
  const s = memStorage();
  recordStart(s); recordStart(s);
  writeCommunityHint(s, { ...readCommunityHint(s), closed: true });
  const after = recordStart(s);
  assert.equal(after.closed, true);
  assert.equal(after.starts, 2);
  assert.equal(shouldShowCommunityHint(after), false);
});

test('garbage or failing storage falls back to a fresh state', () => {
  const s = memStorage();
  s.m.set(COMMUNITY_HINT_KEY, '{not json');
  assert.deepEqual(readCommunityHint(s), { starts: 0, closed: false });
  s.m.set(COMMUNITY_HINT_KEY, JSON.stringify({ starts: 'x', closed: 'yes' }));
  assert.deepEqual(readCommunityHint(s), { starts: 0, closed: false });
  assert.deepEqual(readCommunityHint({ getItem: () => { throw new Error('denied'); } }), { starts: 0, closed: false });
  assert.deepEqual(readCommunityHint(null), { starts: 0, closed: false });
  assert.doesNotThrow(() => writeCommunityHint({ setItem: () => { throw new Error('x'); } }, { starts: 1, closed: false }));
});
