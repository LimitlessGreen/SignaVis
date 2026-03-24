/**
 * @typedef {Object} AnnotationRegion
 * @property {string} [id]
 * @property {number} start
 * @property {number} end
 * @property {string} [species]
 * @property {number} [confidence]
 * @property {string} [color]
 */
export class AnnotationLayer {
    player: any;
    overlay: HTMLDivElement | null;
    annotations: any[];
    _liveLinkedId: any;
    _unsubs: any[];
    _domCleanups: any[];
    _editing: {
        id: any;
        mode: any;
        startX: any;
        startRegion: any;
        element: any;
        pending: boolean;
        moved: boolean;
        forceSuppressClick: boolean;
    } | null;
    _suppressClickUntil: number;
    attach(player: any): void;
    detach(): void;
    add(annotation: any): any;
    set(regions?: any[]): void;
    clear(): void;
    remove(id: any): void;
    getAll(): any[];
    setLiveLinkedId(id?: null): void;
    highlightActiveRegion(currentTime: any): void;
    exportRavenFormat(regions?: any[]): string;
    render(): void;
    _createRegionElement(region: any, pixelsPerSecond: any): HTMLDivElement;
    _bindEditingInteractions(root: any): void;
    _startEditInteraction(id: any, mode: any, clientX: any, element: any): void;
    _updateEditInteraction(clientX: any): void;
    _finishEditInteraction(): void;
    _renameRegionPrompt(id: any): void;
    _normalize(annotation: any): {
        id: any;
        start: number;
        end: number;
        species: any;
        confidence: any;
        color: string;
    };
}
/**
 * @typedef {Object} SpectrogramLabel
 * @property {string} [id]
 * @property {number} start
 * @property {number} end
 * @property {number} freqMin
 * @property {number} freqMax
 * @property {string} [label]
 * @property {string} [color]
 */
export class SpectrogramLabelLayer {
    player: any;
    overlay: HTMLDivElement | null;
    labels: any[];
    _liveLinkedId: any;
    _unsubs: any[];
    _domCleanups: any[];
    _draftEl: HTMLDivElement | null;
    _drawing: {
        startTime: any;
        startFreq: number;
        endTime: any;
        endFreq: number;
    } | null;
    _editing: {
        id: any;
        mode: any;
        startX: any;
        startY: any;
        startLabel: any;
        element: any;
        pending: boolean;
        moved: boolean;
        forceSuppressClick: boolean;
    } | null;
    _counter: number;
    _suppressClickUntil: number;
    attach(player: any): void;
    detach(): void;
    add(label: any): any;
    set(labels?: any[]): void;
    clear(): void;
    remove(id: any): void;
    getAll(): any[];
    setLiveLinkedId(id?: null): void;
    highlightActiveLabel(currentTime: any): void;
    render(): void;
    _createLabelElement(label: any, canvasWidth: any, canvasHeight: any): HTMLDivElement;
    _applyGeometryToElement(el: any, geometry: any): void;
    _toGeometry(label: any, canvasWidth: any, canvasHeight: any): {
        left: number;
        top: number;
        width: number;
        height: number;
    };
    _bindDrawingInteractions(wrapper: any): void;
    _ensureDraft(): void;
    _updateDraft(): void;
    _finalizeDraft(): {
        id: any;
        start: number;
        end: number;
        freqMin: number;
        freqMax: number;
        label: any;
        color: string;
    } | null;
    _clearDraft(): void;
    _startEditInteraction(labelId: any, mode: any, clientX: any, clientY: any, element: any): void;
    _updateEditInteraction(clientX: any, clientY: any): void;
    _finishEditInteraction(): void;
    _renameSpectrogramLabelPrompt(id: any): void;
    _clientXToTime(clientX: any): any;
    _clientYToFreq(clientY: any): number;
    _getMaxFreq(): number;
    _normalize(label: any): {
        id: any;
        start: number;
        end: number;
        freqMin: number;
        freqMax: number;
        label: any;
        color: string;
    };
}
export type AnnotationRegion = {
    id?: string | undefined;
    start: number;
    end: number;
    species?: string | undefined;
    confidence?: number | undefined;
    color?: string | undefined;
};
export type SpectrogramLabel = {
    id?: string | undefined;
    start: number;
    end: number;
    freqMin: number;
    freqMax: number;
    label?: string | undefined;
    color?: string | undefined;
};
