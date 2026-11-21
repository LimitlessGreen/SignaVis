import test from 'node:test';
import assert from 'node:assert/strict';
import { SpectrogramCache } from '../src/infrastructure/SpectrogramCache.ts';

test('the cache takes entries up to a quarter of its byte limit', () => {
    const c = new SpectrogramCache({ maxBytes: 256 * 2 ** 20 });
    assert.equal(c.accepts(64 * 2 ** 20), true);
    assert.equal(c.accepts(64 * 2 ** 20 + 1), false);
});

test('an entry the cache does not take is not written', async () => {
    const c = new SpectrogramCache({ maxBytes: 1024, minFreeBytes: 0 });
    let opened = false;
    c._open = async () => { opened = true; return null; };
    await c.set('k', { dataBuffer: new ArrayBuffer(1024), nFrames: 1, nMels: 1 });
    assert.equal(opened, false);
});
