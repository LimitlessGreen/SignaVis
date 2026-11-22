import test from 'node:test';
import assert from 'node:assert/strict';

import { prefs, setPrefsBackend } from '../src/infrastructure/storage/prefs.ts';

function memory() {
    const m = new Map();
    return {
        map: m,
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => { m.set(k, String(v)); },
        removeItem: (k) => { m.delete(k); },
    };
}

const throwing = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); },
};

test('strings round-trip and remove', () => {
    setPrefsBackend(memory());
    assert.equal(prefs.get('a'), null);
    prefs.set('a', 'x');
    assert.equal(prefs.get('a'), 'x');
    prefs.remove('a');
    assert.equal(prefs.get('a'), null);
});

test('flags: stored as 1/0, read true/false, fallback otherwise', () => {
    const m = memory();
    setPrefsBackend(m);
    assert.equal(prefs.flag('f'), false);
    assert.equal(prefs.flag('f', true), true);
    prefs.setFlag('f', true);
    assert.equal(m.map.get('f'), '1');
    assert.equal(prefs.flag('f'), true);
    prefs.setFlag('f', false);
    assert.equal(m.map.get('f'), '0');
    assert.equal(prefs.flag('f', true), false);
    m.setItem('g', 'true');
    assert.equal(prefs.flag('g'), true);
    m.setItem('g', 'garbage');
    assert.equal(prefs.flag('g', true), true);
});

test('json: parsed value, fallback when missing, broken or null', () => {
    const m = memory();
    setPrefsBackend(m);
    assert.deepEqual(prefs.json('j', { d: 1 }), { d: 1 });
    prefs.setJson('j', { a: [1, 2] });
    assert.deepEqual(prefs.json('j', {}), { a: [1, 2] });
    m.setItem('j', '{broken');
    assert.deepEqual(prefs.json('j', []), []);
    m.setItem('j', 'null');
    assert.deepEqual(prefs.json('j', 'fb'), 'fb');
    const cyclic = {}; cyclic.self = cyclic;
    prefs.setJson('k', cyclic);   // must not throw
    assert.equal(prefs.get('k'), null);
});

test('blocked storage never throws and reads defaults', () => {
    setPrefsBackend(throwing);
    assert.equal(prefs.get('a'), null);
    assert.doesNotThrow(() => prefs.set('a', 'x'));
    assert.doesNotThrow(() => prefs.remove('a'));
    assert.equal(prefs.flag('a', true), true);
    assert.deepEqual(prefs.json('a', [1]), [1]);
    setPrefsBackend(null);   // persist nothing
    prefs.set('a', 'x');
    assert.equal(prefs.get('a'), null);
});

test('default backend: globalThis.localStorage, getter that throws is handled', () => {
    const m = memory();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => m });
    setPrefsBackend(undefined);
    prefs.set('z', '1');
    assert.equal(m.map.get('z'), '1');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('denied'); } });
    assert.equal(prefs.get('z'), null);
    assert.doesNotThrow(() => prefs.set('z', '2'));
    delete globalThis.localStorage;
});
