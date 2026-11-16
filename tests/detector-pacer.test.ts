// Port of BirdBox tests/js/demo_pacer.mjs (MIT, BirdNET-Team): simulated workers
// on a simulated clock; paced windows must be evenly spaced, in order, and done
// soon after the worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HAND_MS, Pacer } from '../src/domain/detector/pacer.ts';

const random = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

function worker(windows: number, timeOf: (w: number) => number): number[] {
    const at: number[] = [];
    let t = 0;
    for (let w = 0; w < windows; w++) at.push(t += timeOf(w));
    return at;
}

interface Ev { at: number; fn: () => void; seq: number; live: boolean }
interface Shown { at: number; index: number; stopped: boolean }

async function replay(arrivals: number[], { cost = 0, stopAfter = Infinity } = {}) {
    let t = 0, seq = 0, doneAt: number | null = null, stopped = false;
    const events: Ev[] = [], shows: Shown[] = [];
    const schedule = (at: number, fn: () => void) => { const e = { at, fn, seq: seq++, live: true }; events.push(e); return e; };
    const pacer = new Pacer<{ index: number }, Ev>(item => {
        shows.push({ at: t, index: item.index, stopped });
        t += cost;
    }, { now: () => t, later: (fn, ms) => schedule(t + ms, fn), cancel: e => { if (e) e.live = false; } });
    arrivals.forEach((at, i) => schedule(at, () => {
        if (stopped) return;
        pacer.push({ index: i });
        if (i + 1 === stopAfter) { pacer.stop(); stopped = true; }
        else if (i + 1 === arrivals.length) pacer.finish().then(() => { doneAt = t; });
    }));
    for (;;) {
        const live = events.filter(e => e.live);
        if (!live.length) break;
        const e = live.reduce((a, b) => (a.at < b.at || (a.at === b.at && a.seq < b.seq) ? a : b));
        e.live = false;
        t = Math.max(t, e.at);
        e.fn();
        await new Promise(resolve => setImmediate(resolve));
    }
    return { shows, doneAt: doneAt as number | null };
}

function spacing(times: number[], indexes: number[]) {
    const per: number[] = [];
    for (let k = 1; k < times.length; k++) per.push((times[k] - times[k - 1]) / (indexes[k] - indexes[k - 1]));
    const sorted = [...per].sort((a, b) => a - b), median = sorted[sorted.length >> 1];
    const mean = per.reduce((a, b) => a + b, 0) / per.length;
    const sd = Math.sqrt(per.reduce((a, b) => a + (b - mean) ** 2, 0) / per.length);
    const worst = Math.max(...per.map(v => Math.abs(v - median) / median));
    return { median, spread: sd / mean, worst };
}

async function scenario(arrivals: number[], options: { cost?: number } = {}) {
    const { shows, doneAt } = await replay(arrivals, options);
    const steps = shows.slice(1).map((x, k) => x.index - shows[k].index);
    const timed = steps.length > 1 && steps.at(-1)! < steps.at(-2)! ? shows.slice(0, -1) : shows;
    const s = spacing(timed.map(x => x.at), timed.map(x => x.index));
    assert.ok(shows.every((x, k) => !k || x.index > shows[k - 1].index), 'in order');
    assert.equal(shows.at(-1)!.index, arrivals.length - 1, 'every window shown');
    assert.ok(s.spread < 0.1, `spread ${(s.spread * 100).toFixed(1)}% < 10%`);
    assert.ok(s.worst < 0.3, `furthest ${(s.worst * 100).toFixed(0)}% from median < 30%`);
    const allowed = HAND_MS + 3 * s.median * Math.max(...steps);
    assert.ok(doneAt != null && doneAt - arrivals.at(-1)! <= allowed, 'done soon after the worker');
    return steps;
}

for (const seed of [7, 8, 9]) {
    test(`Just-Bird-like worker, 200 windows, seed ${seed}`, async () => {
        const r = random(seed), slow = new Set<number>();
        for (let w = 8; w < 200; w += 15 + Math.floor(r() * 20)) for (let k = 0; k < 3; k++) slow.add(w + k);
        await scenario(worker(200, w => (130 + 20 * Math.min(1, w / 40)) * (slow.has(w) ? 2 : 1) * (0.95 + 0.1 * r())));
    });
}

test('Birds-With-Labels-like worker, 200 windows', async () => {
    const r = random(11), slow = new Set<number>();
    for (let w = 8; w < 200; w += 15 + Math.floor(r() * 20)) for (let k = 0; k < 2; k++) slow.add(w + k);
    await scenario(worker(200, w => 490 * (slow.has(w) ? 1.5 : 1) * (0.98 + 0.04 * r())));
});

test('costly redraws: each step shows as many windows', async () => {
    const r = random(3);
    const steps = await scenario(worker(120, () => 100 * (0.95 + 0.1 * r())), { cost: 60 });
    assert.equal(new Set(steps.slice(0, -1)).size, 1);
    assert.ok(steps[0] > 1);
});

test('fewer windows than a hand', async () => {
    const { shows, doneAt } = await replay([300, 450]);
    assert.equal(shows.at(-1)!.index, 1);
    assert.notEqual(doneAt, null);
});

test('stopped halfway: nothing shown after the stop', async () => {
    const { shows } = await replay(worker(80, () => 140), { stopAfter: 30 });
    assert.ok(!shows.some(x => x.stopped));
    assert.ok(shows.at(-1)!.index < 30);
});
