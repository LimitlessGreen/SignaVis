import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSponsorState, writeSponsorState, viewForState, SPONSOR_STORAGE_KEY } from '../src/app/labeling/sponsor-card.ts';

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

test('sponsor state round-trips through storage', () => {
  const s = memStorage();
  assert.equal(readSponsorState(s), 'none');
  writeSponsorState(s, 'pending');
  assert.equal(readSponsorState(s), 'pending');
  writeSponsorState(s, 'sponsor');
  assert.equal(s.m.get(SPONSOR_STORAGE_KEY), 'sponsor');
  writeSponsorState(s, 'none');
  assert.equal(s.m.has(SPONSOR_STORAGE_KEY), false);
});

test('unknown or failing storage falls back to none', () => {
  assert.equal(readSponsorState({ getItem: () => 'garbage' }), 'none');
  assert.equal(readSponsorState({ getItem: () => { throw new Error('denied'); } }), 'none');
  assert.equal(readSponsorState(null), 'none');
  assert.doesNotThrow(() => writeSponsorState({ setItem: () => { throw new Error('x'); }, removeItem() {} }, 'sponsor'));
});

test('view follows state', () => {
  assert.equal(viewForState('none'), 'ask');
  assert.equal(viewForState('pending'), 'confirm');
  assert.equal(viewForState('sponsor'), 'thanks');
});
