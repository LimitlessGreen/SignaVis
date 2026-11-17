import test from 'node:test';
import assert from 'node:assert/strict';
import { speciesLinks, xcSearchName } from '../src/domain/speciesLinks.ts';

test('speciesLinks builds eBird and iNaturalist URLs', () => {
  assert.deepEqual(speciesLinks({ ebird: 'eurbla', inat: 12716 }), [
    { label: 'eBird', url: 'https://ebird.org/species/eurbla' },
    { label: 'iNaturalist', url: 'https://www.inaturalist.org/taxa/12716' },
  ]);
  assert.deepEqual(speciesLinks(null), []);
});

test('xcSearchName prefers the Xeno-canto spelling', () => {
  assert.equal(xcSearchName({ xc: 'Hyliola regilla' }, 'Pseudacris regilla'), 'Hyliola regilla');
  assert.equal(xcSearchName({}, 'Turdus merula'), 'Turdus merula');
  assert.equal(xcSearchName(null, 'Turdus merula'), 'Turdus merula');
});
