import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boxUnder } from '../src/domain/detector/boxUnder.ts';
import { fuseBoxes } from '../src/domain/detector/fusion.ts';

const DIR = new URL('./fixtures/birdbox-fusion/', import.meta.url);
const fx = JSON.parse(readFileSync(new URL('test-120s.json', DIR), 'utf8'));
const bytes = readFileSync(new URL(fx.rawFile, DIR));
const data = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

const at = (time, freq, conf) => boxUnder(data, fx.rawRows, time, freq, { conf, gap: 0.05, minConf: 0.05 });
const centre = (b) => [(b.t0 + b.t1) / 2, (b.flo + b.fhi) / 2];

test('boxUnder: the fused box under the click at the asked confidence', () => {
    const boxes = fuseBoxes(data, fx.rawRows, 0.15, 0.05);
    assert.ok(boxes.length > 5);
    for (const b of boxes.slice(0, 5)) {
        const got = at(...centre(b), 0.15);
        assert.equal(got.weaker, false);
        // the most confident box under the point: this one, or a stronger one overlapping it
        const under = boxes.filter((o) => centre(b)[0] >= o.t0 && centre(b)[0] <= o.t1 && centre(b)[1] >= o.flo && centre(b)[1] <= o.fhi)
            .sort((x, y) => y.max - x.max)[0];
        assert.deepEqual(got.box, under);
    }
});

test('boxUnder: above a box\'s confidence there is none, but a weaker one; nothing in silence', () => {
    const boxes = fuseBoxes(data, fx.rawRows, 0.15, 0.05);
    const weak = boxes.filter((b) => b.max < 0.9).sort((a, b) => a.max - b.max)[0];
    const high = at(...centre(weak), 0.95);
    if (!high.box) assert.equal(high.weaker, true);   // unless a ≥ 0.95 box overlaps the point
    assert.deepEqual(at(500, 100, 0.15), { box: null, weaker: false });
});
