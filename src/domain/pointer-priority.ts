// pointer-priority.ts — who gets a press on the spectrogram: the player, a label, or the active tool.
//
// The label layers listen in the capture phase on the spectrogram wrapper, so they see every
// press first. This module is the one place that decides what such a press does; the layer only
// executes the returned action. Order of precedence:
//
//   1. player   (playhead)                         → left/middle always the player; right-click
//                                                    still reaches the tool (exit stamp, zoom back)
//   2. tool     (zoom box, snap, stamp)            → the tool, with the label exceptions below
//   3. label    (a label region, its buttons)      → the label's own handlers
//   4. canvas   (free spectrogram)                 → draw (draw mode or Shift), else the player (seek/pan)

const PLAYER_SELECTOR = '.playhead';
const LABEL_SELECTOR = '.spectrogram-label-region';

/** True when a press on `target` belongs to the player, not to the active label tool. */
export function isPlayerTarget(target: EventTarget | null): boolean {
    const el = target as Element | null;
    return !!el?.closest?.(PLAYER_SELECTOR);
}

export type PressHit = 'player' | 'label' | 'label-button' | 'locked-label' | 'locked-label-button' | 'canvas';

/** What is under the pointer. `isLocked(id)`: detections shown read-only (BirdBox / BirdNET boxes). */
export function classifyHit(target: EventTarget | null, isLocked: (id: string) => boolean): PressHit {
    if (isPlayerTarget(target)) return 'player';
    const el = target as Element | null;
    const region = el?.closest?.(LABEL_SELECTOR) as HTMLElement | null | undefined;
    if (!region) return 'canvas';
    const onButton = !!el?.closest?.('button');
    if (isLocked(region.dataset?.id || '')) return onButton ? 'locked-label-button' : 'locked-label';
    return onButton ? 'label-button' : 'label';
}

export type Tool = 'zoom-box' | 'snap' | 'stamp' | 'draw' | 'none';

export interface PressInput {
    hit: PressHit;
    button: number;          // PointerEvent.button: 0 left, 1 middle, 2 right
    shift: boolean;
    tool: Tool;              // the active tool mode (one at a time; 'draw' = draw mode on)
    hasAudio: boolean;
    readOnly: boolean;
    /** The player is already dragging / panning / resizing (interactionState): no label tool starts. */
    playerBusy?: boolean;
}

export type PressAction =
    | 'pass'                 // not ours: let the label / player handlers have it
    | 'zoom-box-start'
    | 'zoom-box-back'
    | 'snap'                 // run or commit the snap preview
    | 'snap-through-locked'  // snap on a detection box: also swallow the box's click
    | 'stamp-place'
    | 'stamp-exit'
    | 'draw-start';

/** The one decision for a press on the spectrogram. Pure: unit-tested in pointer-priority.test.mjs. */
export function resolvePress(p: PressInput): PressAction {
    if (p.playerBusy) return 'pass';
    if (p.hit === 'player' && p.button !== 2) return 'pass';

    if (p.tool === 'zoom-box' && (p.button === 0 || p.button === 2)) {
        if (!p.hasAudio) return 'pass';
        return p.button === 2 ? 'zoom-box-back' : 'zoom-box-start';
    }

    if (p.tool === 'snap' && p.button === 0) {
        // Own labels and every label button keep their clicks; detection boxes let the snap through
        if (p.hit === 'label' || p.hit === 'label-button' || p.hit === 'locked-label-button') return 'pass';
        if (!p.hasAudio) return 'pass';
        return p.hit === 'locked-label' ? 'snap-through-locked' : 'snap';
    }

    if (p.tool === 'stamp') {
        if (p.button === 2) return 'stamp-exit';
        if (p.button === 0) return p.hasAudio ? 'stamp-place' : 'pass';
    }

    if (p.hit !== 'canvas') return 'pass';   // player (right-click), labels
    if (p.button !== 0 || p.readOnly || !p.hasAudio) return 'pass';
    if (p.tool === 'draw' || p.shift) return 'draw-start';
    return 'pass';
}
