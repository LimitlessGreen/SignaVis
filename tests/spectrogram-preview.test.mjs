import test from 'node:test';
import assert from 'node:assert/strict';
import { WasmTileManager, pyramidWorkerCount } from '../src/app/WasmTileManager.ts';

function meta(median) {
    const stats = { min: -100, max: 0, p2: -90, p98: -5, median, p999: -1, bandFloor: [-80, -80] };
    return { version: 4, params: { sampleRate: 8000, winLen: 256, hop: 64, nFft: 256,
        scale: { kind: 'linear' }, pcen: null, output: 'db' }, nSamples: 320000,
        bins: 2, stats, levels: [{ factor: 1, nFrames: 5001, stats }] };
}
const options = { colorScheme: 'magma', maxFreq: 4000, floor01: 0, ceil01: 1,
    noiseReduction: false, clahe: false, scale: 'linear', colourScale: 'db' };

// Exercise the manager's transition without relying on timing of a real worker.
test('keeps the visible preview available while the full pyramid takes over', async () => {
    const preview = { disposed: false, tile: async (_level, a, b) => new Float32Array((b - a) * 2).fill(-50),
        dispose() { this.disposed = true; } };
    const full = { tile: preview.tile, dispose() {} };
    const manager = new WasmTileManager(preview, meta(-80), false, 40, options);
    await manager.computeFirstTile();
    let complete;
    manager.buildFull = () => new Promise(resolve => { complete = resolve; });
    manager.queueAllTiles();
    assert.equal(manager.hasTiles, true);
    complete({ svc: full, meta: meta(-60), fromCache: false });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(preview.disposed, true);
    assert.equal(manager.hasTiles, true);
    assert.equal(manager.globalMin, -60);
    assert.equal(manager.firstReadyTileData()[0], -50);
    manager.dispose();
});

test('requests the visible tile before neighboring preload tiles', async () => {
    const starts = [];
    const source = { tile: async (_level, a, b) => { starts.push(a); return new Float32Array((b - a) * 2); }, dispose() {} };
    const manager = new WasmTileManager(source, meta(-80), false, 40, options);
    manager.requestViewport(25, 26, 100);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(starts, [3072, 2048, 4096]);
    manager.dispose();
});

test('limits workers for large frequency dimensions while keeping at least one', () => {
    const params = { nFft: 1024, scale: { kind: 'mel', bands: 160 } };
    assert.equal(pyramidWorkerCount(params, 16), 7);
    assert.equal(pyramidWorkerCount({ ...params, scale: { kind: 'mel', bands: 512 } }, 16), 2);
    assert.equal(pyramidWorkerCount({ ...params, nFft: 16384, scale: { kind: 'linear' } }, 16), 1);
    assert.equal(pyramidWorkerCount(params, 1), 1);
});
