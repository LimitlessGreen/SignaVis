// keymap.ts — the one place that decides which shortcut gets a key press.
//
// Components register handlers in a scope instead of adding their own document/window keydown
// listeners. A single listener on `document` (bubble phase) runs them in a fixed order:
//
//   0. skipped entirely  — the key was already handled (defaultPrevented: label editor, context
//                          menu, grab mode, a widget with its own keys), the focused element
//                          needs the key (text entry; arrows on a select or slider), the target
//                          sits in [data-aw-own-keys], Enter on a focused button / link (the
//                          control's own action), or a modal dialog is open. Space on a focused
//                          button goes to the shortcuts: after clicking a toolbar button, Space
//                          plays instead of pressing that button again.
//   1. 'review'          — similar-calls / call-group bars while open
//   2. 'label'           — the focused / selected label (delete, copy, grab, taxonomy keys)
//   3. 'player'          — transport (Space, arrows, J/L, Home/End)
//   4. 'app'             — app-wide (next recording, BirdNET, sound type keys …)
//
// A handler claims the key by calling e.preventDefault(); later handlers then don't run.
// Within a scope, handlers run in registration order.

import { isTypingContext } from './utils.ts';

export type KeyScope = 'review' | 'label' | 'player' | 'app';
export const SCOPE_ORDER: readonly KeyScope[] = ['review', 'label', 'player', 'app'];

export interface KeyHandler {
    scope: KeyScope;
    /** Handle the key; call e.preventDefault() to claim it. */
    run: (e: KeyboardEvent) => void;
    /** Optional label for debugging / the help overview. */
    name?: string;
}

/** Why a key press bypasses all shortcuts, or null when the shortcuts may have it. */
export function skipReason(
    e: Pick<KeyboardEvent, 'target' | 'key' | 'defaultPrevented'>,
    modalOpen: () => boolean,
): 'handled' | 'typing' | 'own-keys' | 'control' | 'modal' | null {
    if (e.defaultPrevented) return 'handled';
    if (isTypingContext(e.target, e.key)) return 'typing';
    const el = e.target as Element | null;
    if (el?.closest?.('[data-aw-own-keys]')) return 'own-keys';
    if (e.key === 'Enter' && el?.closest?.('button, a[href], summary')) return 'control';
    if (modalOpen()) return 'modal';
    return null;
}

/** Run handlers in scope order until one claims the key. Returns the claiming handler. */
export function dispatchKey(e: KeyboardEvent, handlers: readonly KeyHandler[]): KeyHandler | null {
    for (const scope of SCOPE_ORDER) {
        for (const h of handlers) {
            if (h.scope !== scope) continue;
            h.run(e);
            if (e.defaultPrevented) return h;
        }
    }
    return null;
}

/** A visible modal dialog (closed app modals stay in the DOM hidden; review bars are not modal). */
function isModalOpen(): boolean {
    for (const m of document.querySelectorAll('[aria-modal="true"], dialog[open]')) {
        const visible = (m as any).checkVisibility ? (m as any).checkVisibility() : (m as HTMLElement).offsetParent !== null;
        if (visible) return true;
    }
    return false;
}

const handlers: KeyHandler[] = [];

function onKeyDown(e: KeyboardEvent) {
    if (skipReason(e, isModalOpen)) return;
    dispatchKey(e, handlers);
}

/** Register a shortcut handler; returns the unregister function. */
export function registerKeys(h: KeyHandler): () => void {
    if (!handlers.length) document.addEventListener('keydown', onKeyDown);
    handlers.push(h);
    return () => {
        const i = handlers.indexOf(h);
        if (i >= 0) handlers.splice(i, 1);
        if (!handlers.length) document.removeEventListener('keydown', onKeyDown);
    };
}

type KeyListener = (e: KeyboardEvent) => void;
export interface KeyScopeTarget {
    addEventListener(type: 'keydown', fn: KeyListener): void;
    removeEventListener(type: 'keydown', fn: KeyListener): void;
}
const scopeTargets = new Map<KeyScope, KeyScopeTarget>();

/**
 * An EventTarget-like handle for a scope, so existing code can swap `document` for it:
 * `on(keyScope('player'), 'keydown', fn)` registers fn in the keymap, removeEventListener drops it.
 */
export function keyScope(scope: KeyScope): KeyScopeTarget {
    let t = scopeTargets.get(scope);
    if (!t) {
        const offs = new Map<KeyListener, () => void>();
        t = {
            addEventListener(_type, fn) {
                if (offs.has(fn)) return;
                offs.set(fn, registerKeys({ scope, run: fn }));
            },
            removeEventListener(_type, fn) {
                offs.get(fn)?.();
                offs.delete(fn);
            },
        };
        scopeTargets.set(scope, t);
    }
    return t;
}
