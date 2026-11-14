// ═══════════════════════════════════════════════════════════════════════
// app/lite-handoff.ts — hand the web app over to the SignaVis Lite desktop app
//
// The web page cannot tell whether Lite is installed. It opens a
// signavis:// link (registered by Lite, see src-tauri-lite/src/launch.rs)
// and watches whether the browser loses focus — the OS hands the link to
// the app — within a short time. Opt-in auto-redirect remembers the choice
// per browser; "stay in browser" holds for the tab (sessionStorage).
// ═══════════════════════════════════════════════════════════════════════

import { toXcId } from '../domain/xc/xcId.ts';

export const LITE_SCHEME = 'signavis';
export const LITE_DOWNLOAD_URL = 'https://github.com/LimitlessGreen/SignaVis/releases/latest';
const AUTO_OPEN_KEY = 'signavis.lite.auto-open.v1';
const STAY_KEY = 'signavis.lite.stay-in-browser';
/** Query parameter that keeps a link in the browser (no auto-redirect). */
export const STAY_PARAM = 'browser';

/** signavis://open?xc=XC123&lang=de — the only actions Lite accepts from links. */
export function buildLiteLink({ xc, lang }: { xc?: string | number | null; lang?: string | null } = {}): string {
    const params = new URLSearchParams();
    const id = toXcId(xc ?? null);
    if (id) params.set('xc', id);
    if (lang) params.set('lang', lang);
    const q = params.toString();
    return `${LITE_SCHEME}://open${q ? `?${q}` : ''}`;
}

/** The recording/language a page URL points at (?xc= / ?xcid=, ?lang=). */
export function linkTargetFromSearch(search: string): { xc: string | null; lang: string | null } {
    const p = new URLSearchParams(search || '');
    const raw = p.get('xcid') || p.get('XCID') || p.get('xc') || p.get('XC');
    return { xc: toXcId(raw), lang: p.get('lang') || p.get('LANG') };
}

/** Lite exists for Windows, macOS and Linux desktops — not phones/tablets, not inside Lite. */
export function isHandoffAvailable(userAgent: string, inTauri: boolean): boolean {
    if (inTauri) return false;
    if (/Android|iPhone|iPad|iPod|Mobile|CrOS/i.test(userAgent)) return false;
    return /Windows|Macintosh|Linux|X11/i.test(userAgent);
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null | undefined;
const safe = <T>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };

export const getAutoOpen = (ls: Store) => safe(() => ls?.getItem(AUTO_OPEN_KEY) === '1', false);
export const setAutoOpen = (ls: Store, on: boolean) => safe(() => { on ? ls?.setItem(AUTO_OPEN_KEY, '1') : ls?.removeItem(AUTO_OPEN_KEY); }, undefined);
export const getStayInBrowser = (ss: Store) => safe(() => ss?.getItem(STAY_KEY) === '1', false);
export const setStayInBrowser = (ss: Store) => safe(() => { ss?.setItem(STAY_KEY, '1'); }, undefined);

/** Auto-redirect on page load: opted in, not declined in this tab, not ?browser=1. */
export function shouldAutoRedirect({ autoOpen, stay, search }: { autoOpen: boolean; stay: boolean; search: string }): boolean {
    if (!autoOpen || stay) return false;
    return !new URLSearchParams(search || '').has(STAY_PARAM);
}

/**
 * Open `link` and report whether something took it: the window blurs or the
 * page gets hidden within `timeoutMs`. That is the app, or the browser's own
 * "open this app?" prompt — a page cannot tell them apart; `false` reliably
 * means nothing reacted (Lite not installed). Top-level navigation (Chrome blocks
 * external protocols from iframes without a user gesture); a registered
 * scheme leaves the page as it is.
 */
export function openLiteLink(link: string, { timeoutMs = 2000, win = window as Window, doc = document } = {}): Promise<boolean> {
    return new Promise((resolve) => {
        let done = false;
        const finish = (opened: boolean) => {
            if (done) return;
            done = true;
            win.removeEventListener('blur', onLeave);
            doc.removeEventListener('visibilitychange', onVisibility);
            clearTimeout(timer);
            resolve(opened);
        };
        const onLeave = () => finish(true);
        const onVisibility = () => { if (doc.visibilityState === 'hidden') finish(true); };
        win.addEventListener('blur', onLeave);
        doc.addEventListener('visibilitychange', onVisibility);
        const timer = setTimeout(() => finish(false), timeoutMs);
        win.location.href = link;
    });
}
