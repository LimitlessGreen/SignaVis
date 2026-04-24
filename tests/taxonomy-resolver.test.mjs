// ═══════════════════════════════════════════════════════════════════════
// taxonomy-resolver.test.mjs — Tests for taxonomy resolver and
// multilingual label re-resolution
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { TaxonomyResolver } from '../src/infrastructure/taxonomyResolver.ts';

const MOCK_TAXONOMY = {
    modelVersion: '2.4',
    speciesCount: 3,
    languages: ['en_uk', 'de', 'fr'],
    records: [
        { s: 'Picus viridis', n: { en_uk: 'European Green Woodpecker', de: 'Grünspecht', fr: 'Pic vert' } },
        { s: 'Parus major', n: { en_uk: 'Great Tit', de: 'Kohlmeise', fr: 'Mésange charbonnière' } },
        { s: 'Erithacus rubecula', n: { en_uk: 'European Robin', de: 'Rotkehlchen', fr: 'Rougegorge familier' } },
    ],
};

// ─── resolveCommonName ──────────────────────────────────────────────

test('resolveCommonName returns requested language', () => {
    const t = new TaxonomyResolver();
    t.load(MOCK_TAXONOMY);
    const rec = t.resolve('Picus viridis');
    assert.equal(t.resolveCommonName(rec, 'de'), 'Grünspecht');
    assert.equal(t.resolveCommonName(rec, 'en_uk'), 'European Green Woodpecker');
    assert.equal(t.resolveCommonName(rec, 'fr'), 'Pic vert');
});

test('resolveCommonName falls back to en_uk for unknown language', () => {
    const t = new TaxonomyResolver();
    t.load(MOCK_TAXONOMY);
    const rec = t.resolve('Parus major');
    assert.equal(t.resolveCommonName(rec, 'xx_unknown'), 'Great Tit');
});

test('resolveCommonName returns empty for null record', () => {
    const t = new TaxonomyResolver();
    t.load(MOCK_TAXONOMY);
    assert.equal(t.resolveCommonName(null, 'de'), '');
});

// ─── resolve ────────────────────────────────────────────────────────

test('resolve returns matching record by exact name', () => {
    const t = new TaxonomyResolver();
    t.load(MOCK_TAXONOMY);
    const rec = t.resolve('Erithacus rubecula');
    assert.ok(rec);
    assert.equal(rec.s, 'Erithacus rubecula');
    assert.equal(rec.n.de, 'Rotkehlchen');
});

test('resolve returns null for unknown species', () => {
    const t = new TaxonomyResolver();
    t.load(MOCK_TAXONOMY);
    assert.equal(t.resolve('No such bird'), null);
});

// ─── Language switch: re-resolve label names ────────────────────────

test('label display names update when language changes', () => {
    const t = new TaxonomyResolver();
    t.load(MOCK_TAXONOMY);

    // Simulate labels created with language = 'en_uk'
    const labels = [
        { id: '1', scientificName: 'Picus viridis', label: 'European Green Woodpecker' },
        { id: '2', scientificName: 'Parus major', label: 'Great Tit' },
        { id: '3', scientificName: '', label: 'Noise' }, // no taxonomy link
    ];

    // Simulate language change to 'de' — re-resolve each label
    for (const lbl of labels) {
        if (!lbl.scientificName) continue;
        const record = t.resolve(lbl.scientificName);
        const localized = t.resolveCommonName(record, 'de');
        if (localized) lbl.label = localized;
    }

    assert.equal(labels[0].label, 'Grünspecht');
    assert.equal(labels[1].label, 'Kohlmeise');
    assert.equal(labels[2].label, 'Noise'); // untouched

    // Switch to French
    for (const lbl of labels) {
        if (!lbl.scientificName) continue;
        const record = t.resolve(lbl.scientificName);
        const localized = t.resolveCommonName(record, 'fr');
        if (localized) lbl.label = localized;
    }

    assert.equal(labels[0].label, 'Pic vert');
    assert.equal(labels[1].label, 'Mésange charbonnière');
    assert.equal(labels[2].label, 'Noise');
});

test('label display names survive round-trip through multiple languages', () => {
    const t = new TaxonomyResolver();
    t.load(MOCK_TAXONOMY);

    const lbl = { id: '1', scientificName: 'Erithacus rubecula', label: 'European Robin' };

    const langs = ['de', 'fr', 'en_uk', 'de'];
    const expected = ['Rotkehlchen', 'Rougegorge familier', 'European Robin', 'Rotkehlchen'];

    for (let i = 0; i < langs.length; i++) {
        const record = t.resolve(lbl.scientificName);
        const localized = t.resolveCommonName(record, langs[i]);
        if (localized) lbl.label = localized;
        assert.equal(lbl.label, expected[i], `after switching to ${langs[i]}`);
    }
});

// ─── languages ──────────────────────────────────────────────────────

test('languages returns available language codes', () => {
    const t = new TaxonomyResolver();
    t.load(MOCK_TAXONOMY);
    assert.deepEqual(t.languages, ['en_uk', 'de', 'fr']);
});

test('languages returns empty before load', () => {
    const t = new TaxonomyResolver();
    assert.deepEqual(t.languages, []);
});
