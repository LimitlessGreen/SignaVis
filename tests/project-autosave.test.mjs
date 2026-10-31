import test from 'node:test';
import assert from 'node:assert/strict';

import { ProjectAutosaver, acquireTabLock } from '../src/app/project-autosave.ts';
import { MemoryProjectStore } from '../src/infrastructure/project/MemoryProjectStore.ts';
import { serializeProject } from '../src/domain/project/workspaceProject.ts';

function fakeTimers() {
    const timers = new Map();
    let n = 0;
    return {
        setTimer: (fn) => { const id = ++n; timers.set(id, fn); return id; },
        clearTimer: (id) => timers.delete(id),
        fire: () => { const fns = [...timers.values()]; timers.clear(); fns.forEach((f) => f()); },
        get count() { return timers.size; },
    };
}

function setup(storeOverride) {
    const store = storeOverride ?? new MemoryProjectStore();
    let version = 0;
    const statuses = [];
    const timers = fakeTimers();
    const saver = new ProjectAutosaver({
        store,
        build: () => serializeProject({ entries: [], activeId: null, labelSets: new Map(), ownSetId: null, activeSetId: null,
            settings: { version: ++version } }, { id: 'p', name: 'n' }),
        onStatus: (s) => statuses.push(s),
        setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    });
    return { store, saver, statuses, timers };
}

test('schedule debounces into a single save', async () => {
    const { store, saver, timers, statuses } = setup();
    saver.schedule(); saver.schedule(); saver.schedule();
    assert.equal(timers.count, 1);
    timers.fire();
    await saver.flush();
    const p = await store.loadProject();
    assert.equal(p.settings.version, 1);
    assert.deepEqual(statuses.filter((s) => s !== 'pending'), ['saving', 'saved']);
});

test('flush without changes does nothing; force saves', async () => {
    const { store, saver } = setup();
    await saver.flush();
    assert.equal(await store.loadProject(), null);
    await saver.flush({ force: true });
    assert.ok(await store.loadProject());
});

test('failed save keeps changes dirty and reports error', async () => {
    const mem = new MemoryProjectStore();
    let fail = true;
    const store = Object.assign(Object.create(mem), {
        saveProject: async (p) => { if (fail) throw new Error('disk'); return mem.saveProject(p); },
        loadProject: () => mem.loadProject(),
    });
    const { saver, statuses } = setup(store);
    saver.schedule();
    await saver.flush();
    assert.equal(statuses.at(-1), 'error');
    assert.equal(saver.hasUnsavedChanges, true);
    fail = false;
    await saver.flush();
    assert.equal(statuses.at(-1), 'saved');
    assert.ok(await mem.loadProject());
});

test('read-only saver never writes', async () => {
    const { store, saver, timers } = setup();
    saver.setReadOnly(true);
    saver.schedule();
    assert.equal(timers.count, 0);
    await saver.flush({ force: true });
    assert.equal(await store.loadProject(), null);
});

test('acquireTabLock: owner, second tab, no Locks API', async () => {
    const held = new Set();
    const locks = {
        request: (name, opts, cb) => {
            if (held.has(name)) return Promise.resolve(cb(null));
            held.add(name);
            return Promise.resolve(cb({ name }));
        },
    };
    assert.equal(await acquireTabLock('a', locks), true);
    assert.equal(await acquireTabLock('a', locks), false);
    assert.equal(await acquireTabLock('a', null), true);
});
