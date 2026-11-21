// overlay-peek.ts — keep floating bars over the spectrogram from hiding what is under them.
//
// 1. Drag: while a press that started off the bar (drawing, moving a box, dragging the playhead) comes
//    within NEAR_PX of it, the bar fades out and lets the drag through. Plain hovering never hides it,
//    so its buttons stay usable.
// 2. Hold H (installOverlayPeekKey, app-wide): all bars and the label captions fade out; let go to bring them back.

export const NEAR_PX = 28;

interface Box { left: number; top: number; right: number; bottom: number }

/** Distance from (x, y) to the box; 0 inside. */
export function distToBox(r: Box, x: number, y: number): number {
    const dx = Math.max(r.left - x, 0, x - r.right);
    const dy = Math.max(r.top - y, 0, y - r.bottom);
    return Math.hypot(dx, dy);
}

/** Next state of one bar for a pointer event: faded or not, and whether the current press started on it. */
export function peekState(
    s: { pressOnBar: boolean }, bar: Box, x: number, y: number, buttons: number, type = 'pointermove',
): { faded: boolean; pressOnBar: boolean } {
    if (!buttons) return { faded: false, pressOnBar: false };
    const d = distToBox(bar, x, y);
    const pressOnBar = type === 'pointerdown' ? d === 0 : s.pressOnBar;
    return { faded: !pressOnBar && d <= NEAR_PX, pressOnBar };
}

const HIDE_CLASS = 'aw-overlays-peek';
const bars = new Set<{ update: (e: PointerEvent) => void }>();

function isTyping(t: EventTarget | null): boolean {
    return t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}
function onKeyDown(e: KeyboardEvent) {
    if ((e.key === 'h' || e.key === 'H') && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(e.target)) {
        document.body.classList.add(HIDE_CLASS);
        e.preventDefault();
    }
}
function onKeyUp(e: KeyboardEvent) { if (e.key === 'h' || e.key === 'H') document.body.classList.remove(HIDE_CLASS); }
function onBlur() { document.body.classList.remove(HIDE_CLASS); }
function onPointer(e: PointerEvent) { for (const b of bars) b.update(e); }

/** Make `el` fade while a drag passes near it, and with H. Returns detach. */
export function attachPeek(el: HTMLElement): () => void {
    el.classList.add('aw-peek');
    let state = { faded: false, pressOnBar: false };
    const entry = {
        update(e: PointerEvent) {
            if (el.hidden) return;
            state = peekState(state, el.getBoundingClientRect(), e.clientX, e.clientY, e.buttons, e.type);
            el.classList.toggle('aw-peek--faded', state.faded);
        },
    };
    if (!bars.size) {
        window.addEventListener('pointermove', onPointer, true);
        window.addEventListener('pointerdown', onPointer, true);
        window.addEventListener('pointerup', onPointer, true);
    }
    bars.add(entry);
    return () => {
        bars.delete(entry);
        el.classList.remove('aw-peek', 'aw-peek--faded');
        if (!bars.size) {
            window.removeEventListener('pointermove', onPointer, true);
            window.removeEventListener('pointerdown', onPointer, true);
            window.removeEventListener('pointerup', onPointer, true);
        }
    };
}

let keyInstalled = false;
/** Hold H anywhere in the app to hide the overlays (bars, label captions); once per page. */
export function installOverlayPeekKey(): void {
    if (keyInstalled) return;
    keyInstalled = true;
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
}
