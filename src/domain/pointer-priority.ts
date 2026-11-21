// pointer-priority.ts — which pointer targets the label layers must leave to the player.
//
// The label layers listen in the capture phase on the spectrogram/waveform wrapper, so
// they see every press first. Tool modes (draw, snap, stamp, zoom box) only apply on free
// canvas: a press on the playhead always belongs to the player.

const PLAYER_SELECTOR = '.playhead';

/** True when a press on `target` belongs to the player, not to the active label tool. */
export function isPlayerTarget(target: EventTarget | null): boolean {
    const el = target as Element | null;
    return !!el?.closest?.(PLAYER_SELECTOR);
}
