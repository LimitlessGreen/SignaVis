import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSpeciesListText, serializeSpeciesList, SpeciesListStore, filterBySpeciesList, speciesFilterSet, STORAGE_KEY,
} from '../src/domain/species-lists.ts';

const memStorage = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), m }; };

test('parses BirdNET labels format, plain names, CSV and comments', () => {
  const txt = '# my list\nTurdus merula_Common Blackbird\n\nErithacus rubecula\r\nParus major,Great Tit\nturdus merula_dup\nScientific name;Common\n';
  assert.deepEqual(parseSpeciesListText(txt), ['Turdus merula', 'Erithacus rubecula', 'Parus major']);
});

test('serializes in --slist format and round-trips', () => {
  const txt = serializeSpeciesList(['Turdus merula', 'Foo bar'], (s) => (s === 'Turdus merula' ? 'Blackbird' : ''));
  assert.equal(txt, 'Turdus merula_Blackbird\nFoo bar\n');
  assert.deepEqual(parseSpeciesListText(txt), ['Turdus merula', 'Foo bar']);
});

test('filter keeps only listed species, null set keeps all', () => {
  const dets = [{ scientific: 'Turdus merula' }, { scientific: 'Parus major' }];
  const list = { id: 'x', name: 'x', species: ['turdus MERULA'], updatedAt: 0 };
  assert.deepEqual(filterBySpeciesList(dets, speciesFilterSet(list)), [dets[0]]);
  assert.equal(filterBySpeciesList(dets, null), dets);
});

test('store persists lists, dedupes and clears active on delete', () => {
  const st = memStorage();
  const s = new SpeciesListStore(st);
  const l = s.create('Garden', ['Turdus merula', 'turdus merula', ' ']);
  assert.deepEqual(l.species, ['Turdus merula']);
  s.add(l.id, ['Parus major', 'Turdus merula']);
  s.remove(l.id, ['TURDUS merula']);
  s.setActive(l.id);
  const again = new SpeciesListStore(st);
  assert.equal(again.active?.name, 'Garden');
  assert.deepEqual(again.active?.species, ['Parus major']);
  again.delete(l.id);
  assert.equal(again.active, null);
  assert.ok(st.m.has(STORAGE_KEY));
});

test('corrupt storage starts empty, unknown active id falls back to all species', () => {
  assert.deepEqual(new SpeciesListStore({ getItem: () => '{nope', setItem() {} }).state, { activeId: null, lists: [] });
  const st = { getItem: () => JSON.stringify({ activeId: 'gone', lists: [] }), setItem() {} };
  assert.equal(new SpeciesListStore(st).state.activeId, null);
});

test('blocked localStorage (throwing getter) falls back to memory instead of breaking startup', () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
  try {
    const s = new SpeciesListStore();
    s.setActive(s.create('x', ['Parus major']).id);
    assert.equal(s.active?.name, 'x');
  } finally {
    if (desc) Object.defineProperty(globalThis, 'localStorage', desc); else delete globalThis.localStorage;
  }
});
