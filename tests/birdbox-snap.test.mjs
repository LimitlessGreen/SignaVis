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

// ── NearbyRows: BirdBox only around a snap click (BirdBoxPanel.detectNear) ──
const { NearbyRows, nearWindows } = await import('../src/domain/detector/nearby.ts');

function nearby() {
    const calls = [];
    let release = () => {};
    const o = {
        hold: false,
        prepare: async () => new Float32Array(1),
        async detect(_pcm, from, to) {
            calls.push({ from, to });
            if (o.hold) await new Promise((r) => { release = r; });
            // The fixture's rows of windows from … to-1 (column 7: window start)
            const rows = [];
            for (let i = 0; i < fx.rawRows; i++) {
                const s = data[i * 9 + 7];
                if (s >= from * 1.5 && s < to * 1.5) rows.push(...data.subarray(i * 9, i * 9 + 9));
            }
            return { data: Float32Array.from(rows), rows: rows.length / 9, next: to, analyzedTo: 0, done: false };
        },
    };
    return { near: new NearbyRows(o), o, calls, release: () => release() };
}

test('nearWindows: the click ± 6 s, and the window before for a box starting there', () => {
    const { from, to } = nearWindows(30);
    assert.ok(from * 1.5 + 3 <= 24 && to * 1.5 >= 36 && (to - from) * 1.5 < 20, JSON.stringify({ from, to }));
    assert.equal(nearWindows(1).from, 0);
});

test('NearbyRows: the stretch around the click holds the box the whole run has there', async () => {
    const b = fuseBoxes(data, fx.rawRows, 0.15, 0.05).sort((x, y) => y.max - x.max)[0];
    const [t, f] = centre(b);
    const { near, calls } = nearby();
    assert.equal(near.at('rec', t), null);
    assert.equal(await near.detect('rec', {}, t), true);
    assert.deepEqual(calls, [nearWindows(t)]);
    const s = near.at('rec', t);
    assert.equal(s.raw.done, true);
    const got = boxUnder(s.raw.data, s.raw.rows, t, f, { conf: 0.15, gap: 0.05, minConf: 0.05 });
    assert.deepEqual(got.box, at(t, f, 0.15).box);
});

test('NearbyRows: rows of a recording forgotten meanwhile are dropped', async () => {
    const { near, o, release } = nearby();
    o.hold = true;
    const pending = near.detect('rec', {}, 30);
    await new Promise((r) => setTimeout(r, 0));
    near.forget('rec');
    release();
    assert.equal(await pending, false);
    assert.equal(near.at('rec', 30), null);
});

test('NearbyRows: a click during a forgotten detection (e.g. channel change) detects anew', async () => {
    const { near, o, calls, release } = nearby();
    o.hold = true;
    const first = near.detect('rec', {}, 30);
    await new Promise((r) => setTimeout(r, 0));
    near.forgetAll();
    o.hold = false;
    const second = near.detect('rec', {}, 30);
    release();
    assert.equal(await first, false);
    assert.equal(await second, true);
    assert.equal(calls.length, 2);
    assert.ok(near.at('rec', 30));
});

test('runCovers: a finished run holds every click, a stopped one only up to its analysed end', async () => {
    const { runCovers } = await import('../src/domain/detector/nearby.ts');
    assert.equal(runCovers({ analyzedTo: 20 }, false, 100), true);
    assert.equal(runCovers({ analyzedTo: 20 }, true, 10), true);
    assert.equal(runCovers({ analyzedTo: 20 }, true, 18), false);
    assert.equal(runCovers({ analyzedTo: 20 }, true, 100), false);
});
