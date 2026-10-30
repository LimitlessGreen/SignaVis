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
    #el: HTMLDivElement | null = null;
    #label: HTMLSpanElement | null = null;
    /** Carrier shown while dragging, before it is applied. */
    #dragHz: number | null = null;
    #lastTop = '';
    #onAltClick = (e: PointerEvent) => this.#altClick(e);

    constructor({ d, getCoords, getListenMode, setCarrier }: CarrierLineDeps) {
        this.#d = d;
        this.#getCoords = getCoords;
        this.#getListenMode = getListenMode;
        this.#setCarrier = setCarrier;
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
            return;
        }
        const el = this.#ensureElement(wrapper);
        const hz = this.#dragHz ?? mode.carrierHz;
        const y = coords.frequencyToPixelY(hz);
        const visible = Number.isFinite(y) && y >= 0 && y <= coords.canvasHeight;
        el.hidden = !visible;
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
            borderTop: '2px dashed var(--color-accent, #39b5ff)', pointerEvents: 'none',
        });
        const label = document.createElement('span');
        Object.assign(label.style, {
            position: 'absolute', right: '6px', bottom: `${GRAB_PX / 2 + 2}px`,
            font: '600 11px/1.2 var(--font-mono, monospace)', color: 'var(--color-accent, #39b5ff)',
            background: 'var(--color-bg-secondary, rgba(0,0,0,0.6))', padding: '1px 5px', borderRadius: '3px',
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
