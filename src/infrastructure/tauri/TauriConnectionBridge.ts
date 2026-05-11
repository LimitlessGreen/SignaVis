// ═══════════════════════════════════════════════════════════════════════
// infrastructure/tauri/TauriConnectionBridge.ts
//
// Thin TypeScript wrapper around the Rust ConnectionManager IPC commands
// and "connection://status" event.  No connection logic lives here —
// everything runs in Rust; this file is pure plumbing.
// ═══════════════════════════════════════════════════════════════════════

export type BackendMode = 'local' | 'server' | 'cloud';
export type ConnectionState = 'local' | 'connecting' | 'connected' | 'error';

export interface ConnectionConfig {
    mode: BackendMode;
    endpoint: string;
}

export interface ConnectionStatus {
    state: ConnectionState;
    mode: BackendMode;
    endpoint: string;
    errorMessage?: string;
}

type StatusListener = (status: ConnectionStatus) => void;

const STATUS_EVENT = 'connection://status';

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
    return tauriInvoke<T>(cmd, args);
}

export class TauriConnectionBridge {
    #listeners = new Set<StatusListener>();
    #unlisten: (() => void) | null = null;

    /** Subscribe to Tauri events and call all registered listeners. */
    async start(): Promise<void> {
        const { listen } = await import('@tauri-apps/api/event');
        const unlistenFn = await listen<ConnectionStatus>(STATUS_EVENT, (event) => {
            this.#listeners.forEach((fn) => fn(event.payload));
        });
        this.#unlisten = unlistenFn;
    }

    /** Stop listening and clear all listeners. */
    dispose(): void {
        this.#unlisten?.();
        this.#unlisten = null;
        this.#listeners.clear();
    }

    /** Register a callback for every status change emitted by Rust. */
    onStatus(listener: StatusListener): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /** Read current config (mode + endpoint) from Rust. */
    getConfig(): Promise<ConnectionConfig> {
        return invoke<ConnectionConfig>('connection_get_config');
    }

    /** Read current connection status from Rust. */
    getStatus(): Promise<ConnectionStatus> {
        return invoke<ConnectionStatus>('connection_get_status');
    }

    /**
     * Apply a new config, persist it in Rust, and trigger a reconnect.
     * Returns the immediately resolved status (may still be "connecting").
     */
    setConfig(config: Partial<ConnectionConfig>): Promise<ConnectionStatus> {
        return invoke<ConnectionStatus>('connection_set_config', { config });
    }
}
