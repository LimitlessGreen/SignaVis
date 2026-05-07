// ═══════════════════════════════════════════════════════════════════════
// app/PluginRegistry.ts — Runtime plugin registry
//
// Manages the full lifecycle of plugins:
//   register → activate → deactivate → unregister
//
// The registry is deliberately framework-agnostic: it does not touch the
// DOM and has no direct dependency on PlayerState. The host bridge is
// injected at construction time.
// ═══════════════════════════════════════════════════════════════════════

import type { Plugin, PluginEntry, PluginStatus } from '../domain/plugin/types.ts';
import type { IPluginHost } from '../domain/plugin/IPluginHost.ts';

export class PluginRegistry {
    readonly #host: IPluginHost;
    readonly #plugins: Map<string, { plugin: Plugin; status: PluginStatus; error?: string }> = new Map();
    readonly #listeners: Map<string, Set<() => void>> = new Map();

    constructor(host: IPluginHost) {
        this.#host = host;
    }

    // ── Registration ───────────────────────────────────────────────

    /**
     * Add a plugin to the registry without activating it.
     * Throws if a plugin with the same id is already registered.
     */
    register(plugin: Plugin): void {
        const id = plugin.manifest.id;
        if (this.#plugins.has(id)) {
            throw new Error(`PluginRegistry: plugin "${id}" is already registered`);
        }
        this.#plugins.set(id, { plugin, status: 'inactive' });
        this.#emit('registered', id);
    }

    /**
     * Activate a registered plugin.
     * Safe to call when already active (no-op).
     */
    async activate(id: string): Promise<void> {
        const entry = this.#plugins.get(id);
        if (!entry) throw new Error(`PluginRegistry: plugin "${id}" is not registered`);
        if (entry.status === 'active') return;

        entry.status = 'activating';
        this.#emit('activating', id);
        try {
            await entry.plugin.activate({ host: this.#host });
            entry.status = 'active';
            entry.error = undefined;
            this.#emit('activated', id);
        } catch (err) {
            entry.status = 'error';
            entry.error = err instanceof Error ? err.message : String(err);
            this.#emit('error', id);
            throw err;
        }
    }

    /**
     * Deactivate a plugin (calls its cleanup hook) and remove it.
     * Safe to call for unknown ids (no-op).
     */
    async unregister(id: string): Promise<void> {
        const entry = this.#plugins.get(id);
        if (!entry) return;

        if (entry.status === 'active') {
            try {
                await entry.plugin.deactivate();
            } catch {
                // best-effort cleanup — log but continue
            }
        }

        this.#plugins.delete(id);
        this.#emit('unregistered', id);
    }

    // ── Queries ────────────────────────────────────────────────────

    list(): PluginEntry[] {
        return Array.from(this.#plugins.values()).map(({ plugin, status, error }) => ({
            manifest: plugin.manifest,
            status,
            ...(error !== undefined ? { error } : {}),
        }));
    }

    getStatus(id: string): PluginStatus | null {
        return this.#plugins.get(id)?.status ?? null;
    }

    // ── Events ─────────────────────────────────────────────────────

    /**
     * Subscribe to registry lifecycle events.
     * Events: 'registered' | 'activating' | 'activated' | 'unregistered' | 'error'
     * Returns an unsubscribe function.
     */
    on(event: string, handler: () => void): () => void {
        if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
        this.#listeners.get(event)!.add(handler);
        return () => this.#listeners.get(event)?.delete(handler);
    }

    #emit(event: string, _id: string): void {
        this.#listeners.get(event)?.forEach((h) => h());
    }
}
