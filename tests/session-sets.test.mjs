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

test('restoreSessionSets restores explicit activeSetId and session id', () => {
  globalThis.localStorage = createLocalStorage();
  const setId = 'set_test_1';
  const state = { labelSets: new Map([[setId, { id: setId, name: 'S' }]]), activeSetId: setId, _sessionSetId: null };
  saveSessionSets(state);

  const s2 = { labelSets: new Map(), activeSetId: null, _sessionSetId: null };
  const ok = restoreSessionSets(s2);
  assert.equal(ok, true);
  assert.equal(s2.labelSets.size, 1);
  assert.equal(s2.activeSetId, setId);
  assert.equal(s2._sessionSetId, setId);
});

test('restoreSessionSets falls back to first set when no activeSetId', () => {
  globalThis.localStorage = createLocalStorage();
  const setIdA = 'set_a';
  const sets = [[setIdA, { id: setIdA, name: 'A' }], ['set_b', { id: 'set_b', name: 'B' }]];
  // write raw directly to emulate older data without activeSetId
  localStorage.setItem('audio-workbench.session-sets.v1', JSON.stringify({ sets, activeSetId: null }));

  const s3 = { labelSets: new Map(), activeSetId: null, _sessionSetId: null };
  const ok2 = restoreSessionSets(s3);
  assert.equal(ok2, true);
  assert.equal(s3._sessionSetId, setIdA);
  assert.equal(s3.activeSetId, setIdA);
});
