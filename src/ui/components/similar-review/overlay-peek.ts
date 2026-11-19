// overlay-peek.ts — keep floating bars over the spectrogram from hiding what is under them.
//
// 1. Near: when the pointer comes within NEAR_PX of a bar it fades out and lets clicks / drags through
//    to the spectrogram. The grip (⋮⋮) at its left edge stays visible: pointing at it brings the bar
//    back until the pointer leaves the bar (plus margin). While a mouse button is held (drawing,
//    moving a box) bars stay faded.
// 2. Hold H: all bars and the label captions fade out; let go to bring them back.

export const NEAR_PX = 28;

interface Box { left: number; top: number; right: number; bottom: number }

/** Distance from (x, y) to the box; 0 inside. */
export function distToBox(r: Box, x: number, y: number): number {
    const dx = Math.max(r.left - x, 0, x - r.right);
    const dy = Math.max(r.top - y, 0, y - r.bottom);
    return Math.hypot(dx, dy);
}

/** Next state of one bar for a pointer position: faded or not, engaged (opened via the grip) or not. */
export function peekState(
    s: { engaged: boolean }, bar: Box, grip: Box | null, x: number, y: number, buttons: number,
): { faded: boolean; engaged: boolean } {
    if (buttons) return { faded: true, engaged: false };
    const onGrip = !!grip && distToBox(grip, x, y) === 0;
    const d = distToBox(bar, x, y);
    const engaged = onGrip || (s.engaged && d <= NEAR_PX);
    return { faded: !engaged && d <= NEAR_PX, engaged };
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

/** Make `el` fade near the pointer and with H; adds a grip as its first child. Returns detach. */
export function attachPeek(el: HTMLElement): () => void {
    el.classList.add('aw-peek');
    const grip = document.createElement('span');
    grip.className = 'aw-peek__grip';
    grip.title = 'Show bar (it fades when the pointer comes near; hold H to hide all overlays)';
    grip.setAttribute('aria-hidden', 'true');
    grip.textContent = '⋮⋮';
    el.prepend(grip);
    let state = { engaged: false };
    const entry = {
        update(e: PointerEvent) {
            if (el.hidden) return;
            const next = peekState(state, el.getBoundingClientRect(), grip.getBoundingClientRect(), e.clientX, e.clientY, e.buttons);
            state = next;
            el.classList.toggle('aw-peek--faded', next.faded);
        },
    };
    if (!bars.size) {
        window.addEventListener('pointermove', onPointer, true);
        window.addEventListener('pointerdown', onPointer, true);
        window.addEventListener('pointerup', onPointer, true);
        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('keyup', onKeyUp, true);
        window.addEventListener('blur', onBlur);
    }
    bars.add(entry);
    return () => {
        bars.delete(entry);
        grip.remove();
        el.classList.remove('aw-peek', 'aw-peek--faded');
        if (!bars.size) {
            window.removeEventListener('pointermove', onPointer, true);
            window.removeEventListener('pointerdown', onPointer, true);
            window.removeEventListener('pointerup', onPointer, true);
            window.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('keyup', onKeyUp, true);
            window.removeEventListener('blur', onBlur);
            document.body.classList.remove(HIDE_CLASS);
        }
    };
}
