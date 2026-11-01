import type { OnFn, UiController } from '../shared/controller.types.ts';
import type { DomRefs } from '../../../app/domRefs.ts';

export interface FreqViewportHost {
    readonly audioBuffer: AudioBuffer | null;
    _showSpectrogram: boolean;
    _freqZoom: {
        isZoomed: boolean;
        min: number | null;
        max: number | null;
        set(min: number, max: number): void;
        setFromSlider(value: number): void;
        zoom(factor: number, centerHz: number): void;
    };
    applyAutoFreqView(): boolean;
    coords: { boundedMaxFreq: number; pixelYToFrequency(y: number): number };
}

export class FreqViewportController implements UiController {
    private d: DomRefs;
    private host: FreqViewportHost;
    constructor(d: DomRefs, host: FreqViewportHost) { this.d = d; this.host = host; }

    bind(on: OnFn): void {
        const h = this.host;

        // Freq axis left-drag = vertical pan
        {
            let dragging = false;
            let startY = 0;
            let startMin = 0;
            let startMax = 0;
            const onMove = (e: PointerEvent) => {
                if (!dragging) return;
                const spacerH = this.d.freqAxisSpacer!.getBoundingClientRect().height;
                const dy = e.clientY - startY;
                const boundedMax = h.coords.boundedMaxFreq;
                const range = startMax - startMin;
                const deltaHz = (dy / spacerH) * range;
                let newMin = startMin + deltaHz;
                let newMax = startMax + deltaHz;
                if (newMin < 0) { newMin = 0; newMax = range; }
                if (newMax > boundedMax) { newMax = boundedMax; newMin = boundedMax - range; }
                h._freqZoom.set(Math.max(0, newMin), Math.min(boundedMax, newMax));
            };
            const onUp = () => {
                if (!dragging) return;
                dragging = false;
                document.body.style.cursor = '';
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
            };
            on(this.d.freqAxisSpacer, 'pointerdown', (e: PointerEvent) => {
                if (e.button !== 0 || !h._showSpectrogram) return;
                if (!h._freqZoom.isZoomed) return;
                e.preventDefault();
                dragging = true;
                startY = e.clientY;
                startMin = h._freqZoom.min ?? 0;
                startMax = h._freqZoom.max ?? h.coords.boundedMaxFreq;
                document.body.style.cursor = 'ns-resize';
                document.addEventListener('pointermove', onMove);
                document.addEventListener('pointerup', onUp);
            });
        }

        // Freq axis wheel = vertical zoom
        on(this.d.freqAxisSpacer, 'wheel', (e: WheelEvent) => {
            if (!h.audioBuffer || !h._showSpectrogram) return;
            e.preventDefault();
            const rect = this.d.freqAxisSpacer!.getBoundingClientRect();
            const localY = e.clientY - rect.top;
            const canvasH = this.d.spectrogramCanvas?.height || rect.height;
            const canvasY = (localY / Math.max(1, rect.height)) * canvasH;
            const freqAtCursor = h.coords.pixelYToFrequency(canvasY);
            const zoomIn = e.deltaY < 0;
            h._freqZoom.zoom(zoomIn ? 1.15 : 1 / 1.15, freqAtCursor);
        }, { passive: false });

        // Freq zoom slider
        on(this.d.freqZoomSlider, 'input', (e: Event) => {
            h._freqZoom.setFromSlider(parseInt((e.target as HTMLInputElement).value, 10));
        });

        // − / + step around the middle of the visible range; Auto fits to the calls
        const step = (factor: number) => {
            if (!h.audioBuffer) return;
            const max = h.coords.boundedMaxFreq;
            const lo = h._freqZoom.min ?? 0;
            const hi = h._freqZoom.max ?? max;
            // Anchored at the bottom while the view starts at 0 Hz (calls sit above it).
            h._freqZoom.zoom(factor, lo <= 1 ? 0 : (lo + hi) / 2);
        };
        on(this.d.freqZoomInBtn, 'click', () => step(1.5));
        on(this.d.freqZoomOutBtn, 'click', () => step(1 / 1.5));
        on(this.d.freqAutoBtn, 'click', () => {
            if (!h.audioBuffer || h.applyAutoFreqView()) return;
            // Nothing to fit: the activity spans the whole range.
            this.d.freqAutoBtn?.classList.add('zoom-auto-none');
            setTimeout(() => this.d.freqAutoBtn?.classList.remove('zoom-auto-none'), 900);
        });

        // Freq scrollbar drag
        {
            let dragging = false;
            let startY = 0;
            let startMin = 0;
            let startMax = 0;
            const onMove = (e: PointerEvent) => {
                if (!dragging) return;
                const barH = this.d.freqScrollbar!.getBoundingClientRect().height;
                const dy = e.clientY - startY;
                const boundedMax = h.coords.boundedMaxFreq;
                const range = startMax - startMin;
                // dy positive = drag down = lower freqs
                const deltaHz = (dy / barH) * boundedMax;
                let newMin = startMin - deltaHz;
                let newMax = startMax - deltaHz;
                if (newMin < 0) { newMin = 0; newMax = range; }
                if (newMax > boundedMax) { newMax = boundedMax; newMin = boundedMax - range; }
                h._freqZoom.set(Math.max(0, newMin), Math.min(boundedMax, newMax));
            };
            const onUp = () => {
                if (!dragging) return;
                dragging = false;
                this.d.freqScrollbar?.classList.remove('active');
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
            };
            on(this.d.freqScrollbarThumb, 'pointerdown', (e: PointerEvent) => {
                if (!h._freqZoom.isZoomed) return;
                e.preventDefault();
                e.stopPropagation();
                dragging = true;
                startY = e.clientY;
                startMin = h._freqZoom.min ?? 0;
                startMax = h._freqZoom.max ?? h.coords.boundedMaxFreq;
                this.d.freqScrollbar?.classList.add('active');
                document.addEventListener('pointermove', onMove);
                document.addEventListener('pointerup', onUp);
            });
        }
    }
}
