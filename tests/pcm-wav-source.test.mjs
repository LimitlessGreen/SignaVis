// pcmWavSource: OPFS file when possible; an in-memory Blob only for audio small enough.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pcmWavSource } from '../src/app/WasmTileManager.ts';

const full = async () => { const e = new Error('No space available'); e.name = 'QuotaExceededError'; throw e; };

test('pcmWavSource uses the written file', async () => {
    const file = new Blob(['x']);
    assert.strictEqual(await pcmWavSource(new Float32Array(4), 48000, async () => file), file);
});

test('pcmWavSource keeps small audio in memory when OPFS fails', async () => {
    const blob = await pcmWavSource(new Float32Array(4), 48000, full, 16);
    assert.strictEqual(blob.size, 44 + 16);
});

test('pcmWavSource rethrows for audio above the memory limit', async () => {
    await assert.rejects(pcmWavSource(new Float32Array(5), 48000, full, 16), { name: 'QuotaExceededError' });
});
