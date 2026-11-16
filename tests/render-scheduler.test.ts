import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RenderScheduler } from '../src/app/labeling/render-scheduler.ts';

function setup() {
    const calls: string[] = [];
    const queue: Array<() => void> = [];
    const s = new RenderScheduler<'a' | 'b' | 'c'>([
        ['a', () => calls.push('a')],
        ['b', (p) => calls.push(p.has('a') ? 'b+a' : 'b')],
        ['c', () => calls.push('c')],
    ], (cb) => queue.push(cb));
    const tick = () => { while (queue.length) queue.shift()!(); };
    return { s, calls, queue, tick };
}

test('merges invalidations into one flush, each step once, in step order', () => {
    const { s, calls, queue, tick } = setup();
    s.invalidate('c'); s.invalidate('a', 'c'); s.invalidate('a');
    assert.equal(queue.length, 1);
    assert.deepEqual(calls, []);
    tick();
    assert.deepEqual(calls, ['a', 'c']);
});

test('steps see the whole batch', () => {
    const { s, calls, tick } = setup();
    s.invalidate('b', 'a');
    tick();
    assert.deepEqual(calls, ['a', 'b+a']);
});

test('flush() runs now; the scheduled flush then has nothing to do', () => {
    const { s, calls, tick } = setup();
    s.invalidate('a');
    s.flush();
    assert.deepEqual(calls, ['a']);
    tick();
    assert.deepEqual(calls, ['a']);
    assert.equal(s.pending.size, 0);
});

test('invalidating during a flush schedules another one', () => {
    const queue: Array<() => void> = [];
    const calls: string[] = [];
    let s: RenderScheduler<'x' | 'y'>;
    s = new RenderScheduler<'x' | 'y'>([
        ['x', () => { calls.push('x'); s.invalidate('y'); }],
        ['y', () => calls.push('y')],
    ], (cb) => queue.push(cb));
    s.invalidate('x');
    queue.shift()!();
    assert.deepEqual(calls, ['x']);
    assert.equal(queue.length, 1);
    queue.shift()!();
    assert.deepEqual(calls, ['x', 'y']);
});

test('a failing step does not stop the others', () => {
    const queue: Array<() => void> = [];
    const calls: string[] = [];
    const s = new RenderScheduler<'x' | 'y'>([
        ['x', () => { throw new Error('boom'); }],
        ['y', () => calls.push('y')],
    ], (cb) => queue.push(cb));
    const err = console.error; console.error = () => {};
    try { s.invalidate('x', 'y'); queue.shift()!(); } finally { console.error = err; }
    assert.deepEqual(calls, ['y']);
});

test('defaults to a microtask', async () => {
    // Browsers throw "Illegal invocation" when queueMicrotask is called with another `this`.
    const orig = globalThis.queueMicrotask;
    globalThis.queueMicrotask = function (this: unknown, cb: () => void) {
        assert.ok(this === undefined || this === globalThis, 'queueMicrotask called as a method');
        orig(cb);
    };
    try { await defaultsCase(); } finally { globalThis.queueMicrotask = orig; }
});

async function defaultsCase() {
    const calls: string[] = [];
    const s = new RenderScheduler<'a'>([['a', () => calls.push('a')]]);
    s.invalidate('a');
    assert.deepEqual(calls, []);
    await Promise.resolve();
    assert.deepEqual(calls, ['a']);
}
