import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeciesGeoCache } from '../src/ui/components/taxonomy-ui/species-geo-cache.ts';

const A = { lat: 50, lon: 8 }, B = { lat: 48, lon: 11 };
const deferred = () => { let resolve, reject; const p = new Promise((r, j) => { resolve = r; reject = j; }); return { p, resolve, reject }; };

test('no area model: refresh settles and later context changes still fetch', async () => {
  let ctx = A, calls = 0;
  const cache = createSpeciesGeoCache({ getContext: () => ctx, fetchScores: async () => { calls++; return null; } });
  await cache.refresh();
  ctx = B;
  await cache.refresh();
  assert.equal(calls, 2);
});

test('result of an outdated context is discarded and the current one is fetched', async () => {
  let ctx = A;
  const pendingA = deferred();
  const fetched = [];
  const cache = createSpeciesGeoCache({
    getContext: () => ctx,
    fetchScores: (c) => { fetched.push(c.lat); return c === A ? pendingA.p : Promise.resolve(new Map([['Parus major', 0.9]])); },
  });
  const first = cache.refresh();
  ctx = B;
  pendingA.resolve(new Map([['Turdus merula', 0.5]]));
  await first;
  await cache.refresh();
  assert.deepEqual(fetched, [50, 48]);
  assert.equal(cache.score('Turdus merula'), null);
  assert.equal(cache.score('Parus major'), 0.9);
});

test('failed lookup clears old scores and is retried', async () => {
  let ctx = A, fail = false, calls = 0;
  const cache = createSpeciesGeoCache({
    getContext: () => ctx,
    fetchScores: async (c) => { calls++; if (fail) throw new Error('down'); return new Map([[c === A ? 'a' : 'b', 1]]); },
    onError: () => {},
  });
  await cache.refresh();
  assert.equal(cache.score('a'), 1);
  ctx = B; fail = true;
  await cache.refresh();
  assert.equal(cache.score('a'), null, 'scores of A must not be shown for B');
  fail = false;
  await cache.refresh();
  assert.equal(cache.score('b'), 1);
  assert.equal(calls, 3);
});

test('removing the location clears scores', async () => {
  let ctx = A;
  const cache = createSpeciesGeoCache({ getContext: () => ctx, fetchScores: async () => new Map([['a', 1]]) });
  await cache.refresh();
  ctx = null;
  await cache.refresh();
  assert.equal(cache.score('a'), null);
});

test('clearing scores for a new context notifies open dropdowns', async () => {
  let ctx = A, updates = 0;
  const cache = createSpeciesGeoCache({ getContext: () => ctx, fetchScores: async () => new Map([['a', 1]]), onUpdate: () => updates++ });
  await cache.refresh();
  assert.equal(updates, 1);
  ctx = null;
  await cache.refresh();
  assert.equal(updates, 2);
  assert.equal(cache.score('a'), null);
});
