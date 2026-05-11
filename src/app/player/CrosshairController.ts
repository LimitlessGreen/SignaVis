// ═══════════════════════════════════════════════════════════════════════
// CrosshairController.ts — Crosshair overlay for the spectrogram canvas
//
// Owns:
//   • enabled/disabled state
//   • Canvas drawing (RAF-batched)
//   • Readout positioning and text formatting
//   • Clean-up on dispose()
//
// Receives all DOM/state dependencies via constructor injection so it
// can be tested independently.
// ═══════════════════════════════════════════════════════════════════════

export interface CrosshairDeps {
    d: {
        canvasWrapper: any;
        crosshairCanvas: any;
        crosshairReadout: any;
        crosshairToggleBtn: any;
        scaleSelect: any;
    };
    getAudioBuffer: () => any;
    getSpectro: () => { data: Float32Array | null; nFrames: number; nMels: number } | null;
    getCoords: () => any;
}

export class CrosshairController {
    #enabled = false;
    #rafId = 0;
    #d: CrosshairDeps['d'];
    #getAudioBuffer: CrosshairDeps['getAudioBuffer'];
    #getSpectro: CrosshairDeps['getSpectro'];
    #getCoords: CrosshairDeps['getCoords'];

    constructor({ d, getAudioBuffer, getSpectro, getCoords }: CrosshairDeps) {
        this.#d = d;
        this.#getAudioBuffer = getAudioBuffer;
        this.#getSpectro = getSpectro;
        this.#getCoords = getCoords;
    }

    get enabled() { return this.#enabled; }

    toggle() {
        this.#enabled = !this.#enabled;
        if (this.#d.crosshairToggleBtn) {
            this.#d.crosshairToggleBtn.classList.toggle('active', this.#enabled);
        }
        if (!this.#enabled) this.hide();
    }

    /** @param {MouseEvent|PointerEvent} e */
    update(e: MouseEvent | PointerEvent) {
        if (!this.#enabled) return;
        const spectro = this.#getSpectro();
        if (!this.#getAudioBuffer() || !spectro?.data) return;

        const d = this.#d;
        const wrapper = d.canvasWrapper;
        const overlay = d.crosshairCanvas;
        const readout = d.crosshairReadout;
        if (!wrapper || !overlay || !readout) return;

        const rect = wrapper.getBoundingClientRect();
        const c = this.#getCoords();
        const { time, freq, canvasX, canvasY, localX, localY } =
            c.clientToTimeFreq(e.clientX, e.clientY, rect, wrapper.scrollLeft);

        // Out of bounds?
        if (localX < 0 || localX > rect.width || localY < 0 || localY > rect.height) {
            this.hide();
            return;
        }

        // Amplitude at this position
        const frame = c.timeToFrame(time, spectro.nFrames);
        const bin = c.pixelYToBin(canvasY);
        const amplitude = spectro.data[frame * spectro.nMels + bin] || 0;

        // Draw crosshair lines on overlay canvas (RAF-batched).
        // Canvas is viewport-sized (sticky rendering), so use localX not canvasX.
        if (this.#rafId) cancelAnimationFrame(this.#rafId);
        this.#rafId = requestAnimationFrame(() => {
            this.#rafId = 0;
            const vw = wrapper.clientWidth || c.canvasWidth;
            this.#drawLines(overlay, localX, canvasY, vw, c.canvasHeight);
        });

        // Format readout text
        const timeStr = time.toFixed(3) + ' s';
        const freqStr = freq >= 1000 ? (freq / 1000).toFixed(2) + ' kHz' : Math.round(freq) + ' Hz';
        const isLinear = (d.scaleSelect?.value || 'mel') === 'linear';
        const ampStr = isLinear
            ? amplitude.toFixed(1) + ' dB'
            : amplitude.toFixed(4);
        readout.textContent = `${timeStr}  |  ${freqStr}  |  ${ampStr}`;
        readout.classList.add('visible');

        // Position readout near cursor but keep inside viewport
        const rw = readout.offsetWidth || 160;
        const rh = readout.offsetHeight || 20;
        let rx = localX + 14;
        let ry = localY - rh - 8;
        if (rx + rw > rect.width) rx = localX - rw - 10;
        if (ry < 0) ry = localY + 18;
        readout.style.left = (wrapper.scrollLeft + rx) + 'px';
        readout.style.top = ry + 'px';
    }

    hide() {
        const overlay = this.#d.crosshairCanvas;
        const readout = this.#d.crosshairReadout;
        if (overlay) {
            const ctx = overlay.getContext('2d');
            if (ctx) ctx.clearRect(0, 0, overlay.width, overlay.height);
        }
        if (readout) readout.classList.remove('visible');
        if (this.#rafId) {
            cancelAnimationFrame(this.#rafId);
            this.#rafId = 0;
        }
    }

    dispose() { this.hide(); }

    #drawLines(overlay: HTMLCanvasElement, cx: number, cy: number, w: number, h: number) {
        if (overlay.width !== w || overlay.height !== h) {
            overlay.width = w;
            overlay.height = h;
        }
        const ctx = overlay.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, w, h);

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);

        // Vertical line
        const x = Math.round(cx) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();

        // Horizontal line
        const y = Math.round(cy) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();

        ctx.setLineDash([]);
    }
}
