export class GestureRecognizer {
    constructor(element: any);
    element: any;
    handlers: Map<any, any>;
    cleanups: any[];
    lastTapTime: number;
    lastTapX: number;
    lastTapY: number;
    touchMode: string | null;
    swipeStartX: number;
    swipeStartY: number;
    swipeLastX: number;
    swipeLastY: number;
    lastPinchDistance: number;
    lastPinchCenter: {
        x: number;
        y: number;
    } | null;
    on(event: any, callback: any): () => void;
    off(event: any, callback: any): void;
    emit(event: any, detail: any): void;
    dispose(): void;
    _bind(): void;
    _onTouchStart(e: any): void;
    _onTouchMove(e: any): void;
    _onTouchEnd(e: any): void;
    _reset(): void;
}
