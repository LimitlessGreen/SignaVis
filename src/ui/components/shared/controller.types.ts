/**
 * Shared types for UI event controllers.
 *
 * OnFn mirrors the pattern used throughout PlayerState._bindEvents():
 * registers an event listener AND pushes the corresponding removeEventListener
 * into a shared cleanups array, so disposal is automatic.
 */
export type OnFn = (
    target: any,
    type: string,
    fn: any,
    opts?: AddEventListenerOptions | boolean
) => void;
