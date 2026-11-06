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

const isExternalUrl = (href: string) => /^(https?:|mailto:)/i.test(href)
    && !href.startsWith(globalThis.location.origin);

/** Open a URL in the system browser (Lite) — never inside the app window. */
export async function openExternal(url: string): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('plugin:opener|open_url', { url });
}

/**
 * Lite: links to the web (clicks on <a href="https://…"> and window.open)
 * go to the system browser. Call once at start-up; no-op outside Lite.
 */
export function installExternalLinkHandler(): void {
    if (!isLite()) return;
    document.addEventListener('click', (e) => {
        if (e.defaultPrevented || e.button !== 0) return;
        const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
        if (!a || a.hasAttribute('download') || !isExternalUrl(a.href)) return;
        e.preventDefault();
        openExternal(a.href).catch((err) => console.warn('[lite] cannot open link', a.href, err));
    }, true);
    const nativeOpen = window.open.bind(window);
    window.open = ((url?: string | URL, target?: string, features?: string) => {
        const href = url ? String(url) : '';
        if (href && isExternalUrl(new URL(href, globalThis.location.href).href)) {
            openExternal(new URL(href, globalThis.location.href).href).catch((err) => console.warn('[lite] cannot open link', href, err));
            return null;
        }
        return nativeOpen(url, target, features);
    }) as typeof window.open;
}

/**
 * URL of large app data that Lite does not ship (species images, BirdNET
 * model): the `svdata` protocol of the Lite shell, which serves it from its
 * cache and downloads it once on a miss (src-tauri-lite/src/data_cache.rs).
 * `sitePath` is relative to the web app root, e.g. 'models/birdnet-v2.4/'.
 * Outside Lite, `browserUrl` is returned unchanged.
 */
export function onDemandUrl(sitePath: string, browserUrl: string): string {
    if (!isLite()) return browserUrl;
    // Custom protocols: http://<scheme>.localhost on Windows (WebView2), <scheme>://localhost elsewhere.
    const windows = /Windows/i.test(globalThis.navigator?.userAgent || '');
    return `${windows ? 'http://svdata.localhost' : 'svdata://localhost'}/${sitePath}`;
}

/** Base URL of the species thumbnails ('<base><Scientific name>.webp'). */
export const speciesImageBase = () => onDemandUrl('demo/data/species_images/', './data/species_images/');
