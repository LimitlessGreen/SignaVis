// undo-toast.ts — non-blocking "done · Undo" notice instead of confirm() before destructive actions

let current: { el: HTMLElement; timer: any } | null = null;

function dismiss() {
    if (!current) return;
    clearTimeout(current.timer);
    current.el.remove();
    current = null;
}

/**
 * Show a toast with an Undo button. Only one toast at a time — a new one replaces
 * (and thereby commits) the previous action.
 * `action`: an optional second button before Undo (e.g. "All 4").
 */
export function showUndoToast(message: string, onUndo: () => void,
    { timeoutMs = 8000, action = null }: { timeoutMs?: number; action?: { label: string; run: () => void } | null } = {}) {
    dismiss();
    const el = document.createElement('div');
    el.className = 'undo-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');

    const text = document.createElement('span');
    text.className = 'undo-toast__text';
    text.textContent = message;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'undo-toast__btn';
    btn.textContent = 'Undo';
    btn.addEventListener('click', () => { dismiss(); onUndo(); });

    el.append(text);
    if (action) {
        const extra = document.createElement('button');
        extra.type = 'button';
        extra.className = 'undo-toast__btn';
        extra.textContent = action.label;
        extra.addEventListener('click', () => { dismiss(); action.run(); });
        el.append(extra);
    }
    el.append(btn);
    document.body.appendChild(el);
    current = { el, timer: setTimeout(dismiss, timeoutMs) };
    return dismiss;
}
