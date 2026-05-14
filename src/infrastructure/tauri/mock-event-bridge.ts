// ═══════════════════════════════════════════════════════════════════════
// infrastructure/tauri/mock-event-bridge.ts
//
// In demo/browser mode Tauri's `listen()` is unavailable.
// This module monkey-patches @tauri-apps/api/event so that:
//   - listen() works by registering handlers on a CustomEvent bus
//   - MockCorpusAdapter dispatches 'signavis:mock-event' CustomEvents
//     which this bridge forwards to the registered handlers
// ═══════════════════════════════════════════════════════════════════════

const _handlers = new Map<string, Set<(payload: unknown) => void>>();

function isBrowserMode(): boolean {
    return !(window as unknown as Record<string, unknown>).__TAURI__;
}

/** Call once at app boot to install the mock event bridge. */
export function installMockEventBridge(): void {
    if (!isBrowserMode()) return;

    // Listen for synthetic events emitted by MockCorpusAdapter
    window.addEventListener('signavis:mock-event', (e: Event) => {
        const { event, payload } = (e as CustomEvent).detail as { event: string; payload: unknown };
        const handlers = _handlers.get(event);
        if (handlers) {
            handlers.forEach((fn) => fn({ payload }));
        }
    });

    // Monkey-patch @tauri-apps/api/event
    // Vite resolves the module at build time; we override it at runtime via
    // a global shim that the dynamic `await import('@tauri-apps/api/event')`
    // calls pick up.  We use a module-level variable trick: store the shim
    // on a well-known global and intercept in the module loader.

    // Simpler approach: override globalThis so that any code that imports
    // @tauri-apps/api/event and calls listen() gets our mock.
    // We patch it by overriding the resolved module cache via a Vite trick:
    // Since Vite resolves ESM modules, we expose our mock on window and
    // patch the import.meta resolve.

    // Practical approach: just expose mock listen/emit on window
    // and let the import wrapper below use it.
    (window as unknown as Record<string, unknown>).__SIGNAVIS_MOCK_LISTEN__ = mockListen;
    (window as unknown as Record<string, unknown>).__SIGNAVIS_MOCK_EMIT__ = mockEmit;
}

function mockListen(
    event: string,
    handler: (e: { payload: unknown }) => void,
): () => void {
    if (!_handlers.has(event)) _handlers.set(event, new Set());
    _handlers.get(event)!.add(handler as (payload: unknown) => void);
    return () => _handlers.get(event)?.delete(handler as (payload: unknown) => void);
}

function mockEmit(event: string, payload: unknown): void {
    window.dispatchEvent(new CustomEvent('signavis:mock-event', { detail: { event, payload } }));
}
