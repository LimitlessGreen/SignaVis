import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fuseBoxes, RAW_COLS, type FusedBox, type FusionCache } from '../src/domain/detector/fusion.ts';

// Fixtures: scripts/birdbox/make-fusion-fixtures.mjs (BirdBox graph = ground truth)
const DIR = new URL('./fixtures/birdbox-fusion/', import.meta.url);
const FIELDS = ['t0', 't1', 'flo', 'fhi', 'avg', 'max', 'n', 'cls'] as const;
const TOLERANCE = 1e-5; // relative; the port is meant to be exact

interface Fixture {
    rawRows: number;
    rawFile: string;
    settings: { conf: number; gap: number; detections: number[][] }[];
}

const fixtures = readdirSync(DIR).filter(f => f.endsWith('.json')).map(name => {
    const fx: Fixture = JSON.parse(readFileSync(new URL(name, DIR), 'utf8'));
    const bytes = readFileSync(new URL(fx.rawFile, DIR));
    const raw = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    assert.equal(raw.length, fx.rawRows * RAW_COLS);
    return { name, fx, raw };
});

function maxDeviation(js: FusedBox[], ref: number[][]): number {
    if (js.length !== ref.length) return Infinity;
    let dev = 0;
    js.forEach((b, i) => FIELDS.forEach((k, j) => {
        const r = ref[i][j];
        dev = Math.max(dev, Math.abs(b[k] - r) / Math.max(1, Math.abs(r)));
    }));
    return dev;
}

test('fixtures exist', () => assert.ok(fixtures.length > 0));

for (const { name, fx, raw } of fixtures) {
    for (const { conf, gap, detections } of fx.settings) {
        test(`${name}: fusion equals the BirdBox graph at conf ${conf}, gap ${gap}`, () => {
            const js = fuseBoxes(raw, fx.rawRows, conf, gap);
            assert.equal(js.length, detections.length, 'box count');
            assert.ok(maxDeviation(js, detections) <= TOLERANCE);
        });
    }

    test(`${name}: incremental fusion with cache equals fusing all rows`, () => {
        // Rows grow one window at a time, as while detection runs
        const windowStart = (r: number) => raw[r * RAW_COLS + 7];
        for (const { conf, gap } of fx.settings) {
            const cache: FusionCache = {};
            let r = 0;
            while (r < fx.rawRows) {
                const w = windowStart(r);
                while (r < fx.rawRows && windowStart(r) === w) r++;
                const later = r < fx.rawRows ? windowStart(r) : Infinity;
                const withCache = fuseBoxes(raw, r, conf, gap, cache, later);
                assert.deepEqual(withCache, fuseBoxes(raw, r, conf, gap), `conf ${conf} gap ${gap} rows ${r}`);
            }
        }
    });
}
