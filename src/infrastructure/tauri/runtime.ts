// ═══════════════════════════════════════════════════════════════════════
// infrastructure/tauri/runtime.ts — which shell is the frontend running in?
//
//   • browser       — static hosting / dev server
//   • lite          — SignaVis Lite (src-tauri-lite): Tauri, but none of the
//                     full desktop's Rust commands (project store, gRPC, DSP …)
//   • full desktop  — src-tauri with its command set
//
// The Lite shell marks its webview with `window.__SIGNAVIS_LITE__` through an
// initialization script, before any page script runs.
// ═══════════════════════════════════════════════════════════════════════

type Globals = Record<string, unknown>;

/** True inside any Tauri webview (Lite or full desktop). */
export function isTauri(): boolean {
    return typeof (globalThis as Globals).__TAURI_INTERNALS__ !== 'undefined';
}

/** True inside the SignaVis Lite shell. */
export function isLite(): boolean {
    return isTauri() && typeof (globalThis as Globals).__SIGNAVIS_LITE__ !== 'undefined';
}

/** True inside the full desktop shell, i.e. its Rust commands are available. */
export function isFullDesktop(): boolean {
    return isTauri() && !isLite();
}

/**
 * URL of a third-party library: the copy bundled under `/vendor/` in SignaVis
 * Lite (offline, CSP-clean — see demo/vite.lite.config.js), else the CDN URL.
 * Returns an absolute URL so it also works from blob workers.
 */
export function vendorUrl(path: string, cdnUrl: string): string {
    if (!isLite()) return cdnUrl;
    return new URL(`/vendor/${path}`, globalThis.location.href).href;
}
