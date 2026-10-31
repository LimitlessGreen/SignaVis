import test from 'node:test';
import assert from 'node:assert/strict';

import { AudioBlobStore, createMemoryBackend, xcAudioKey } from '../src/infrastructure/storage/audioBlobStore.ts';

const buf = (n, fill = 1) => new Uint8Array(n).fill(fill).buffer;

function makeStore(maxBytes = 1000) {
    let t = 0;
    const backend = createMemoryBackend();
    return { backend, store: new AudioBlobStore(backend, { maxBytes, now: () => ++t }) };
}

test('put/get roundtrip and usage', async () => {
    const { store } = makeStore();
    await store.put('XC1.mp3', buf(100, 7));
    const got = await store.get('XC1.mp3');
    assert.equal(got.byteLength, 100);
    assert.equal(new Uint8Array(got)[0], 7);
    assert.deepEqual(await store.usage(), { bytes: 100, count: 1, pinnedBytes: 0 });
    assert.equal(await store.get('missing'), null);
});

test('evicts least recently used unpinned entries', async () => {
    const { store } = makeStore(1000);
    await store.put('a', buf(400));
    await store.put('b', buf(400));
    await store.get('a');               // a is now more recent than b
    await store.put('c', buf(400));     // 1200 > 1000 → evict b
    assert.ok(await store.has('a'));
    assert.equal(await store.has('b'), false);
    assert.ok(await store.has('c'));
});

test('pinned entries survive eviction and clear()', async () => {
    const { store } = makeStore(1000);
    await store.put('pin', buf(600), { pinned: true });
    await store.put('x', buf(300));
    await store.put('y', buf(300));     // over limit → evict x, never pin
    assert.ok(await store.has('pin'));
    assert.equal(await store.has('x'), false);
    await store.clear();
    assert.ok(await store.has('pin'));
    assert.equal(await store.has('y'), false);
    await store.setPinned('pin', false);
    await store.clear();
    assert.equal((await store.usage()).count, 0);
});

test('re-put keeps pinned flag; concurrent puts keep all index entries', async () => {
    const { store, backend } = makeStore(1e9);
    await store.put('p', buf(10), { pinned: true });
    await store.put('p', buf(20));
    assert.equal((await store.usage()).pinnedBytes, 20);
    await Promise.all([1, 2, 3, 4].map((i) => store.put(`k${i}`, buf(10))));
    // fresh store instance reads the persisted index
    const again = new AudioBlobStore(backend);
    assert.equal((await again.usage()).count, 5);
});

test('xcAudioKey normalises prefix', () => {
    assert.equal(xcAudioKey('XC123'), 'XC123.mp3');
    assert.equal(xcAudioKey(123), 'XC123.mp3');
});
