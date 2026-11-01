import test from 'node:test';
import assert from 'node:assert/strict';
import { saveSessionSets, restoreSessionSets } from '../demo/lib/session-sets.js';

function createLocalStorage() {
  let store = Object.create(null);
  return {
    getItem(key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
    setItem(key, value) { store[key] = String(value); },
    removeItem(key) { delete store[key]; },
    clear() { store = Object.create(null); },
  };
}

test('restoreSessionSets moves the own set to the own source', () => {
  globalThis.localStorage = createLocalStorage();
  const setId = 'set_test_1';
  const state = { labelSets: new Map([[setId, { id: setId, name: 'S' }]]), activeSetId: setId };
  saveSessionSets(state);

  const s2 = { labelSets: new Map(), activeSetId: null };
  assert.equal(restoreSessionSets(s2), true);
  assert.deepEqual([...s2.labelSets.keys()], ['own']);
  assert.equal(s2.labelSets.get('own').name, 'S');
  assert.deepEqual(s2.labelSets.get('own').legacyIds, [setId]);
  assert.equal(s2.activeSetId, 'own');
});

test('restoreSessionSets: older data without activeSetId — first own set wins, others become layers', () => {
  globalThis.localStorage = createLocalStorage();
  const sets = [['set_a', { id: 'set_a', name: 'A' }], ['set_b', { id: 'set_b', name: 'B' }]];
  localStorage.setItem('signavis.session-sets.v1', JSON.stringify({ sets, activeSetId: null }));

  const s3 = { labelSets: new Map(), activeSetId: null };
  assert.equal(restoreSessionSets(s3), true);
  assert.deepEqual(s3.labelSets.get('own').legacyIds, ['set_a']);
  assert.deepEqual(s3.labelSets.get('own').layers.map((l) => l.id), ['default', 'set_b']);
  assert.equal(s3.activeSetId, 'own');
});
