// ═══════════════════════════════════════════════════════════════════════
// CarrierLineController.ts — heterodyne tuning line over the spectrogram
//
// While the heterodyne listening mode is active, a horizontal line marks the
// carrier frequency. Drag it, or Alt+click anywhere in the spectrogram, to
// retune; the new carrier applies on release (each retune re-renders audio).
// The line lives outside the horizontally scrolling canvas, so only the
// frequency mapping moves it.
// ═══════════════════════════════════════════════════════════════════════

import type { ListenMode } from '../../infrastructure/audio/detectorRender.ts';

export interface CarrierLineDeps {
    d: { canvasWrapper: HTMLElement | null };
    getCoords: () => any;
    getListenMode: () => ListenMode;
    setCarrier: (hz: number) => void;
    /** Bring the carrier into the visible frequency range. */
    reveal?: (hz: number) => void;
}

/** Carriers snap to this step, as on a detector dial. */
const CARRIER_STEP_HZ = 500;
/** Grab zone around the line, px. */
const GRAB_PX = 10;

export class CarrierLineController {
    #d: CarrierLineDeps['d'];
    #getCoords: CarrierLineDeps['getCoords'];
    #getListenMode: CarrierLineDeps['getListenMode'];
    #setCarrier: CarrierLineDeps['setCarrier'];
    #reveal: CarrierLineDeps['reveal'];
    /** Edge marker while the carrier lies outside the visible range. */
    #edge: HTMLButtonElement | null = null;
    #el: HTMLDivElement | null = null;
    #label: HTMLSpanElement | null = null;
    /** Carrier shown while dragging, before it is applied. */
    #dragHz: number | null = null;
    #lastTop = '';
    #onAltClick = (e: PointerEvent) => this.#altClick(e);

