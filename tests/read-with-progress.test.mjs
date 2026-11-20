import test from 'node:test';
import assert from 'node:assert/strict';

const { readWithProgress } = await import('../src/infrastructure/audio/AudioEngine.ts');

function response(parts, length) {
    const body = new ReadableStream({ start(c) { for (const p of parts) c.enqueue(new Uint8Array(p)); c.close(); } });
    const headers = length === undefined ? {} : { 'content-length': String(length) };
    return new Response(body, { headers });
}
const bytes = (buf) => [...new Uint8Array(buf)];

for (const [name, length] of [['exact length', 6], ['no length', undefined], ['length too small (compressed)', 4], ['length too large', 10]]) {
    test(`readWithProgress: ${name}`, async () => {
        const seen = [];
        const buf = await readWithProgress(response([[1, 2], [3], [4, 5, 6]], length), (l, t) => seen.push(l));
        assert.deepEqual(bytes(buf), [1, 2, 3, 4, 5, 6]);
        assert.equal(buf.byteLength, 6);
        assert.deepEqual(seen, [0, 2, 3, 6]);
    });
}
