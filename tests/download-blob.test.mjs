import test from 'node:test';
import assert from 'node:assert/strict';

const { downloadBlob } = await import('../src/infrastructure/audio/AudioEngine.ts');

function response(parts, length, type = 'audio/wav') {
    const body = new ReadableStream({ start(c) { for (const p of parts) c.enqueue(new Uint8Array(p)); c.close(); } });
    const headers = { 'content-type': type };
    if (length !== undefined) headers['content-length'] = String(length);
    return new Response(body, { headers });
}

for (const [name, length] of [['exact length', 6], ['no length', undefined], ['wrong length', 4]]) {
    test(`downloadBlob: ${name}`, async () => {
        const seen = [];
        const blob = await downloadBlob(response([[1, 2], [3], [4, 5, 6]], length), (l) => seen.push(l));
        assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3, 4, 5, 6]);
        assert.equal(blob.type, 'audio/wav');
        assert.deepEqual(seen, [0, 2, 3, 6]);
    });
}

test('downloadBlob: large bodies go straight into a Blob (progress at start and end)', async () => {
    const chunk = (v) => new Uint8Array(8 * 1024 * 1024).fill(v);
    const seen = [];
    const blob = await downloadBlob(response([0, 1, 2, 3, 4, 5, 6, 7, 8].map(chunk), 9 * 8 * 1024 * 1024), (l, t) => seen.push([l, t]));
    assert.equal(blob.size, 9 * 8 * 1024 * 1024);
    assert.deepEqual(seen, [[0, 0], [blob.size, blob.size]]);
    for (let k = 0; k < 9; k++) {
        const b = new Uint8Array(await blob.slice(k * 8 * 1024 * 1024, k * 8 * 1024 * 1024 + 2).arrayBuffer());
        assert.deepEqual([...b], [k, k]);
    }
});