    constructor(deps: CarrierLineDeps) {
        const { d, getCoords, getListenMode, setCarrier } = deps;
        this.#d = d;
        this.#getCoords = getCoords;
        this.#getListenMode = getListenMode;
        this.#setCarrier = setCarrier;
        this.#reveal = deps.reveal;
        // Capture phase: an Alt+click must not also seek or start a label.
        d.canvasWrapper?.addEventListener('pointerdown', this.#onAltClick, true);
    }

    /** Re-place (or hide) the line for the current mode and frequency mapping. */
    update() {
        const mode = this.#getListenMode();
        const wrapper = this.#d.canvasWrapper;
        const coords = this.#getCoords();
        if (mode?.kind !== 'heterodyne' || !wrapper || !coords) {
            if (this.#el) this.#el.hidden = true;
            if (this.#edge) this.#edge.hidden = true;
            return;
        }
        const el = this.#ensureElement(wrapper);
        const hz = this.#dragHz ?? mode.carrierHz;
        const y = coords.frequencyToPixelY(hz);
        const visible = Number.isFinite(y) && y >= 0 && y <= coords.canvasHeight;
        el.hidden = !visible;
        this.#updateEdge(wrapper, coords, hz, visible ? null : (y < 0 ? 'top' : 'bottom'));
        if (!visible) return;
        const top = `${wrapper.offsetTop + y - GRAB_PX / 2}px`;
        if (top !== this.#lastTop) {
            el.style.top = top;
            this.#lastTop = top;
        }
        this.#label!.textContent = `Heterodyne ${(hz / 1000).toFixed(1)} kHz`;
    }

    dispose() {
        this.#d.canvasWrapper?.removeEventListener('pointerdown', this.#onAltClick, true);
        this.#el?.remove();
        this.#el = null;
        this.#edge?.remove();
        this.#edge = null;
    }

    #ensureElement(wrapper: HTMLElement): HTMLDivElement {
        if (this.#el) return this.#el;
        const host = wrapper.parentElement as HTMLElement;
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

        const el = document.createElement('div');
        el.className = 'carrier-line';
        el.title = 'Heterodyne tuning: drag to retune (or Alt+click in the spectrogram)';
        Object.assign(el.style, {
            position: 'absolute', left: '0', right: '0', height: `${GRAB_PX}px`,
            cursor: 'ns-resize', zIndex: '12', touchAction: 'none',
        });
        const line = document.createElement('div');
        Object.assign(line.style, {
            position: 'absolute', left: '0', right: '0', top: `${GRAB_PX / 2 - 1}px`,
            height: '2px', background: '#ffd60a', pointerEvents: 'none',
            // Dark outline so the line stands out on bright calls and on noise alike.
            boxShadow: '0 0 0 1px rgba(0,0,0,0.75), 0 0 6px rgba(255,214,10,0.6)',
        });
        const label = document.createElement('span');
        Object.assign(label.style, {
            position: 'absolute', left: '6px', bottom: `${GRAB_PX / 2 + 3}px`,
            font: '600 11px/1.2 var(--font-mono, monospace)', color: '#1a1400',
            background: '#ffd60a', padding: '1px 6px', borderRadius: '3px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.6)',
            pointerEvents: 'none', whiteSpace: 'nowrap',
        });
        el.append(line, label);
        host.appendChild(el);

        el.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            el.setPointerCapture(e.pointerId);
            this.#dragHz = this.#hzAt(e.clientY);
            this.update();
        });
        el.addEventListener('pointermove', (e) => {
            if (this.#dragHz == null) return;
            this.#dragHz = this.#hzAt(e.clientY);
            this.update();
        });
        const finish = () => {
            if (this.#dragHz == null) return;
            const hz = this.#dragHz;
            this.#dragHz = null;
            this.#setCarrier(hz);
            this.update();
        };
        el.addEventListener('pointerup', finish);
        el.addEventListener('pointercancel', finish);

        this.#el = el;
        this.#label = label;
        return el;
    }

    /** Arrow at the top / bottom edge while the carrier is outside the view; click scrolls to it. */
    #updateEdge(wrapper: HTMLElement, coords: any, hz: number, side: 'top' | 'bottom' | null) {
        if (!side) { if (this.#edge) this.#edge.hidden = true; return; }
        if (!this.#edge) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'carrier-edge';
            Object.assign(b.style, {
                position: 'absolute', left: '6px', zIndex: '12', cursor: 'pointer',
                font: '600 11px/1.2 var(--font-mono, monospace)', color: '#1a1400',
                background: '#ffd60a', border: '0', padding: '2px 7px', borderRadius: '3px',
                boxShadow: '0 1px 3px rgba(0,0,0,0.6)',
            });
            b.addEventListener('pointerdown', (e) => e.stopPropagation());
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                const m = this.#getListenMode();
                if (m?.kind === 'heterodyne') this.#reveal?.(m.carrierHz);
            });
            (wrapper.parentElement as HTMLElement).appendChild(b);
            this.#edge = b;
        }
        const b = this.#edge;
        b.hidden = false;
        b.textContent = `${side === 'top' ? '↑' : '↓'} Heterodyne ${(hz / 1000).toFixed(1)} kHz`;
        b.title = 'The heterodyne carrier is outside the visible range — click to show it';
        const h = coords.canvasHeight || wrapper.clientHeight;
        b.style.top = side === 'top' ? `${wrapper.offsetTop + 4}px` : `${wrapper.offsetTop + h - 24}px`;
    }

    #hzAt(clientY: number): number {
        const wrapper = this.#d.canvasWrapper!;
        const y = clientY - wrapper.getBoundingClientRect().top;
        const hz = this.#getCoords().pixelYToFrequency(y);
        return Math.max(CARRIER_STEP_HZ, Math.round(hz / CARRIER_STEP_HZ) * CARRIER_STEP_HZ);
    }

    #altClick(e: PointerEvent) {
        if (!e.altKey || e.button !== 0 || this.#getListenMode()?.kind !== 'heterodyne') return;
        e.preventDefault();
        e.stopPropagation();
        this.#setCarrier(this.#hzAt(e.clientY));
    }
}
