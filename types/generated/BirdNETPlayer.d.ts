export { DEFAULT_OPTIONS };
export class BirdNETPlayer {
    /**
     * @param {HTMLElement} container - the DOM element to mount the player into
     * @param {Object}      [options]
     * @param {Object}      [options.WaveSurfer]     - pre-loaded WaveSurfer constructor
     * @param {boolean}     [options.showFileOpen]    - show Open button (default: true)
     * @param {boolean}     [options.showTransport]   - show transport controls (default: true)
     * @param {boolean}     [options.showTime]        - show time display (default: true)
     * @param {boolean}     [options.showVolume]      - show volume controls (default: true)
     * @param {boolean}     [options.showViewToggles] - show Follow/Loop/Fit/Reset (default: true)
     * @param {boolean}     [options.showZoom]        - show zoom slider (default: true)
     * @param {boolean}     [options.showFFTControls] - show FFT/Freq/Color selects (default: true)
     * @param {boolean}     [options.showDisplayGain] - show Floor/Ceil sliders (default: true)
     * @param {boolean}     [options.showStatusbar]   - show bottom status bar (default: true)
     * @param {boolean}     [options.showOverview]    - show overview navigator (default: true)
     * @param {'both'|'waveform'|'spectrogram'} [options.viewMode] - visible analysis view(s) (default: both)
     * @param {'default'|'hero'} [options.transportStyle] - transport button style (default: default)
     * @param {boolean}     [options.transportOverlay] - centered play overlay without toolbar height (default: false)
     * @param {boolean}     [options.showWaveformTimeline] - show bottom waveform timeline (default: true)
     * @param {'auto'|'on'|'off'} [options.compactToolbar] - responsive toolbar compaction mode (default: auto)
     * @param {number}      [options.followGuardLeftRatio] - left follow guard ratio (default: 0.35)
     * @param {number}      [options.followGuardRightRatio] - right follow guard ratio (default: 0.65)
     * @param {number}      [options.followTargetRatio] - target ratio for viewport centering (default: 0.5)
     * @param {number}      [options.followCatchupDurationMs] - follow catchup tween duration (default: 240)
     * @param {number}      [options.followCatchupSeekDurationMs] - slower follow tween after manual seek (default: 360)
     * @param {number}      [options.smoothLerp] - smooth mode lerp factor (default: 0.18)
     * @param {number}      [options.smoothSeekLerp] - smooth mode lerp after manual seek (default: 0.08)
     * @param {number}      [options.smoothMinStepRatio] - smooth min step ratio (default: 0.03)
     * @param {number}      [options.smoothSeekMinStepRatio] - smooth min step ratio after seek (default: 0.008)
     * @param {number}      [options.smoothSeekFocusMs] - slow-follow window after manual seek (default: 1400)
     * @param {Array<{name: string, color?: string, shortcut?: string}>} [options.labelTaxonomy] - label taxonomy
     */
    constructor(container: HTMLElement, options?: {
        WaveSurfer?: Object | undefined;
        showFileOpen?: boolean | undefined;
        showTransport?: boolean | undefined;
        showTime?: boolean | undefined;
        showVolume?: boolean | undefined;
        showViewToggles?: boolean | undefined;
        showZoom?: boolean | undefined;
        showFFTControls?: boolean | undefined;
        showDisplayGain?: boolean | undefined;
        showStatusbar?: boolean | undefined;
        showOverview?: boolean | undefined;
        viewMode?: "both" | "waveform" | "spectrogram" | undefined;
        transportStyle?: "default" | "hero" | undefined;
        transportOverlay?: boolean | undefined;
        showWaveformTimeline?: boolean | undefined;
        compactToolbar?: "auto" | "on" | "off" | undefined;
        followGuardLeftRatio?: number | undefined;
        followGuardRightRatio?: number | undefined;
        followTargetRatio?: number | undefined;
        followCatchupDurationMs?: number | undefined;
        followCatchupSeekDurationMs?: number | undefined;
        smoothLerp?: number | undefined;
        smoothSeekLerp?: number | undefined;
        smoothMinStepRatio?: number | undefined;
        smoothSeekMinStepRatio?: number | undefined;
        smoothSeekFocusMs?: number | undefined;
        labelTaxonomy?: {
            name: string;
            color?: string;
            shortcut?: string;
        }[] | undefined;
    });
    container: HTMLElement;
    options: {
        WaveSurfer?: Object | undefined;
        showFileOpen?: boolean | undefined;
        showTransport?: boolean | undefined;
        showTime?: boolean | undefined;
        showVolume?: boolean | undefined;
        showViewToggles?: boolean | undefined;
        showZoom?: boolean | undefined;
        showFFTControls?: boolean | undefined;
        showDisplayGain?: boolean | undefined;
        showStatusbar?: boolean | undefined;
        showOverview?: boolean | undefined;
        viewMode?: "both" | "waveform" | "spectrogram" | undefined;
        transportStyle?: "default" | "hero" | undefined;
        transportOverlay?: boolean | undefined;
        showWaveformTimeline?: boolean | undefined;
        compactToolbar?: "auto" | "on" | "off" | undefined;
        followGuardLeftRatio?: number | undefined;
        followGuardRightRatio?: number | undefined;
        followTargetRatio?: number | undefined;
        followCatchupDurationMs?: number | undefined;
        followCatchupSeekDurationMs?: number | undefined;
        smoothLerp?: number | undefined;
        smoothSeekLerp?: number | undefined;
        smoothMinStepRatio?: number | undefined;
        smoothSeekMinStepRatio?: number | undefined;
        smoothSeekFocusMs?: number | undefined;
        labelTaxonomy?: {
            name: string;
            color?: string;
            shortcut?: string;
        }[] | undefined;
    };
    /** @type {PlayerState | null} */
    _state: PlayerState | null;
    _events: EventTarget;
    annotations: AnnotationLayer;
    spectrogramLabels: SpectrogramLabelLayer;
    _linkedLabels: Map<any, any>;
    _isSyncingLabels: boolean;
    _labelLibrary: Map<any, any>;
    _labelTaxonomy: {
        name: string;
        color: string;
        shortcut: string;
    }[];
    _activeLabelId: string | null;
    _globalKeyHandler: ((event: any) => void) | null;
    on: (event: any, callback: any, options: any) => () => void;
    off: (event: any, callback: any, options: any) => void;
    ready: Promise<this>;
    _init(): Promise<this>;
    root: HTMLElement | undefined;
    _emit(event: any, detail?: {}): void;
    /** Load audio from a URL (http, blob:, data: URLs all supported) */
    loadUrl(url: any): Promise<void | undefined>;
    /** Load audio from a File object (e.g. from an <input type="file">) */
    loadFile(file: any): Promise<void | undefined>;
    /** Current playback time in seconds */
    get currentTime(): any;
    /** Duration of loaded audio in seconds */
    get duration(): number;
    play(): void;
    pause(): void;
    stop(): void;
    togglePlayPause(): void;
    playSegment(startSec: any, endSec: any, options: any): void;
    playBandpassedSegment(startSec: any, endSec: any, freqMinHz: any, freqMaxHz: any, options: any): void;
    addAnnotation(annotation: any): any;
    setAnnotations(annotations: any): void;
    clearAnnotations(): void;
    exportAnnotationsRaven(): string;
    addSpectrogramLabel(label: any): any;
    setSpectrogramLabels(labels: any): void;
    clearSpectrogramLabels(): void;
    renameLabel(id: any, name: any): boolean;
    getLabelSuggestions(prefix?: string, limit?: number): any[];
    getLabelTaxonomy(): {
        name: string;
        color: string;
        shortcut: string;
    }[];
    setLabelTaxonomy(taxonomy?: any[]): void;
    applyTaxonomyToLabel(id: any, shortcutOrIndex: any): boolean;
    /**
     * Inject a pre-computed spectrogram as raw data (Float32Array or base64-encoded).
     * The player applies its own colorization pipeline (contrast, color map).
     *
     * @param {Float32Array|ArrayBuffer|string} data - spectrogram values.
     *   If string, decoded as base64 → Float32 (little-endian).
     * @param {number} nFrames - number of time frames
     * @param {number} nMels   - number of frequency bins
     * @param {Object} [options]
     * @param {string} [options.mode='perch'] - 'perch'|'classic' (affects freq axis labels)
     * @param {number} [options.sampleRate]   - sample rate for freq labels (default: from audio)
     */
    setSpectrogramData(data: Float32Array | ArrayBuffer | string, nFrames: number, nMels: number, options?: {
        mode?: string | undefined;
        sampleRate?: number | undefined;
    }): Promise<void | undefined>;
    /**
     * Inject a pre-rendered spectrogram image (bypasses all DSP + colorization).
     *
     * @param {string|HTMLImageElement|HTMLCanvasElement} image - base64 data-URL,
     *   regular URL, or an already-loaded Image/Canvas element.
     * @param {Object} [options]
     * @param {number} [options.sampleRate] - for freq labels
     */
    setSpectrogramImage(image: string | HTMLImageElement | HTMLCanvasElement, options?: {
        sampleRate?: number | undefined;
    }): Promise<void | undefined>;
    /**
     * Clear any externally-injected spectrogram and re-enable auto-compute.
     */
    clearExternalSpectrogram(): Promise<void>;
    setPlaybackViewportConfig(config?: {}): any;
    getPlaybackViewportConfig(): any;
    /** Tear down the player and free resources */
    destroy(): void;
    _bindLinkedLabelSync(): void;
    _bindGlobalHotkeys(): void;
    _previewFromAnnotationEvent(annotation: any): void;
    _previewFromSpectrogramEvent(label: any): void;
    _upsertFromAnnotationEvent(annotation: any): void;
    _upsertFromSpectrogramEvent(label: any): void;
    _syncLinkedLabelsToLayers(): void;
    _rebuildLabelLibrary(): void;
    _normalizeTaxonomy(taxonomy: any): {
        name: string;
        color: string;
        shortcut: string;
    }[];
    _toAnnotationList(): {
        id: any;
        start: any;
        end: any;
        species: any;
        confidence: any;
        color: any;
    }[];
    _toSpectrogramLabelList(): {
        id: any;
        start: any;
        end: any;
        freqMin: any;
        freqMax: any;
        label: any;
        color: any;
    }[];
    _normalizeLinkedLabel(label: any): {
        id: any;
        start: number;
        end: number;
        freqMin: number;
        freqMax: number;
        species: any;
        label: any;
        confidence: any;
        color: any;
    };
}
import { DEFAULT_OPTIONS } from './template.js';
import { PlayerState } from './PlayerState.js';
import { AnnotationLayer } from './annotations.js';
import { SpectrogramLabelLayer } from './annotations.js';
