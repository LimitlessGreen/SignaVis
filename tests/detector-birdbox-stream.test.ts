import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    analyzedTo, BlockSource, CLIP_SAMPLES, fileEnd, finishRows, FLOOR_FRACTION, Frames, HOP_SAMPLES,
    NO_END, paddedLength, readPadded, readyWindows, RollingFloor, SAMPLE_RATE, sourceOf, windowCount,
} from '../src/domain/detector/birdboxStream.ts';

const f32 = Math.fround;
const random = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

test('window planning', () => {
    assert.equal(readyWindows(CLIP_SAMPLES - 1), 0);
    assert.equal(readyWindows(CLIP_SAMPLES), 1);
    assert.equal(readyWindows(CLIP_SAMPLES + HOP_SAMPLES - 1), 1);
    assert.equal(readyWindows(CLIP_SAMPLES + HOP_SAMPLES), 2);
    // A short file is padded to one whole window
    assert.equal(paddedLength(1000), CLIP_SAMPLES);
    assert.equal(windowCount(1000), 1);
    // 10 s: windows at 0, 1.5 … 7.5 (ends 10.5) → 6 windows, padded to 10.5 s
    assert.equal(windowCount(10 * SAMPLE_RATE), 6);
    assert.equal(fileEnd(10 * SAMPLE_RATE), f32(10.5));
    // Exactly whole windows: no padding, and every window is ready
    const n = CLIP_SAMPLES + 4 * HOP_SAMPLES;
    assert.equal(paddedLength(n), n);
    assert.equal(readyWindows(n), windowCount(n));
    assert.equal(analyzedTo(1), 2.25);
    assert.equal(analyzedTo(3), 5.25);
});

test('readPadded adds silence after the end', async () => {
    const src = sourceOf(Float32Array.from([1, 2, 3]));
    assert.deepEqual([...await readPadded(src, 1, 6)], [2, 3, 0, 0, 0]);
    assert.deepEqual([...await readPadded(src, 4, 6)], [0, 0]);
});

test('BlockSource hands out blocks, asks ahead and drops released samples', async () => {
    const all = Float32Array.from({ length: 100 }, (_, i) => i);
    const asks: [number, number][] = [];
    const src: BlockSource = new BlockSource(100, (from, to) => {
        asks.push([from, to]);
        queueMicrotask(() => src.receive({ from, data: all.slice(from, to) }));
    }, 20);
    for (let from = 0; from < 100; from += 7) {
        const to = Math.min(100, from + 7);
        assert.deepEqual([...await src.read(from, to)], [...all.subarray(from, to)]);
        src.release(from);
    }
    assert.deepEqual(asks, [[0, 20], [20, 40], [40, 60], [60, 80], [80, 100]]);
    await assert.rejects(src.read(0, 5), /let go/);
    assert.throws(() => src.receive({ from: 3, data: new Float32Array(1) }), /expected/);
});

test('Frames append, slice and drop keep band layout', () => {
    const bands = 3, fr = new Frames(bands);
    let next = 0;
    const block = (n: number) => {
        const db = new Float32Array(bands * n);
        for (let b = 0; b < bands; b++) for (let i = 0; i < n; i++) db[b * n + i] = b * 1e5 + next + i;
        const sound = Uint8Array.from({ length: n }, (_, i) => (next + i) % 2);
        next += n;
        return { db, sound, n };
    };
    for (let k = 0; k < 5; k++) { const { db, sound, n } = block(1500); fr.append(db, sound, n); }  // grows past 4096
    fr.drop(2000);
    assert.equal(fr.base, 2000);
    const { db, sound, n } = fr.slice(2100, 2110);
    assert.equal(n, 10);
    for (let b = 0; b < bands; b++) for (let i = 0; i < n; i++) assert.equal(db[b * n + i], b * 1e5 + 2100 + i);
    assert.deepEqual([...sound], Array.from({ length: 10 }, (_, i) => (2100 + i) % 2));
    assert.throws(() => fr.slice(1999, 2001), /not computed/);
});

/** The graph's definition: sort the frames with sound (or all), interpolate in float32. */
function naiveFloor(fr: Frames, lo: number, hi: number, bands: number): Float32Array {
    const out = new Float32Array(bands);
    const withSound: number[] = [];
    for (let f = lo; f < hi; f++) if (fr.sound[f - fr.base]) withSound.push(f);
    const use = withSound.length ? withSound : Array.from({ length: hi - lo }, (_, i) => lo + i);
    for (let b = 0; b < bands; b++) {
        const v = Float32Array.from(use, f => fr.db[b * fr.cap + f - fr.base]).sort();
        const pos = f32(f32(v.length - 1) * FLOOR_FRACTION), below = Math.floor(pos);
        const frac = f32(pos - below), above = Math.min(below + 1, v.length - 1);
        out[b] = f32(v[below] + f32(f32(v[above] - v[below]) * frac));
    }
    return out;
}

test('RollingFloor equals sorting every floor window anew', () => {
    const bands = 4, total = 3000, r = random(5), fr = new Frames(bands);
    const db = new Float32Array(bands * total), sound = new Uint8Array(total);
    for (let i = 0; i < db.length; i++) db[i] = f32(-80 + 60 * r() + (r() < 0.05 ? 30 : 0));
    // Long stretches without sound (whole floor windows) and with a few ties
    for (let i = 0; i < total; i++) sound[i] = i > 700 && i < 1500 ? 0 : r() < 0.6 ? 1 : 0;
    for (let i = 0; i < 50; i++) db[Math.floor(r() * db.length)] = -50;
    fr.append(db, sound, total);
    const rolling = new RollingFloor(bands), WIN = 600, STEP = 128;
    const out = new Float32Array(bands);
    let windows = 0;
    for (let hi = 200; hi <= total; hi += STEP, windows++) {
        const lo = Math.max(0, hi - WIN);
        rolling.at(fr, lo, hi, out, 0, 1);
        assert.deepEqual([...out], [...naiveFloor(fr, lo, hi, bands)], `window ${lo}..${hi}`);
    }
    assert.ok(windows > 15);
});

test('finishRows: minute numbering, clipping to the content, file end', () => {
    const row = (t0: number, t1: number, clipStart: number) => [0, t0, t1, 1000, 2000, 0.9, 0, clipStart, 0];
    const samples = Math.round(4.2 * SAMPLE_RATE);           // padded to 4.5 s
    const data = Float32Array.from([...row(1, 2, 0), ...row(4.0, 4.4, 1.5), ...row(4.3, 4.4, 1.5), ...row(2, 3, 60)]);
    const file = finishRows(data.slice(), 4, samples);
    assert.equal(file.rows, 3);                               // the box past the content is gone
    assert.equal(file.data[9 + 2], f32(4.2));                 // clipped to the content
    assert.equal(file.data[8], f32(4.5));                     // file end = padded length
    assert.equal(file.data[0], 0);
    assert.equal(file.data[9], 1);
    assert.equal(file.data[18], 0);                           // window 40 → 0 in its minute
    const live = finishRows(data.slice(), 4, null);
    assert.equal(live.rows, 4);
    assert.equal(live.data[8], NO_END);
});
