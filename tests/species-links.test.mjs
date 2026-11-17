import test from 'node:test';
import assert from 'node:assert/strict';
import { speciesLinks, xcSearchNames } from '../src/domain/speciesLinks.ts';

test('speciesLinks builds eBird and iNaturalist URLs', () => {
  assert.deepEqual(speciesLinks({ ebird: 'eurbla', inat: 12716 }), [
    { label: 'eBird', url: 'https://ebird.org/species/eurbla' },
    { label: 'iNaturalist', url: 'https://www.inaturalist.org/taxa/12716' },
  ]);
  assert.deepEqual(speciesLinks(null), []);
});

test('xcSearchNames tries the taxonomy name first, Xeno-canto spelling second', () => {
  assert.deepEqual(xcSearchNames({ xc: 'Accipiter tachiro' }, 'Aerospiza tachiro'), ['Aerospiza tachiro', 'Accipiter tachiro']);
  assert.deepEqual(xcSearchNames({ xc: 'Turdus merula' }, 'Turdus merula'), ['Turdus merula']);
  assert.deepEqual(xcSearchNames(null, 'Turdus merula'), ['Turdus merula']);
});
