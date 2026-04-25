// ═══════════════════════════════════════════════════════════════════════
// EventBus.ts — Typed pub/sub wrapper around EventTarget
//
// Replaces the raw `EventTarget` used in BirdNETPlayer so that:
//   • emit() is explicit instead of `dispatchEvent(new CustomEvent(...))`
//   • on() returns an unsubscribe fn (no need to hold handler reference)
//   • The event map can be narrowed with a generic type parameter
// ═══════════════════════════════════════════════════════════════════════

export type EventHandler<T = unknown> = (detail: T) => void;

export class EventBus<TMap extends Record<string, unknown> = Record<string, unknown>> {
    private readonly _target = new EventTarget();

    emit<K extends keyof TMap & string>(event: K, detail: TMap[K]): void;
    emit(event: string, detail?: unknown): void;
    emit(event: string, detail?: unknown): void {
        this._target.dispatchEvent(new CustomEvent(event, { detail }));
    }

    on(event: string, handler: EventHandler<unknown>, options?: AddEventListenerOptions): () => void {
        const listener = (e: Event) => handler((e as CustomEvent).detail);
        this._target.addEventListener(event, listener, options);
        return () => this._target.removeEventListener(event, listener, options);
    }

    off(event: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions): void {
        this._target.removeEventListener(event, listener, options);
    }

    /** Forward all events from an EventTarget's single event type onto this bus. */
    forward(source: EventTarget, event: string, as = event): void {
        source.addEventListener(event, (e: Event) =>
            this.emit(as, (e as CustomEvent).detail),
        );
    }
}
