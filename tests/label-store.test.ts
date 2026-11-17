import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LabelStore, type LabelChange } from '../src/app/labeling/label-store.ts';

type L = { id: string; name?: string };

function setup(freeze = true) {
    const s = new LabelStore<L>({ freeze });
    const changes: LabelChange[] = [];
    s.subscribe((c) => changes.push(c));
    return { s, changes };
}

test('load and clear set labels and owner together', () => {
    const { s, changes } = setup();
    s.load([{ id: 'a' }], 'rec1');
    assert.equal(s.entryId, 'rec1');
    assert.deepEqual(s.labels.map((l) => l.id), ['a']);
    s.clear();
    assert.equal(s.entryId, null);
    assert.equal(s.size, 0);
    s.clear('rec2');
    assert.equal(s.entryId, 'rec2');
    assert.deepEqual(changes.map((c) => c.kind), ['load', 'clear', 'clear']);
});

test('load copies the input array', () => {
    const { s } = setup();
    const src = [{ id: 'a' }];
    s.load(src, null);
    src.push({ id: 'b' });
    assert.equal(s.size, 1);
});

test('claim changes the owner without notifying', () => {
    const { s, changes } = setup();
    s.claim('rec');
    assert.equal(s.entryId, 'rec');
    assert.equal(changes.length, 0);
});

test('add, update, patch, remove swap in a new array and report ids', () => {
    const { s, changes } = setup();
    s.add([{ id: 'a' }, { id: 'b' }]);
    const before = s.labels;
    assert.deepEqual(s.update(['b', 'zz'], (l) => ({ ...l, name: 'x' })).map((l) => l.id), ['b']);
    assert.notEqual(s.labels, before);
    assert.equal(before[1].name, undefined, 'old array untouched');
    assert.equal(s.patch('a', { name: 'y' })?.name, 'y');
    assert.equal(s.patch('nope', { name: 'y' }), undefined);
    assert.deepEqual(s.remove('a').map((l) => l.id), ['a']);
    assert.deepEqual(s.remove((l) => l.name === 'x').map((l) => l.id), ['b']);
    assert.deepEqual(changes, [
        { kind: 'add', ids: ['a', 'b'] },
        { kind: 'update', ids: ['b'] },
        { kind: 'update', ids: ['a'] },
        { kind: 'remove', ids: ['a'] },
        { kind: 'remove', ids: ['b'] },
    ]);
});

test('no-op changes do not notify', () => {
    const { s, changes } = setup();
    s.add([]);
    s.remove('x');
    s.update('x', (l) => l);
    assert.equal(changes.length, 0);
});

test('frozen arrays reject in-place changes', () => {
    const { s } = setup(true);
    s.add({ id: 'a' });
    assert.throws(() => { (s.labels as L[]).push({ id: 'b' }); }, TypeError);
    const { s: loose } = setup(false);
    loose.add({ id: 'a' });
    assert.doesNotThrow(() => { (loose.labels as L[]).push({ id: 'b' }); });
});

test('changed() notifies touch; a failing listener does not stop the others; unsubscribe works', () => {
    const s = new LabelStore<L>();
    const seen: string[] = [];
    const orig = console.error; console.error = () => {};
    try {
        s.subscribe(() => { throw new Error('boom'); });
        const off = s.subscribe((c) => seen.push(c.kind));
        s.changed();
        off();
        s.changed();
    } finally { console.error = orig; }
    assert.deepEqual(seen, ['touch']);
});

test('meta travels with the change', () => {
    const { s, changes } = setup();
    s.add({ id: 'a' }, { views: ['list'] });
    s.patch('a', { name: 'n' }, { views: [] });
    s.changed({ views: ['player'] });
    s.remove('a');
    assert.deepEqual(changes.map((c) => c.views), [['list'], [], ['player'], undefined]);
});

test('update returns labels in the order of the ids asked for', () => {
    const { s } = setup();
    s.add([{ id: 'a' }, { id: 'b' }]);
    assert.deepEqual(s.update(['b', 'a', 'b'], (l) => ({ ...l, name: 'x' })).map((l) => l.id), ['b', 'a']);
});
