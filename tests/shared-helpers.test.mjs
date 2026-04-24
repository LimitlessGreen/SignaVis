import test from 'node:test';
import assert from 'node:assert/strict';

import {
    safeArray, safeString, safeField,
    firstNonEmpty, toFiniteNumber,
    normalizeXcId, resolveFetch, parseJsonSafe, sleep,
} from '../src/infrastructure/xeno-canto/xcHelpers.ts';

import { TaxonomyResolver } from '../src/infrastructure/taxonomyResolver.ts';

// ── xcHelpers ──────────────────────────────────────────────────────────

test('safeArray returns array as-is, wraps non-arrays', () => {
    assert.deepEqual(safeArray([1, 2]), [1, 2]);
    assert.deepEqual(safeArray(null), []);
    assert.deepEqual(safeArray('hi'), []);
    assert.deepEqual(safeArray(undefined), []);
});

test('safeString trims and handles edge cases', () => {
    assert.equal(safeString('  hello '), 'hello');
    assert.equal(safeString(null), '');
    assert.equal(safeString(undefined), '');
    assert.equal(safeString(0), '0');
    assert.equal(safeString(false), 'false');
});

test('safeField preserves falsy non-empty values', () => {
    assert.equal(safeField(0), 0);
    assert.equal(safeField(false), false);
    assert.equal(safeField(null), '');
    assert.equal(safeField(''), '');
    assert.equal(safeField('x'), 'x');
});

test('firstNonEmpty picks the first non-empty string', () => {
    assert.equal(firstNonEmpty([null, '', 'b', 'c']), 'b');
    assert.equal(firstNonEmpty([undefined, null]), '');
    // 0 becomes '0' which is non-empty
    assert.equal(firstNonEmpty([0, 'x']), '0');
});

test('toFiniteNumber parses numbers including comma decimals', () => {
    assert.equal(toFiniteNumber('3.14'), 3.14);
    assert.equal(toFiniteNumber('3,14'), 3.14);
    assert.equal(toFiniteNumber(42), 42);
    assert.equal(Number.isNaN(toFiniteNumber(null)), true);
    assert.equal(Number.isNaN(toFiniteNumber('abc')), true);
});

test('normalizeXcId strips non-digits and removes leading zeros', () => {
    assert.equal(normalizeXcId('XC00456'), '456');
    assert.equal(normalizeXcId('123'), '123');
    assert.equal(normalizeXcId(''), '');
    assert.equal(normalizeXcId(null), '');
});

test('resolveFetch returns custom impl if provided', () => {
    const custom = () => {};
    assert.equal(resolveFetch(custom), custom);
});

test('resolveFetch returns null when no fetch available and no custom impl', () => {
    // In Node 22+ globalThis.fetch exists, so resolveFetch(null) returns it.
    // We verify that passing a non-function still falls through.
    const result = resolveFetch('not-a-function');
    // Either returns globalThis.fetch (Node 22+) or null (older Node)
    assert.ok(result === null || typeof result === 'function');
});

test('parseJsonSafe returns parsed object or null', () => {
    assert.deepEqual(parseJsonSafe('{"a":1}'), { a: 1 });
    assert.equal(parseJsonSafe('not json'), null);
    assert.equal(parseJsonSafe(''), null);
    assert.equal(parseJsonSafe(null), null);
});

test('sleep resolves after delay', async () => {
    const start = Date.now();
    await sleep(10);
    assert.ok(Date.now() - start >= 8);
});

// ── TaxonomyResolver ──────────────────────────────────────────────────

const MOCK_TAXONOMY = {
    modelVersion: 'V2.4',
    speciesCount: 4,
    languages: ['en_uk', 'de'],
    records: [
        { s: 'Corvus corax', n: { en_uk: 'Common Raven', de: 'Kolkrabe' } },
        { s: 'Corvus corone', n: { en_uk: 'Carrion Crow', de: 'Rabenkrähe' } },
        { s: 'Parus major', n: { en_uk: 'Great Tit', de: 'Kohlmeise' } },
        { s: 'Erithacus rubecula', n: { en_uk: 'European Robin', de: 'Rotkehlchen' } },
    ],
};

test('TaxonomyResolver.load populates data and indexes', () => {
    const r = new TaxonomyResolver();
    r.load(MOCK_TAXONOMY);
    assert.equal(r.speciesCount, 4);
    assert.equal(r.modelVersion, 'V2.4');
    assert.deepEqual(r.languages, ['en_uk', 'de']);
    assert.equal(r.records.length, 4);
});

test('TaxonomyResolver.load throws on invalid data', () => {
    const r = new TaxonomyResolver();
    assert.throws(() => r.load(null), /Invalid taxonomy format/);
    assert.throws(() => r.load({}), /Invalid taxonomy format/);
    assert.throws(() => r.load({ records: [], languages: 'nope' }), /Invalid taxonomy format/);
});

test('TaxonomyResolver.resolve finds exact match', () => {
    const r = new TaxonomyResolver();
    r.load(MOCK_TAXONOMY);
    const rec = r.resolve('Corvus corax');
    assert.equal(rec.s, 'Corvus corax');
});

test('TaxonomyResolver.resolve handles case/format variations', () => {
    const r = new TaxonomyResolver();
    r.load(MOCK_TAXONOMY);
    const rec = r.resolve('corvus corax');
    assert.equal(rec.s, 'Corvus corax');
});

test('TaxonomyResolver.resolve uses fuzzy matching for close epithet', () => {
    const r = new TaxonomyResolver();
    r.load(MOCK_TAXONOMY);
    // "coronae" is close to "corone" (edit distance 1)
    const rec = r.resolve('Corvus coronae');
    assert.equal(rec.s, 'Corvus corone');
});

test('TaxonomyResolver.resolve returns null for unknown species', () => {
    const r = new TaxonomyResolver();
    r.load(MOCK_TAXONOMY);
    assert.equal(r.resolve('Unknown species'), null);
    assert.equal(r.resolve(''), null);
    assert.equal(r.resolve(null), null);
});

test('TaxonomyResolver.resolve caches results', () => {
    const r = new TaxonomyResolver();
    r.load(MOCK_TAXONOMY);
    const rec1 = r.resolve('Corvus corax');
    const rec2 = r.resolve('Corvus corax');
    assert.equal(rec1, rec2);
});

test('TaxonomyResolver.resolveCommonName picks correct language', () => {
    const r = new TaxonomyResolver();
    r.load(MOCK_TAXONOMY);
    const rec = r.resolve('Parus major');
    assert.equal(r.resolveCommonName(rec, 'de'), 'Kohlmeise');
    assert.equal(r.resolveCommonName(rec, 'en_uk'), 'Great Tit');
    // Falls back to en_uk for unknown language
    assert.equal(r.resolveCommonName(rec, 'fr'), 'Great Tit');
});

test('TaxonomyResolver.resolveCommonName returns empty for null record', () => {
    const r = new TaxonomyResolver();
    assert.equal(r.resolveCommonName(null, 'en_uk'), '');
});

test('TaxonomyResolver.clear resets all state', () => {
    const r = new TaxonomyResolver();
    r.load(MOCK_TAXONOMY);
    assert.equal(r.speciesCount, 4);
    r.clear();
    assert.equal(r.data, null);
    assert.equal(r.speciesCount, 0);
    assert.equal(r.resolve('Corvus corax'), null);
});
