import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordingManager } from '../demo/lib/recording-manager.js';

function createSessionStorage() {
  let store = Object.create(null);
  return {
    getItem(key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
    setItem(key, value) { store[key] = String(value); },
    removeItem(key) { delete store[key]; },
    clear() { store = Object.create(null); },
  };
}

test('saveAnnotations normalizes numbers and deduplicates by id/composite key', () => {
  globalThis.sessionStorage = createSessionStorage();
  const rm = new RecordingManager();
  const entry = rm.add({ filename: 'test.wav' });
  rm.setActive(entry.id);

  const anns = [
    { id: 'dup', start: 1.0000001, end: 2.0000001, freqMin: 1000.041, freqMax: 2000.061, setId: 's1', scientificName: 'A' },
    { id: 'dup', start: 1.000000200, end: 2.0000000, freqMin: 1000.049, freqMax: 2000.059, setId: 's1', scientificName: 'A' },
    { start: 1.00000015, end: 2.00000012, freqMin: 1000.041, freqMax: 2000.061, setId: 's1', scientificName: 'A' },
  ];

  rm.saveAnnotations(anns);

  const stored = rm.getById(entry.id).annotations;
  assert.equal(stored.length, 2, 'should keep two normalized annotations (id-based + composite)');

  const dup = stored.find(a => a.id === 'dup');
  assert(dup, 'annotation with id "dup" should be present');
  const normalizedStart = Math.round(Number(anns[0].start) * 1e6) / 1e6;
  const normalizedEnd = Math.round(Number(anns[0].end) * 1e6) / 1e6;
  const normalizedFreqMin = Math.round(Number(anns[0].freqMin) * 10) / 10;
  assert.equal(dup.start, normalizedStart);
  assert.equal(dup.end, normalizedEnd);
  assert.equal(dup.freqMin, normalizedFreqMin);
});

test('persisted entries survive manager recreation', () => {
  globalThis.sessionStorage = createSessionStorage();
  const rm1 = new RecordingManager();
  const entry = rm1.add({ filename: 'persist.wav' });
  rm1.setActive(entry.id);
  const anns = [{ start: 0.123456789, end: 0.223456789, freqMin: 440.12, freqMax: 880.34 }];
  rm1.saveAnnotations(anns);

  const rm2 = new RecordingManager();
  const restored = rm2.getById(entry.id);
  assert(restored, 'entry should be restored from sessionStorage');
  assert.equal(restored.annotations.length, 1);
  const r = restored.annotations[0];
  assert.equal(r.start, Math.round(anns[0].start * 1e6) / 1e6);
  assert.equal(r.freqMin, Math.round(anns[0].freqMin * 10) / 10);
});
