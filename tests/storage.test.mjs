// ═══════════════════════════════════════════════════════════════════════
// storage.test.mjs — Tests for IStorage implementations
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryStorageAdapter } from '../src/infrastructure/storage/InMemoryStorageAdapter.ts';

// ─── InMemoryStorageAdapter ──────────────────────────────────────────

test('InMemoryStorageAdapter: getItem returns null for missing key', () => {
    const s = new InMemoryStorageAdapter();
    assert.equal(s.getItem('missing'), null);
});

test('InMemoryStorageAdapter: setItem + getItem round-trip', () => {
    const s = new InMemoryStorageAdapter();
    s.setItem('key', 'value');
    assert.equal(s.getItem('key'), 'value');
});

test('InMemoryStorageAdapter: setItem coerces value to string', () => {
    const s = new InMemoryStorageAdapter();
    s.setItem('num', /** @type {any} */ (42));
    assert.equal(s.getItem('num'), '42');
});

test('InMemoryStorageAdapter: removeItem deletes the entry', () => {
    const s = new InMemoryStorageAdapter();
    s.setItem('k', 'v');
    s.removeItem('k');
    assert.equal(s.getItem('k'), null);
});

test('InMemoryStorageAdapter: removeItem is a no-op for missing key', () => {
    const s = new InMemoryStorageAdapter();
    assert.doesNotThrow(() => s.removeItem('nonexistent'));
});

test('InMemoryStorageAdapter: hasItem returns true for existing key', () => {
    const s = new InMemoryStorageAdapter();
    s.setItem('x', '1');
    assert.equal(s.hasItem('x'), true);
});

test('InMemoryStorageAdapter: hasItem returns false for missing key', () => {
    const s = new InMemoryStorageAdapter();
    assert.equal(s.hasItem('nope'), false);
});

test('InMemoryStorageAdapter: clear removes all entries', () => {
    const s = new InMemoryStorageAdapter({ a: '1', b: '2' });
    s.clear();
    assert.equal(s.getItem('a'), null);
    assert.equal(s.getItem('b'), null);
});

test('InMemoryStorageAdapter: initial data is accessible', () => {
    const s = new InMemoryStorageAdapter({ preset: '{"n":1}' });
    assert.equal(s.getItem('preset'), '{"n":1}');
});

test('InMemoryStorageAdapter: instances are isolated (no shared state)', () => {
    const s1 = new InMemoryStorageAdapter();
    const s2 = new InMemoryStorageAdapter();
    s1.setItem('k', 'v1');
    assert.equal(s2.getItem('k'), null, 'second adapter should not see first adapter writes');
});

test('InMemoryStorageAdapter: toObject returns snapshot of all entries', () => {
    const s = new InMemoryStorageAdapter({ a: '1' });
    s.setItem('b', '2');
    const obj = s.toObject();
    assert.deepEqual(obj, { a: '1', b: '2' });
});

test('InMemoryStorageAdapter: JSON round-trip (PresetManager pattern)', () => {
    const s = new InMemoryStorageAdapter();
    const presets = { myPreset: { fftSize: 2048, hopSize: 512 } };
    s.setItem('aw-user-presets', JSON.stringify(presets));
    const loaded = JSON.parse(s.getItem('aw-user-presets') ?? '{}');
    assert.deepEqual(loaded, presets);
});

// ─── PresetManager integration (without DOM) ─────────────────────────
// These tests verify that PresetManager correctly uses the injected storage
// adapter — i.e. the migration from direct localStorage is complete.
// We can't instantiate PresetManager (requires DOM refs), but we verify
// the adapter contract that PresetManager calls through.

test('InMemoryStorageAdapter: can simulate PresetManager favourite key lifecycle', () => {
    const s = new InMemoryStorageAdapter();
    // Simulate getFavouritePreset (returns '' when not set)
    assert.equal(s.getItem('aw-favourite-preset') || '', '', 'default favourite is empty string');
    // Simulate setFavouritePreset
    s.setItem('aw-favourite-preset', 'my-preset');
    assert.equal(s.getItem('aw-favourite-preset'), 'my-preset');
});

test('InMemoryStorageAdapter: can simulate label section collapse persistence', () => {
    const s = new InMemoryStorageAdapter();
    s.setItem('aw-label-section-collapsed', '1');
    assert.equal(s.getItem('aw-label-section-collapsed') === '1', true);
    s.setItem('aw-label-section-collapsed', '0');
    assert.equal(s.getItem('aw-label-section-collapsed') === '1', false);
});
