// ═══════════════════════════════════════════════════════════════════════
// gestures.ts — Lightweight touch gesture recognizer
// ═══════════════════════════════════════════════════════════════════════

function distance(a: Touch, b: Touch): number {
    const dx = a.clientX - b.clientX;
    const dy = a.clientY - b.clientY;
    return Math.hypot(dx, dy);
}

function midpoint(a: Touch, b: Touch): { x: number; y: number } {
    return {
        x: (a.clientX + b.clientX) * 0.5,
        y: (a.clientY + b.clientY) * 0.5,
    };
}

export class GestureRecognizer {
    element: HTMLElement;
    handlers: Map<string, Array<(detail?: any) => void>>;
    cleanups: Array<() => void>;
    lastTapTime: number;
    lastTapX: number;
    lastTapY: number;
    touchMode: 'swipe' | 'pinch' | null;
    swipeStartX: number;
    swipeStartY: number;
    swipeLastX: number;
    swipeLastY: number;
    lastPinchDistance: number;
    lastPinchCenter: { x: number; y: number } | null;
    constructor(element: HTMLElement) {
        this.element = element;
        this.handlers = new Map();
        this.cleanups = [];

        this.lastTapTime = 0;
        this.lastTapX = 0;
        this.lastTapY = 0;

        this.touchMode = null; // 'swipe' | 'pinch'
        this.swipeStartX = 0;
        this.swipeStartY = 0;
        this.swipeLastX = 0;
        this.swipeLastY = 0;

        this.lastPinchDistance = 0;
        this.lastPinchCenter = null;

        this._bind();
    }

    on(event: string, callback: (detail?: any) => void) {
        const arr = this.handlers.get(event) || [];
        arr.push(callback);
        this.handlers.set(event, arr);
        return () => this.off(event, callback);
    }

    off(event: string, callback: (detail?: any) => void) {
        const arr = this.handlers.get(event);
        if (!arr) return;
        this.handlers.set(event, arr.filter((cb) => cb !== callback));
    }

    emit(event: string, detail?: any) {
        const arr = this.handlers.get(event);
        if (!arr) return;
        for (const cb of arr) cb(detail);
    }

    dispose() {
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups.length = 0;
        this.handlers.clear();
    }

    _bind() {
        const on = (name: string, fn: (e: Event) => void, options: AddEventListenerOptions = { passive: false }) => {
            this.element.addEventListener(name, fn as EventListener, options);
            this.cleanups.push(() => this.element.removeEventListener(name, fn as EventListener, options));
        };

        on('touchstart', (e: Event) => this._onTouchStart(e as TouchEvent));
        on('touchmove', (e: Event) => this._onTouchMove(e as TouchEvent));
        on('touchend', (e: Event) => this._onTouchEnd(e as TouchEvent));
        on('touchcancel', () => this._reset());
    }

    _onTouchStart(e: TouchEvent) {
        if (e.touches.length === 1) {
            const t = e.touches[0] as Touch;
            this.touchMode = 'swipe';
            this.swipeStartX = t.clientX;
            this.swipeStartY = t.clientY;
            this.swipeLastX = t.clientX;
            this.swipeLastY = t.clientY;
            return;
        }

        if (e.touches.length >= 2) {
            const a = e.touches[0] as Touch;
            const b = e.touches[1] as Touch;
            this.touchMode = 'pinch';
            this.lastPinchDistance = distance(a, b);
            this.lastPinchCenter = midpoint(a, b);
            e.preventDefault();
        }
    }

    _onTouchMove(e: TouchEvent) {
        if (this.touchMode === 'pinch' && e.touches.length >= 2) {
            const a = e.touches[0] as Touch;
            const b = e.touches[1] as Touch;
            const d = Math.max(1, distance(a, b));
            const center = midpoint(a, b);
            const scale = d / Math.max(1, this.lastPinchDistance);
            this.lastPinchDistance = d;
            this.lastPinchCenter = center;
            this.emit('pinch', { scale, centerX: center.x, centerY: center.y });
            e.preventDefault();
            return;
        }

        if (this.touchMode === 'swipe' && e.touches.length === 1) {
            this.swipeLastX = (e.touches[0] as Touch).clientX;
            this.swipeLastY = (e.touches[0] as Touch).clientY;
        }
    }

    _onTouchEnd(e: TouchEvent) {
        if (this.touchMode === 'pinch') {
            if (e.touches.length < 2) this._reset();
            return;
        }

        if (this.touchMode === 'swipe' && e.touches.length === 0) {
            const dx = this.swipeLastX - this.swipeStartX;
            const dy = Math.abs(this.swipeLastY - this.swipeStartY);
            if (Math.abs(dx) > 24 && dy < 48) {
                this.emit('swipe', { dx });
            } else {
                const now = performance.now();
                const withinTime = now - this.lastTapTime < 280;
                const nearLast = Math.hypot(this.swipeStartX - this.lastTapX, this.swipeStartY - this.lastTapY) < 24;
                if (withinTime && nearLast) {
                    this.emit('doubletap', { x: this.swipeStartX, y: this.swipeStartY });
                    this.lastTapTime = 0;
                } else {
                    this.lastTapTime = now;
                    this.lastTapX = this.swipeStartX;
                    this.lastTapY = this.swipeStartY;
                }
            }
        }
        this._reset();
    }

    _reset() {
        this.touchMode = null;
        this.swipeStartX = 0;
        this.swipeStartY = 0;
        this.swipeLastX = 0;
        this.swipeLastY = 0;
        this.lastPinchDistance = 0;
        this.lastPinchCenter = null;
    }
}
