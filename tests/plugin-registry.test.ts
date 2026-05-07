import test from 'node:test';
import assert from 'node:assert/strict';

import { PluginRegistry } from '../src/app/PluginRegistry.ts';
import type { Plugin, PluginManifest } from '../src/domain/plugin/types.ts';
import type { IPluginHost } from '../src/domain/plugin/IPluginHost.ts';

// ── Stub host ────────────────────────────────────────────────────────

function makeHost(): IPluginHost {
    return {
        registerAnalysisBackend: () => () => {},
        registerExporter:        () => () => {},
        registerImporter:        () => () => {},
        getProject:              () => null,
        on:                      () => () => {},
    };
}

// ── Stub plugin ──────────────────────────────────────────────────────

function makePlugin(overrides: Partial<PluginManifest> = {}, hooks: { activate?: () => void; deactivate?: () => void } = {}): Plugin {
    return {
        manifest: {
            id:           overrides.id ?? 'test.plugin',
            name:         overrides.name ?? 'Test Plugin',
            version:      overrides.version ?? '1.0.0',
            capabilities: overrides.capabilities ?? [],
        },
        async activate()   { hooks.activate?.(); },
        async deactivate() { hooks.deactivate?.(); },
    };
}

// ── Tests ────────────────────────────────────────────────────────────

test('PluginRegistry: register adds plugin with inactive status', () => {
    const registry = new PluginRegistry(makeHost());
    registry.register(makePlugin({ id: 'p1' }));
    const entry = registry.list().find((e) => e.manifest.id === 'p1');
    assert.ok(entry, 'plugin should be listed');
    assert.equal(entry.status, 'inactive');
});

test('PluginRegistry: register throws on duplicate id', () => {
    const registry = new PluginRegistry(makeHost());
    registry.register(makePlugin({ id: 'dup' }));
    assert.throws(() => registry.register(makePlugin({ id: 'dup' })), /already registered/i);
});

test('PluginRegistry: activate calls plugin.activate and transitions to active', async () => {
    let activated = false;
    const registry = new PluginRegistry(makeHost());
    registry.register(makePlugin({ id: 'p2' }, { activate: () => { activated = true; } }));

    await registry.activate('p2');

    assert.ok(activated, 'activate hook should be called');
    assert.equal(registry.getStatus('p2'), 'active');
});

test('PluginRegistry: activate is no-op when already active', async () => {
    let callCount = 0;
    const registry = new PluginRegistry(makeHost());
    registry.register(makePlugin({ id: 'p3' }, { activate: () => { callCount++; } }));

    await registry.activate('p3');
    await registry.activate('p3');

    assert.equal(callCount, 1, 'activate should only be called once');
});

test('PluginRegistry: activate throws for unknown plugin', async () => {
    const registry = new PluginRegistry(makeHost());
    await assert.rejects(() => registry.activate('ghost'), /not registered/i);
});

test('PluginRegistry: unregister calls deactivate and removes from list', async () => {
    let deactivated = false;
    const registry = new PluginRegistry(makeHost());
    registry.register(makePlugin({ id: 'p4' }, { deactivate: () => { deactivated = true; } }));
    await registry.activate('p4');
    await registry.unregister('p4');

    assert.ok(deactivated, 'deactivate hook should be called');
    assert.equal(registry.getStatus('p4'), null, 'plugin should be removed');
    assert.equal(registry.list().length, 0);
});

test('PluginRegistry: unregister is no-op for unknown id', async () => {
    const registry = new PluginRegistry(makeHost());
    await assert.doesNotReject(() => registry.unregister('nobody'));
});

test('PluginRegistry: activation failure sets error status', async () => {
    const registry = new PluginRegistry(makeHost());
    registry.register(makePlugin({ id: 'bad' }, {
        activate: () => { throw new Error('activation failed'); },
    }));

    await assert.rejects(() => registry.activate('bad'));

    assert.equal(registry.getStatus('bad'), 'error');
    const entry = registry.list()[0];
    assert.ok(entry.error?.includes('activation failed'));
});

test('PluginRegistry: on() receives lifecycle events', async () => {
    const events: string[] = [];
    const registry = new PluginRegistry(makeHost());

    registry.on('registered',   () => events.push('registered'));
    registry.on('activating',   () => events.push('activating'));
    registry.on('activated',    () => events.push('activated'));
    registry.on('unregistered', () => events.push('unregistered'));

    registry.register(makePlugin({ id: 'ev' }));
    await registry.activate('ev');
    await registry.unregister('ev');

    assert.deepEqual(events, ['registered', 'activating', 'activated', 'unregistered']);
});
