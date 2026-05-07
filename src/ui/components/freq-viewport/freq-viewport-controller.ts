import type { OnFn, UiController } from '../shared/controller.types.ts';
import type { DomRefs } from '../../../app/domRefs.ts';

export interface FreqViewportHost {
    readonly audioBuffer: AudioBuffer | null;
    _showSpectrogram: boolean;
    _freqView: {
        isZoomed: boolean;
        min: number | null;
        max: number | null;
        set(min: number, max: number): void;
        setFromSlider(value: number, boundedMax: number): void;
        zoom(factor: number, centerHz: number, boundedMax: number): void;
    };
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
                h._freqView.set(Math.max(0, newMin), Math.min(boundedMax, newMax));
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
                if (!h._freqView.isZoomed) return;
                e.preventDefault();
                dragging = true;
                startY = e.clientY;
                startMin = h._freqView.min ?? 0;
                startMax = h._freqView.max ?? h.coords.boundedMaxFreq;
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
            h._freqView.zoom(zoomIn ? 1.15 : 1 / 1.15, freqAtCursor, h.coords.boundedMaxFreq);
        }, { passive: false });

        // Freq zoom slider
        on(this.d.freqZoomSlider, 'input', (e: Event) => {
            h._freqView.setFromSlider(
                parseInt((e.target as HTMLInputElement).value, 10),
                h.coords.boundedMaxFreq
            );
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
                h._freqView.set(Math.max(0, newMin), Math.min(boundedMax, newMax));
            };
            const onUp = () => {
                if (!dragging) return;
                dragging = false;
                this.d.freqScrollbar?.classList.remove('active');
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
            };
            on(this.d.freqScrollbarThumb, 'pointerdown', (e: PointerEvent) => {
                if (!h._freqView.isZoomed) return;
                e.preventDefault();
                e.stopPropagation();
                dragging = true;
                startY = e.clientY;
                startMin = h._freqView.min ?? 0;
                startMax = h._freqView.max ?? h.coords.boundedMaxFreq;
                this.d.freqScrollbar?.classList.add('active');
                document.addEventListener('pointermove', onMove);
                document.addEventListener('pointerup', onUp);
            });
        }
    }
}
