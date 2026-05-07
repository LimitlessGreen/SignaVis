// ═══════════════════════════════════════════════════════════════════════
// BirdNETPlayer.ts - Public API for the BirdNET Audio Player module
//
// Usage:
//   import { BirdNETPlayer } from './BirdNETPlayer.ts';
//   const player = new BirdNETPlayer(document.getElementById('root'));
//   await player.ready;
//   await player.loadUrl('https://example.com/audio.wav');
//   player.play();
// ═══════════════════════════════════════════════════════════════════════

import { createPlayerHTML, DEFAULT_OPTIONS } from '../ui/template.ts';
import { DEFAULT_SAMPLE_RATE } from '../shared/constants.ts';
import { clamp } from '../shared/utils.ts';
import { PlayerState } from './PlayerState.ts';
import { AnnotationLayer, SpectrogramLabelLayer, colorForName, parseColorToRgb } from '../domain/annotations.ts';
import { UndoStack } from '../domain/undoStack.ts';
import '../styles/main.scss';  // Vite compiles SCSS and extracts into birdnet-player.css

import type { AnnotationEntry, SpectrogramLabelEntry } from '../shared/events.ts';
import { EventBus } from '../shared/EventBus.ts';
import type { LinkedLabel } from '../shared/label.types.ts';
import { normalizeLabelStrings } from '../shared/labelNormalize.ts';

export type { LinkedLabel };

export interface PlaySegmentOptions {
    loop?: boolean;
    labelId?: string;
}

export interface LabelSuggestionItem {
    name: string;
    color?: string;
    scientificName?: string;
    detail?: string;
}

export type PlayerEventName =
    | 'ready' | 'transportstatechange' | 'play' | 'pause' | 'finish' | 'seek'
    | 'labelfocus' | 'labelsync' | 'undochange' | 'labeltaxonomyapply'
    | 'annotationcreate' | 'annotationupdate' | 'annotationremove' | 'annotationpreview'
    | 'spectrogramlabelcreate' | 'spectrogramlabelupdate' | 'spectrogramlabelremove' | 'spectrogramlabelpreview'
    | 'stampmodechange' | 'speciesbarchange' | 'viewresize' | 'viewportchange'
    | string;

export type AnnotationInput = Partial<AnnotationEntry> & { start: number; end: number };
export type SpectrogramLabelInput = Partial<SpectrogramLabelEntry> & { start: number; end: number };

const WAVESURFER_CDN = 'https://unpkg.com/wavesurfer.js@7/dist/wavesurfer.esm.js';













const DEFAULT_LABEL_TAXONOMY = [
    { name: 'Bird Call', color: '#0ea5e9', shortcut: '1' },
    { name: 'Song', color: '#22c55e', shortcut: '2' },
    { name: 'Chirp', color: '#f59e0b', shortcut: '3' },
    { name: 'Noise', color: '#ef4444', shortcut: '4' },
];

export { DEFAULT_OPTIONS };
export {
    DEFAULT_XC_ENDPOINT,
    XenoCantoApiClient,
    XenoCantoApiError,
    buildXenoCantoAnnotationSet,
} from '../infrastructure/xeno-canto/xenoCantoApi.ts';
export {
    DEFAULT_XC_RECORDINGS_ENDPOINT,
    normalizeXcId,
    getRecordingScientificName,
    fetchXenoCantoRecording,
    extractXenoCantoRawLabels,
    mapXenoCantoLabelsToSpectrogram,
    importXenoCantoSpectrogramLabels,
} from '../infrastructure/xeno-canto/xenoCantoRecordingsApi.ts';
export { TaxonomyResolver } from '../infrastructure/taxonomyResolver.ts';
export { BirdNETInference, BIRDNET_MODEL_URL } from '../infrastructure/birdnetInference.ts';

export class BirdNETPlayer {
    container: any;
    options: Record<string, any>;
    _state: any;
    _events: EventBus;
    annotations: AnnotationLayer;
    spectrogramLabels: SpectrogramLabelLayer;
    _linkedLabels: Map<string, LinkedLabel>;
    _isSyncingLabels: boolean;
    _undoStack: UndoStack;
    _isRestoring: boolean;
    _labelLibrary: Map<string, number>;
    _labelSuggestionProvider: ((q: string, limit: number) => (string | LabelSuggestionItem)[]) | null;
    _labelEditorSuggestionMode: 'merge' | 'custom-only';
    _labelTaxonomy: Array<{ name: string; color?: string; shortcut?: string }>;
    _activeLabelId: string | null;
    _globalKeyHandler: any;
    _onLabelFocus: ((e: Event) => void) | null;
    _backgroundSpecies: any;
    _speciesBarSelection: any;
    on: any;
    off: any;
    ready: any;
    root: any;
    WaveSurfer: any;
    _tagPresets: any;
    map: any;
    _stampBtn: any;
    target: any;
    _drawBtn: any;
    trim: any;
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
    constructor(container: HTMLElement, options: { labelTaxonomy?: any[]; WaveSurfer?: any; onDspCommand?: ((cmd: any) => void) | null; [k: string]: any } = {}) {
        if (!container) throw new Error('BirdNETPlayer: container element required');
        this.container = container;
        this.options = options as Record<string, any>;
        /** @type {PlayerState | null} */
        this._state = null;
        this._events = new EventBus();
        this.annotations = new AnnotationLayer();
        this.spectrogramLabels = new SpectrogramLabelLayer();
        this._linkedLabels = new Map();
        this._isSyncingLabels = false;
        this._undoStack = new UndoStack(100);
        this._isRestoring = false;  // true during undo/redo restore
        this._labelLibrary = new Map();
        this._labelSuggestionProvider = null;
        this._labelEditorSuggestionMode = 'merge';
        this._labelTaxonomy = this._normalizeTaxonomy(options.labelTaxonomy || DEFAULT_LABEL_TAXONOMY);
        this._activeLabelId = null;
        this._globalKeyHandler = null;
        this._onLabelFocus = null;
        /** @type {Array<{ name: string, scientificName?: string }>} */
        this._backgroundSpecies = [];
        /** @type {{ name: string, color: string, scientificName: string } | null} */
        this._speciesBarSelection = null;

        // Public API keeps the CustomEvent-style signature (e.detail.xxx) for
        // backward compat with external consumers and demo code.
        this.on = (event: string, callback: (e: { detail: unknown }) => void, options?: AddEventListenerOptions) =>
            this._events.on(event, (detail) => callback({ detail }), options);

        this.off = (event: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions) =>
            this._events.off(event, listener, options);

        this.ready = this._init();
    }

    // ── Initialization ──────────────────────────────────────────────

    async _init() {
        // 1. Inject player DOM (pass options for section visibility)
        this.container.innerHTML = createPlayerHTML(this.options);
        this.root = /** @type {HTMLElement} */ (this.container.querySelector('.daw-shell'));

        // 2. Resolve WaveSurfer (option → global → CDN import)
        const WaveSurfer = this.options.WaveSurfer
            || (window as any).WaveSurfer
            || (await import(/* @vite-ignore */ WAVESURFER_CDN)).default;

        // 3. Create internal state machine — wire DSP undo into the shared stack
        this._state = new PlayerState(
            this.root,
            WaveSurfer,
            (event, detail) => this._emit(event, detail),
            {
                ...this.options,
                onDspCommand: (cmd: any) => {
                    this._undoStack.record(cmd as any);
                    this._emit('undochange', {
                        canUndo: this._undoStack.canUndo,
                        canRedo: this._undoStack.canRedo,
                    });
                },
            },
        );
        this.annotations.attach(this);
        this.spectrogramLabels.attach(this);
        this._bindLinkedLabelSync();
        this._bindGlobalHotkeys();
        this._injectAnnotationToolbar();
        // Note: stampmodechange is now handled inside _bindLinkedLabelSync()
        // via a direct listener on this.spectrogramLabels (no longer needs
        // routing through the player event bus first).
        this._emit('ready', { phase: 'init' });
        return this;
    }

    _emit(event: string, detail: unknown = {}): void {
        this._events.emit(event, detail);
    }

    // ── Public API ──────────────────────────────────────────────────

    /**
     * Show the spectrogram loading overlay with a custom message.
     * Useful for displaying feedback during network fetches before DSP starts.
     * Pass no argument (or call hideLoadingOverlay) to dismiss it.
     * @param {string} [text]
     */
    showLoadingOverlay(text = 'Loading…') {
        const overlay = this._state?.d?.recomputingOverlay;
        if (!overlay) return;
        const textEl = overlay.querySelector('span:last-child');
        if (textEl) textEl.textContent = text;
        overlay.hidden = false;
    }

    /** Hide the loading overlay that was shown via showLoadingOverlay(). */
    hideLoadingOverlay() {
        const overlay = this._state?.d?.recomputingOverlay;
        if (overlay) overlay.hidden = true;
    }

    /**
     * Load audio from a URL (http, blob:, data: URLs all supported).
     * @param {string} url
     * @returns {Promise<void>}
     */
    async loadUrl(url: string) {
        await this.ready;
        return this._state?.loadUrl(url);
    }

    /**
     * Load audio from a File object (e.g. from an <input type="file">).
     * @param {File} file
     * @returns {Promise<void>}
     */
    async loadFile(file: File) {
        await this.ready;
        return this._state?.loadFile(file);
    }

    /** Current playback time in seconds */
    get currentTime() {
        return this._state?._getCurrentTime() || 0;
    }

    /** Duration of loaded audio in seconds */
    get duration() {
        return this._state?.audioBuffer?.duration || 0;
    }

    play()            { this._state?.wavesurfer?.play(); }
    pause()           { this._state?.wavesurfer?.pause(); }
    stop()            { this._state?._stopPlayback(); }
    togglePlayPause() { this._state?._togglePlayPause(); }

    /**
     * Play a time-bounded segment, optionally looping.
     * @param {number} startSec
     * @param {number} endSec
     * @param {PlaySegmentOptions} [options]
     */
    playSegment(startSec: number, endSec: number, options?: PlaySegmentOptions) { this._state?.playSegment(startSec, endSec, options); }

    /**
     * Play a segment through a bandpass filter centered on the given frequency range.
     * @param {number} startSec
     * @param {number} endSec
     * @param {number} freqMinHz
     * @param {number} freqMaxHz
     * @param {PlaySegmentOptions} [options]
     */
    playBandpassedSegment(startSec: number, endSec: number, freqMinHz: number, freqMaxHz: number, options?: PlaySegmentOptions) {
        this._state?.playBandpassedSegment(startSec, endSec, freqMinHz, freqMaxHz, options);
    }

    /**
     * Add or update a single waveform annotation. Returns the annotation id.
     * @param {AnnotationInput} annotation
     * @returns {string} id
     */
    addAnnotation(annotation: Partial<LinkedLabel>) {
        const id = (annotation as any)?.id || `lbl_${Math.random().toString(36).slice(2, 10)}`;
        const existing = this._linkedLabels.get(id);
        const merged = this._normalizeLinkedLabel({
            ...existing,
            ...(annotation as any),
            id,
            label: (annotation as any)?.label ?? (annotation as any)?.species ?? existing?.label ?? 'Label',
        });
        this._linkedLabels.set(id, merged);
        this._syncLinkedLabelsToLayers();
        return id;
    }
    /**
     * Replace all waveform annotations at once.
     * @param {AnnotationInput[]} annotations
     */
    setAnnotations(annotations: Partial<LinkedLabel>[]) {
        const next = new Map<string, LinkedLabel>();
        for (const ann of annotations || []) {
            const id = (ann as any)?.id || `lbl_${Math.random().toString(36).slice(2, 10)}`;
            const existing = this._linkedLabels.get(id);
            next.set(id, this._normalizeLinkedLabel({
                ...existing,
                ...(ann as any),
                id,
                label: (ann as any)?.label ?? (ann as any)?.species ?? existing?.label ?? 'Label',
            }));
        }
        this._linkedLabels = next;
        this._syncLinkedLabelsToLayers();
    }
    clearAnnotations() {
        this._linkedLabels.clear();
        this._syncLinkedLabelsToLayers();
    }
    /** @returns {string} Tab-separated Raven selection table */
    exportAnnotationsRaven() {
        return this.annotations.exportRavenFormat(this._toAnnotationList());
    }

    /**
     * Add or update a single spectrogram label. Returns the label id.
     * @param {SpectrogramLabelInput} label
     * @returns {string} id
     */
    addSpectrogramLabel(label: Partial<LinkedLabel>) {
        const id = (label as any)?.id || `lbl_${Math.random().toString(36).slice(2, 10)}`;
        const existing = this._linkedLabels.get(id);
        const merged = this._normalizeLinkedLabel({
            ...existing,
            ...(label as any),
            id,
            species: (label as any)?.species ?? (label as any)?.label ?? existing?.species ?? '',
            label: (label as any)?.label ?? existing?.label ?? (label as any)?.species ?? 'Label',
        });
        this._linkedLabels.set(id, merged);
        this._syncLinkedLabelsToLayers();
        return id;
    }
    /**
     * Replace all spectrogram labels at once.
     * @param {SpectrogramLabelInput[]} labels
     */
    setSpectrogramLabels(labels: Partial<LinkedLabel>[]) {
        const next = new Map<string, LinkedLabel>();
        for (const lbl of labels || []) {
            const id = (lbl as any)?.id || `lbl_${Math.random().toString(36).slice(2, 10)}`;
            const existing = this._linkedLabels.get(id);
            next.set(id, this._normalizeLinkedLabel({
                ...existing,
                ...(lbl as any),
                id,
                species: (lbl as any)?.species ?? (lbl as any)?.label ?? existing?.species ?? '',
                label: (lbl as any)?.label ?? existing?.label ?? (lbl as any)?.species ?? 'Label',
            }));
        }
        this._linkedLabels = next;
        this._syncLinkedLabelsToLayers();
    }
    clearSpectrogramLabels() {
        this._linkedLabels.clear();
        this._backgroundSpecies = [];
        this.setSpeciesBar('');
        this._syncLinkedLabelsToLayers();
    }
    /**
     * Rename an existing label by id. Returns false if the id is not found.
     * @param {string} id
     * @param {string} name
     * @returns {boolean}
     */
    renameLabel(id: string, name: string) {
        const key = String(id || '').trim();
        const value = String(name || '').trim();
        if (!key || !value) return false;
        const current = this._linkedLabels.get(key);
        if (!current) return false;
        this._linkedLabels.set(key, this._normalizeLinkedLabel({
            ...current,
            id: key,
            label: value,
            species: value,
        }));
        this._syncLinkedLabelsToLayers();
        return true;
    }
    /**
     * Return label names from the internal usage library, ranked by frequency.
     * @param {string} [prefix]
     * @param {number} [limit]
     * @returns {string[]}
     */
    getLabelSuggestions(prefix = '', limit = 10) {
        const q = String(prefix || '').trim().toLowerCase();
        const ranked = Array.from(this._labelLibrary.entries())
            .filter(([name]) => !q || name.toLowerCase().includes(q))
            .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
            .slice(0, Math.max(1, limit))
            .map(([name]) => name);
        return ranked;
    }
    /**
     * Register a custom suggestion provider called when the label editor is open.
     * @param {((query: string, limit: number) => (string | LabelSuggestionItem)[]) | null} provider
     */
    setLabelSuggestionProvider(provider = null) {
        this._labelSuggestionProvider = typeof provider === 'function' ? provider : null;
    }
    /**
     * @param {'merge'|'custom-only'} [mode]
     */
    setLabelEditorSuggestionMode(mode = 'merge') {
        const m = String(mode || '').trim().toLowerCase();
        this._labelEditorSuggestionMode = (m === 'custom-only') ? 'custom-only' : 'merge';
    }
    getLabelEditorSuggestionMode() {
        return this._labelEditorSuggestionMode || 'merge';
    }
    /**
     * Invoke the registered suggestion provider and return normalized results.
     * @param {string} [query]
     * @param {number} [limit]
     * @returns {LabelSuggestionItem[]}
     */
    getLabelEditorSuggestions(query = '', limit = 12) {
        if (!this._labelSuggestionProvider) return [];
        try {
            const out = this._labelSuggestionProvider(String(query || ''), Math.max(1, Number(limit) || 12));
            if (!Array.isArray(out)) return [];
            const mapped = out
                .map((item) => {
                    if (typeof item === 'string') {
                        const name = item.trim();
                        return name ? { name } : null;
                    }
                    const name = String(item?.name || '').trim();
                    if (!name) return null;
                    const color = String(item?.color || '').trim();
                    const scientificName = String(item?.scientificName || '').trim();
                    const detail = String(item?.detail || '').trim();
                    return {
                        name,
                        color: color || '',
                        scientificName: scientificName || '',
                        detail: detail || '',
                    };
                })
                .filter((x) => x !== null);
            return /** @type {LabelSuggestionItem[]} */ (/** @type {unknown} */ (mapped));
        } catch {
            return [];
        }
    }
    /** @returns {Array<{name: string, color: string, shortcut: string}>} */
    getLabelTaxonomy() {
        return this._labelTaxonomy.map((item) => ({ ...item }));
    }

    /**
     * @param {Array<{name: string, color?: string, shortcut?: string}>} [taxonomy]
     */
    setLabelTaxonomy(taxonomy = []) {
        this._labelTaxonomy = this._normalizeTaxonomy(taxonomy);
        this._syncLinkedLabelsToLayers();
    }

    /**
     * Override or extend the tag presets shown in the label editor dialog.
     * Each entry: { key, label, options: string[] }
     * @param {Array<{ key: string, label?: string, options: string[] }>} presets
     */
    setTagPresets(presets: Array<{ key: string; label?: string; options: string[] }>) {
        this._tagPresets = (presets || []).map((p: any) => ({
            key: String(p.key || ''),
            label: String(p.label || p.key || ''),
            options: Array.isArray(p.options) ? p.options.map(String) : [],
        })).filter((p: any) => p.key);
    }
    /** @returns {Array<{key: string, label: string, options: string[]}> | null} */
    getTagPresets() {
        return this._tagPresets ? this._tagPresets.map((p: any) => ({ ...p, options: p.options.slice() })) : null;
    }

    /**
     * Apply a taxonomy entry to an existing label by shortcut key or array index.
     * @param {string} id
     * @param {number | string} shortcutOrIndex
     * @returns {boolean}
     */
    applyTaxonomyToLabel(id: string, shortcutOrIndex: number | string) {
        const key = String(id || '').trim();
        const current = this._linkedLabels.get(key);
        if (!current) return false;

        const index = typeof shortcutOrIndex === 'number'
            ? shortcutOrIndex
            : this._labelTaxonomy.findIndex((t) => t.shortcut === String(shortcutOrIndex));
        if (index < 0 || index >= this._labelTaxonomy.length) return false;
        const tax = this._labelTaxonomy[index];

        const next = this._normalizeLinkedLabel({
            ...current,
            id: key,
            label: tax.name,
            species: tax.name,
            color: tax.color || current.color,
        });
        this._linkedLabels.set(key, next);
        this._activeLabelId = key;
        this._syncLinkedLabelsToLayers();
        this._emit('labeltaxonomyapply', { id: key, taxonomy: { ...tax } });
        return true;
    }
    /**
     * Inject a pre-computed spectrogram as raw data (Float32Array or base64-encoded).
     * The player applies its own colorization pipeline (contrast, color map).
     *
     * @param {Float32Array|ArrayBuffer|string} data - spectrogram values.
     *   If string, decoded as base64 → Float32 (little-endian).
     * @param {number} nFrames - number of time frames
     * @param {number} nMels   - number of frequency bins
     * @param {Object} [options]
     * @param {string} [options.mode='mel'] - 'mel'|'linear' (affects freq axis labels)
     * @param {number} [options.sampleRate]   - sample rate for freq labels (default: from audio)
     */
    async setSpectrogramData(data: Float32Array | ArrayBuffer | string, nFrames: number, nMels: number, options: Record<string, unknown> = {}) {
        await this.ready;
        return this._state?._spectro.setExternalData(data, nFrames, nMels, options);
    }

    /**
     * Inject a pre-rendered spectrogram image (bypasses all DSP + colorization).
     *
     * @param {string|HTMLImageElement|HTMLCanvasElement} image - base64 data-URL,
     *   regular URL, or an already-loaded Image/Canvas element.
     * @param {Object} [options]
     * @param {number}   [options.sampleRate]  - sample rate for frequency axis labels
     * @param {number[]} [options.freqRange]   - [fMin, fMax] in Hz the image covers
     * @param {string}   [options.freqScale]   - frequency axis mapping: 'linear' | 'mel' | 'log'
     */
    async setSpectrogramImage(image: string | HTMLImageElement | HTMLCanvasElement, options: Record<string, unknown> = {}) {
        await this.ready;
        return this._state?._spectro.setExternalImage(image, options);
    }

    /**
     * Clear any externally-injected spectrogram and re-enable auto-compute.
     */
    async clearExternalSpectrogram() {
        await this.ready;
        if (!this._state) return;
        this._state._spectro.clearExternalMode();
        this._state._spectro.setDspControlsEnabled(true);
        if (this._state.audioBuffer) this._state._spectro.generate();
    }

    /**
     * Update follow-mode / viewport config at runtime (same keys as constructor options).
     * @param {Partial<{followGuardLeftRatio: number, followGuardRightRatio: number, followTargetRatio: number,
     *   followCatchupDurationMs: number, followCatchupSeekDurationMs: number,
     *   smoothLerp: number, smoothSeekLerp: number, smoothMinStepRatio: number,
     *   smoothSeekMinStepRatio: number, smoothSeekFocusMs: number}>} [config]
     * @returns {object | null}
     */
    setPlaybackViewportConfig(config = {}) {
        return this._state?.updatePlaybackViewportConfig?.(config) || null;
    }

    /** @returns {object | null} */
    getPlaybackViewportConfig() {
        return this._state?.getPlaybackViewportConfig?.() || null;
    }

    /** Notify the player that its container was resized externally. */
    resize() {
        const s = this._state;
        if (!s) return;
        s._queueCompactToolbarLayoutRefresh?.();
        if (!s.audioBuffer) return;
        s._drawMainWaveform();
        s._drawOverviewWaveform();
        s._syncOverviewWindowToViewport();
        if (s._spectro.hasData) s._drawSpectrogram();
        s._emit('viewresize', {
            waveformHeight: s.waveformDisplayHeight,
            spectrogramHeight: s.spectrogramDisplayHeight,
        });
    }

    /** Tear down the player and free resources */
    destroy() {
        if (this._globalKeyHandler) {
            document.removeEventListener('keydown', this._globalKeyHandler, true);
            this._globalKeyHandler = null;
        }
        if (this._onLabelFocus) {
            this.annotations.removeEventListener('labelfocus', this._onLabelFocus);
            this.spectrogramLabels.removeEventListener('labelfocus', this._onLabelFocus);
            this._onLabelFocus = null;
        }
        this.annotations.detach();
        this.spectrogramLabels.detach();
        this._state?.dispose();
        this._state = null;
        this.container.innerHTML = '';
    }

    _bindLinkedLabelSync() {
        // Helper: listen on a layer and re-emit to the public bus so external
        // consumers of player.on('annotationcreate', ...) still work unchanged.
        const fwd = (layer: EventTarget, event: string, handler: (ce: CustomEvent) => void) => {
            const cb = (e: Event) => {
                const ce = /** @type {CustomEvent} */ (e as CustomEvent);
                handler(ce);
                this._emit(event, ce.detail);
            };
            layer.addEventListener(event, cb as EventListener);
            // Store for cleanup in detach() if needed (layers call detach on their own)
        };

        // Forward raw layer DOM events onto the shared EventBus so all sources
        // (layers, overview segments, labels tab, external callers) go through
        // a single unified handler below.
        const onLabelFocus = (e: Event) => {
            const ce = /** @type {CustomEvent} */ (e as CustomEvent);
            this._emit('labelfocus', ce.detail);
        };
        this._onLabelFocus = onLabelFocus;
        this.annotations.addEventListener('labelfocus', onLabelFocus);
        this.spectrogramLabels.addEventListener('labelfocus', onLabelFocus);

        // Unified handler — fires for every source (layers, overview, list, external).
        this.on('labelfocus', (e: any) => {
            const id = String(e?.detail?.id || '').trim() || null;
            const interaction = e?.detail?.interaction;
            if (interaction === 'click' || interaction === 'ctrl-click') {
                this._activeLabelId = id;
                this.setSelectedOverviewSegment(id);
            } else {
                // Hover: only update when nothing is sticky-clicked yet, or when clearing.
                if (!this._activeLabelId || id === null) this._activeLabelId = id;
                this.setFocusedOverviewSegment(id);
            }
        });

        // Annotation layer events
        fwd(this.annotations, 'annotationpreview', (ce: CustomEvent) => this._previewFromLayer('annotation', (ce.detail as any).annotation));
        fwd(this.annotations, 'annotationcreate', (ce: CustomEvent) => this._upsertFromLayer('annotation', (ce.detail as any).annotation));
        fwd(this.annotations, 'annotationupdate', (ce: CustomEvent) => this._upsertFromLayer('annotation', (ce.detail as any).annotation));
        fwd(this.annotations, 'annotationremove', (ce: CustomEvent) => this._removeFromLinkedLabels((ce.detail as any).annotation));

        // Spectrogram label layer events
        fwd(this.spectrogramLabels, 'spectrogramlabelpreview', (ce: CustomEvent) => this._previewFromLayer('spectrogram', (ce.detail as any).label));
        fwd(this.spectrogramLabels, 'spectrogramlabelcreate', (ce: CustomEvent) => this._upsertFromLayer('spectrogram', (ce.detail as any).label));
        fwd(this.spectrogramLabels, 'spectrogramlabelupdate', (ce: CustomEvent) => this._upsertFromLayer('spectrogram', (ce.detail as any).label));
        fwd(this.spectrogramLabels, 'spectrogramlabelremove', (ce: CustomEvent) => this._removeFromLinkedLabels((ce.detail as any).label));

        // stampmodechange comes from SpectrogramLabelLayer
        this.spectrogramLabels.addEventListener('stampmodechange', (e: Event) => {
            const ce = /** @type {CustomEvent} */ (e as CustomEvent);
            const on = ce.detail?.active ?? false;
            if (this._stampBtn) this._stampBtn.classList.toggle('active', on);
            this.root?.classList.toggle('stamp-mode-active', on);
            if (!on) this.spectrogramLabels._stampAxisLock = false;
            this._emit('stampmodechange', ce.detail);
        });

        // Tag events forwarded from LabelEditorModal via the layer
        const fwdTag = (layer: EventTarget) => {
            for (const ev of ['tagcustomadd', 'tagcustomremove', 'tagcustomrename']) {
                layer.addEventListener(ev, (e: Event) => this._emit(ev, /** @type {CustomEvent} */ ((e as CustomEvent).detail)));
            }
        };
        fwdTag(this.annotations);
        fwdTag(this.spectrogramLabels);
    }

    _bindGlobalHotkeys() {
        this._globalKeyHandler = (event: KeyboardEvent) => {
            const targetEl = event.target as Element | null;
            const tag = targetEl?.tagName?.toLowerCase?.() || '';
            const typing = tag === 'input' || tag === 'textarea' || (targetEl as HTMLElement)?.isContentEditable;
            if (typing) return;
            const key = String((event as KeyboardEvent).key || '');
            const ctrl = (event as KeyboardEvent).ctrlKey || (event as KeyboardEvent).metaKey;

            // Ctrl+C — copy focused label
            if (ctrl && key === 'c' && this._activeLabelId) {
                event.preventDefault();
                this.spectrogramLabels?.copyLabel(this._activeLabelId);
                return;
            }
            // Ctrl+Z — undo
            if (ctrl && key === 'z') {
                event.preventDefault();
                this.undo();
                return;
            }
            // Ctrl+Y / Ctrl+Shift+Z — redo
            if (ctrl && (key === 'y' || (key === 'Z' && event.shiftKey))) {
                event.preventDefault();
                this.redo();
                return;
            }
            // Ctrl+V — paste at current playhead position
            if (ctrl && key === 'v') {
                event.preventDefault();
                const pasted = this.spectrogramLabels?.pasteLabel();
                if (pasted) this._emit?.('spectrogramlabelcreate', { label: { ...pasted } });
                return;
            }
            // Ctrl+D — toggle stamp mode
            if (ctrl && key === 'd') {
                event.preventDefault();
                if (this.spectrogramLabels?.stampMode) {
                    // turning off — use exitStampMode which cleans up ghost+axis lock
                    this.spectrogramLabels.exitStampMode();
                } else {
                    if (this.spectrogramLabels) {
                        this.spectrogramLabels.stampMode = true;
                        // Capture the currently hovered/focused label as stamp reference
                        if (this._activeLabelId) {
                            this.spectrogramLabels._stampRefLabelId = this._activeLabelId;
                        }
                        // mutual exclusion with draw mode
                        this.spectrogramLabels.drawMode = false;
                        this.root?.classList.remove('draw-mode-active');
                        if (this._drawBtn) this._drawBtn.classList.remove('active');
                    }
                    this.root?.classList.add('stamp-mode-active');
                    if (this._stampBtn) this._stampBtn.classList.add('active');
                }
                return;
            }

            if (!this._activeLabelId) return;

            // X deletes focused label — but only when NOT in stamp mode or grab
            // (in those modes, X is used for Blender-style axis constraint)
            const inAxisMode = this.spectrogramLabels?.stampMode
                || this.spectrogramLabels?._grabbing
                || this.spectrogramLabels?._editing;
            if (key === 'Delete' || key === 'Backspace' || (key === 'x' && !inAxisMode)) {
                event.preventDefault();
                const id = this._activeLabelId;
                // Try spectrogram labels first, then waveform annotations
                const sLabel = this.spectrogramLabels?.labels?.find((l: any) => l.id === id);
                if (sLabel) {
                    if (sLabel.readonly || this.spectrogramLabels?._lockedIds?.has(id)) return;
                    this.spectrogramLabels.remove(id);
                    this.spectrogramLabels.dispatchEvent(new CustomEvent('spectrogramlabelremove', { detail: { label: { ...sLabel } } }));
                } else {
                    const ann = this.annotations?.annotations?.find((a: any) => a.id === id);
                    if (ann) {
                        if (ann.readonly || this.annotations?._lockedIds?.has(id)) return;
                        this.annotations.remove(id);
                        this.annotations.dispatchEvent(new CustomEvent('annotationremove', { detail: { annotation: { ...ann } } }));
                    }
                }
                this._activeLabelId = null;
                return;
            }
            if (key === 'g') {
                event.preventDefault();
                // Try spectrogram labels first, then waveform annotations
                const sLabel = this.spectrogramLabels?.labels?.find((l: any) => l.id === this._activeLabelId);
                if (sLabel) {
                    this.spectrogramLabels.startGrab(this._activeLabelId);
                } else {
                    this.annotations?.startGrab(this._activeLabelId);
                }
                return;
            }
            if (!/^[1-9]$/.test(key)) return;
            const idx = Number(key) - 1;
            if (idx >= this._labelTaxonomy.length) return;
            event.preventDefault();
            const activeId = this._activeLabelId;
            const activeSLabel = this.spectrogramLabels?.labels?.find((l: any) => l.id === activeId);
            const activeAnn = !activeSLabel && this.annotations?.annotations?.find((a: any) => a.id === activeId);
            const isLockedActive = activeSLabel
                ? (activeSLabel.readonly || this.spectrogramLabels?._lockedIds?.has(activeId))
                : (activeAnn?.readonly || this.annotations?._lockedIds?.has(activeId));
            if (isLockedActive) return;
            this.applyTaxonomyToLabel(activeId, idx);
        };
        document.addEventListener('keydown', this._globalKeyHandler, true);
    }

    // ── Annotation Toolbar ──────────────────────────────────────────

    _injectAnnotationToolbar() {
        const secondary = this.root?.querySelector('[data-aw="toolbarSecondary"]');
        if (!secondary) return;

        const sep = document.createElement('div');
        sep.className = 'toolbar-sep';
        secondary.appendChild(sep);

        // Draw mode toggle — enables click+drag label creation without Shift
        const drawBtn = document.createElement('button');
        drawBtn.className = 'toolbar-btn toggle-btn active';
        drawBtn.title = 'Draw label (Shift+Drag)';
        drawBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.375 2.625a1 1 0 013 3l-9.013 9.014a2 2 0 01-.853.505l-2.873.84a.5.5 0 01-.62-.62l.84-2.873a2 2 0 01.506-.852z"/></svg> Draw`;
        // keep a reference so keyboard toggles update it
        this._drawBtn = drawBtn;
        // Draw mode is on by default
        this.root?.classList.add('draw-mode-active');
        drawBtn.addEventListener('click', () => {
            const on = !this.spectrogramLabels.drawMode;
            this.spectrogramLabels.drawMode = on;
            // disable stamp mode when entering draw mode
            if (on && this.spectrogramLabels) {
                this.spectrogramLabels.exitStampMode();
            }
            drawBtn.classList.toggle('active', on);
            this.root?.classList.toggle('draw-mode-active', on);
        });
        secondary.appendChild(drawBtn);

        // Stamp mode toggle — click to stamp the last/focused label (Ctrl+D)
        const stampBtn = document.createElement('button');
        stampBtn.className = 'toolbar-btn toggle-btn';
        stampBtn.title = 'Stamp mode (Ctrl+D)';
        stampBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg> Stamp`;
        this._stampBtn = stampBtn;
        stampBtn.addEventListener('click', () => {
            if (this.spectrogramLabels.stampMode) {
                this.spectrogramLabels.exitStampMode();
            } else {
                this.spectrogramLabels.stampMode = true;
                // Capture the currently hovered/focused label as stamp reference
                if (this._activeLabelId) {
                    this.spectrogramLabels._stampRefLabelId = this._activeLabelId;
                }
                // disable draw mode when entering stamp mode
                this.spectrogramLabels.drawMode = false;
                if (this._drawBtn) this._drawBtn.classList.remove('active');
                this.root?.classList.remove('draw-mode-active');
                stampBtn.classList.add('active');
                this.root?.classList.add('stamp-mode-active');
            }
        });
        secondary.appendChild(stampBtn);
    }

    /** Public getter for current species bar selection. */
    getSpeciesBarSelection() {
        return this._speciesBarSelection ? { ...this._speciesBarSelection } : null;
    }

    /**
     * Programmatically set the species search bar (e.g. after loading XC recording).
     * @param {string} name
     * @param {{ color?: string, scientificName?: string }} [opts]
     */
    setSpeciesBar(name: string, opts: { color?: string; scientificName?: string } = {}) {
        const trimmed = (name || '').trim();
        this._speciesBarSelection = trimmed
            ? { name: trimmed, color: opts.color || colorForName(trimmed), scientificName: opts.scientificName || '' }
            : null;
        this._emit('speciesbarchange', { selection: this._speciesBarSelection ? { ...this._speciesBarSelection } : null });
    }

    /**
     * Set background species (XC "also" field) to appear in search suggestions.
     * @param {Array<string | { name: string, scientificName?: string }>} species
     */
    setBackgroundSpecies(species: Array<string | { name: string, scientificName?: string }>) {
        this._backgroundSpecies = (species || []).map((s: any) =>
            typeof s === 'string' ? { name: s, origin: 'background' } : { name: s.name || '', scientificName: s.scientificName || '', origin: 'background' },
        ).filter((s: any) => s.name);
    }
    /** @returns {Array<{name: string, scientificName?: string, origin: string}>} */
    getBackgroundSpecies() {
        return this._backgroundSpecies.map((s: { name: string; scientificName?: string; origin?: string }) => ({ ...s }));
    }

    /**
     * Live preview of an in-progress drag/resize — update _linkedLabels and
     * mirror the change into the OTHER layer so both views stay in sync.
     * @param {'annotation'|'spectrogram'} source
     * @param {object} item
     */
    _previewFromLayer(source: 'annotation'|'spectrogram', item: Partial<LinkedLabel>) {
        if (this._isSyncingLabels || !item) return;
        const id = (item as any).id || `lbl_${Math.random().toString(36).slice(2, 10)}`;
        const existing = this._linkedLabels.get(id);
        const next = this._normalizeItemFromSource(source, { ...(item as any), id }, existing ?? undefined);
        this._linkedLabels.set(id, next);
        this._state?.updateActiveSegmentFromLabel?.(next);
        if (source === 'annotation') {
            this.spectrogramLabels.setLiveLinkedId(id);
            this.spectrogramLabels.set(this._toSpectrogramLabelList());
        } else {
            this.annotations.setLiveLinkedId(id);
            this.annotations.set(this._toAnnotationList());
        }
        this._renderOverviewLabelTracks();
    }

    /**
     * Commit a create/update event — persist into _linkedLabels and sync both layers.
     * @param {'annotation'|'spectrogram'} source
     * @param {object} item
     */
    _upsertFromLayer(source: 'annotation'|'spectrogram', item: Partial<LinkedLabel>) {
        if (this._isSyncingLabels || !item) return;
        const id = (item as any).id || `lbl_${Math.random().toString(36).slice(2, 10)}`;
        const existing = this._linkedLabels.get(id);
        const next = this._normalizeItemFromSource(source, { ...(item as any), id }, existing ?? undefined);
        this._linkedLabels.set(id, next);
        this._state?.updateActiveSegmentFromLabel?.(next);
        this.annotations.setLiveLinkedId(null);
        this.spectrogramLabels.setLiveLinkedId(null);
        this._syncLinkedLabelsToLayers();
    }

    /**
     * Build the normalized label name from the source layer's field conventions.
     * - annotation layer: canonical name field is `species`
     * - spectrogram layer: canonical name field is `label`
     * @param {'annotation'|'spectrogram'} source
     * @param {object} item   item with .id already set
     * @param {object} [existing]
     */
    _normalizeItemFromSource(source: 'annotation'|'spectrogram', item: Partial<LinkedLabel> & { id: string }, existing?: LinkedLabel) {
        if (source === 'spectrogram') {
            const nextName = String((item as any)?.label || (item as any)?.species || existing?.label || existing?.species || 'Label').trim();
            return this._normalizeLinkedLabel({ ...existing, ...(item as any), species: nextName, label: nextName });
        }
        return this._normalizeLinkedLabel({
            ...existing, ...(item as any),
            label: (item as any)?.species ?? existing?.label ?? 'Label',
        });
    }

    _removeFromLinkedLabels(label: Partial<LinkedLabel> | null) {
        if (this._isSyncingLabels || !label?.id) return;
        this._linkedLabels.delete(label.id as string);
        if (this._activeLabelId === label.id) this._activeLabelId = null;
        this.annotations.setLiveLinkedId(null);
        this.spectrogramLabels.setLiveLinkedId(null);
        this._syncLinkedLabelsToLayers();
    }

    _syncLinkedLabelsToLayers() {
        // Push undo snapshot before applying the new state
        // (skip during restore, initial sync, or preview events)
        if (!this._isRestoring) {
            this._undoStack.push(this._snapshotLabels());
        }
        this._isSyncingLabels = true;
        try {
            this.annotations.set(this._toAnnotationList());
            this.spectrogramLabels.set(this._toSpectrogramLabelList());
            this._rebuildLabelLibrary();
            this._renderOverviewLabelTracks();
        } finally {
            this._isSyncingLabels = false;
        }
        this._emit('labelsync', {});
    }

    /** Create a deep snapshot of the current _linkedLabels for undo. */
    _snapshotLabels(): LinkedLabel[] {
        return Array.from(this._linkedLabels.values()).map((l) => ({ ...l, tags: { ...(l.tags || {}) } } as LinkedLabel));
    }

    /** Restore a snapshot from the undo stack. */
    _restoreSnapshot(snapshot: LinkedLabel[] | unknown) {
        if (!snapshot) return;
        this._isRestoring = true;
        this._linkedLabels.clear();
        for (const label of (snapshot as LinkedLabel[])) {
            this._linkedLabels.set(label.id, { ...label, tags: { ...(label.tags || {}) } });
        }
        if (this._activeLabelId && !this._linkedLabels.has(this._activeLabelId)) {
            this._activeLabelId = null;
        }
        this._syncLinkedLabelsToLayers();
        this._isRestoring = false;
        this._emit?.('undochange', { canUndo: this._undoStack.canUndo, canRedo: this._undoStack.canRedo });
    }

    /**
     * Undo the last operation (label mutation or DSP command).
     * @returns {boolean} true if anything was undone
     */
    undo() {
        if (!this._undoStack.canUndo) return false;
        const snapshot = this._undoStack.undo();
        if (snapshot !== null) this._restoreSnapshot(snapshot);
        // emit undochange regardless so UI can update canUndo/canRedo
        this._emit?.('undochange', { canUndo: this._undoStack.canUndo, canRedo: this._undoStack.canRedo });
        return true;
    }

    /**
     * Redo the last undone operation (label mutation or DSP command).
     * @returns {boolean} true if anything was redone
     */
    redo() {
        if (!this._undoStack.canRedo) return false;
        const snapshot = this._undoStack.redo();
        if (snapshot !== null) this._restoreSnapshot(snapshot);
        this._emit?.('undochange', { canUndo: this._undoStack.canUndo, canRedo: this._undoStack.canRedo });
        return true;
    }

    _rebuildLabelLibrary() {
        const next = new Map();
        for (const item of this._linkedLabels.values()) {
            const label = String(item?.label || item?.species || '').trim();
            if (!label) continue;
            next.set(label, (next.get(label) || 0) + 1);
        }
        this._labelLibrary = next;
    }

    /**
     * Highlight specific label segments in the overview tracks by id.
     * @param {string[]} ids
     */
    setMultiSelectedOverview(ids: string[]) {
        const container = this._state?.d?.overviewLabelTracks;
        if (!container) return;
        const set = new Set(ids);
        for (const el of container.querySelectorAll('.overview-label-segment')) {
            const h = /** @type {HTMLElement} */ (el);
            h.classList.toggle('multi-selected', set.has(h.dataset?.id || ''));
        }
    }

    setFocusedOverviewSegment(id: string | null) {
        const container = this._state?.d?.overviewLabelTracks;
        if (!container) return;
        for (const el of container.querySelectorAll('.overview-label-segment')) {
            const h = el as HTMLElement;
            h.classList.toggle('focused', !!id && h.dataset?.id === id);
        }
    }

    setSelectedOverviewSegment(id: string | null) {
        const container = this._state?.d?.overviewLabelTracks;
        if (!container) return;
        for (const el of container.querySelectorAll('.overview-label-segment')) {
            const h = el as HTMLElement;
            h.classList.toggle('selected', !!id && h.dataset?.id === id);
        }
    }

    /**
     * Render one row per unique label name below the overview bar,
     * grouped under compact origin headers (manual, BirdNET, xeno-canto).
     */
    _renderOverviewLabelTracks() {
        const container = this._state?.d?.overviewLabelTracks;
        if (!container) return;
        const duration = this._state?.audioBuffer?.duration || 0;
        const prevRowCount = container.childElementCount;
        if (duration <= 0) { container.innerHTML = ''; this._afterOverviewRowChange(prevRowCount, 0); return; }

        // Two-level grouping: origin → label name
        const originGroups: Map<string, Map<string, { color: string; segments: { id: string; start: number; end: number }[] }>> = new Map();
        for (const item of this._linkedLabels.values()) {
            const origin = String(item?.origin || 'manual').trim() || 'manual';
            const name = String(item?.label || item?.species || '').trim();
            if (!name) continue;

            if (!originGroups.has(origin)) originGroups.set(origin, new Map());
            const nameMap = originGroups.get(origin)! as Map<string, { color: string; segments: { id: string; start: number; end: number }[] }>;

            if (!nameMap.has(name)) nameMap.set(name, { color: item.color || '', segments: [] });
            const g = nameMap.get(name)!;
            if (!g.color && item.color) g.color = item.color;
            g.segments.push({ id: item.id || '', start: item.start, end: item.end });
        }

        if (originGroups.size === 0) { container.innerHTML = ''; this._afterOverviewRowChange(prevRowCount, 0); return; }

        // Sort origins: manual → BirdNET → xeno-canto → alphabetical
        const ORDER: Record<string, number> = { manual: 0, BirdNET: 1, 'xeno-canto': 2 };
        const sortedOrigins = [...originGroups.entries()].sort((a, b) =>
            (ORDER[a[0]] ?? 99) - (ORDER[b[0]] ?? 99) || a[0].localeCompare(b[0]));

        container.innerHTML = '';
        for (const [origin, nameMap] of sortedOrigins) {
            // Origin group header (compact strip)
            const header = document.createElement('div');
            header.className = 'overview-label-group-header';
            header.textContent = origin;
            container.appendChild(header);

            // Label rows sorted alphabetically within origin
            const sortedNames = [...nameMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
            for (const [name, { color, segments }] of sortedNames) {
                const row = document.createElement('div');
                row.className = 'overview-label-row';
                row.title = name;
                if (color) {
                    const rgb = parseColorToRgb(color);
                    if (rgb) {
                        row.style.setProperty('--label-tint', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.35)`);
                    }
                }

                const nameEl = document.createElement('span');
                nameEl.className = 'overview-label-row-name';
                nameEl.textContent = name;
                row.appendChild(nameEl);

                const track = document.createElement('div');
                track.className = 'overview-label-row-track';
                for (const seg of segments) {
                    const s = document.createElement('span');
                    s.className = 'overview-label-segment';
                    s.dataset.start = String(seg.start);
                    s.dataset.end = String(seg.end);
                    s.dataset.id = seg.id || '';
                    const leftPct = (seg.start / duration) * 100;
                    const widthPct = ((seg.end - seg.start) / duration) * 100;
                    s.style.left = `${leftPct}%`;
                    s.style.width = `${Math.max(0.3, widthPct)}%`;
                    s.addEventListener('pointerenter', () => {
                        this._emit?.('labelfocus', { id: seg.id || null, source: 'overview', interaction: 'hover' });
                    });
                    s.addEventListener('pointerleave', () => {
                        this._emit?.('labelfocus', { id: null, source: 'overview', interaction: 'hover' });
                    });
                    s.addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (e.ctrlKey || e.metaKey) {
                            this._emit?.('labelfocus', { id: seg.id || null, source: 'overview', interaction: 'ctrl-click' });
                            return;
                        }
                        const midTime = (seg.start + seg.end) / 2;
                        this._state?._seekToTime(midTime, true);
                        this._emit?.('labelfocus', { id: seg.id || null, source: 'overview', interaction: 'click' });
                    });
                    track.appendChild(s);
                }
                row.appendChild(track);
                container.appendChild(row);
            }
        }
        this._afterOverviewRowChange(prevRowCount, container.childElementCount);
        // Restore focus/selection state lost by DOM rebuild
        this.setFocusedOverviewSegment(this._activeLabelId);
        this.setSelectedOverviewSegment(this._activeLabelId);
    }

    /**
     * When the overview label track row count changes, the spectrogram container
     * shrinks/grows (flexbox). Schedule a resize-aware redraw so canvas, coords,
     * AND label overlay layers all stay in sync.
     */
    _afterOverviewRowChange(prevCount: unknown, nextCount: unknown) {
        if (prevCount !== nextCount) {
            this._state?._queueResizeRedraw({ redrawSpectrogram: true });
        }
    }

    /**
     * Normalize taxonomy array into internal compact shape.
     * @param {Array<{name: string, color?: string, shortcut?: string}>} taxonomy
     * @returns {Array<{name: string, color: string, shortcut: string}>}
     */
    _normalizeTaxonomy(taxonomy: any[]) {
        const used = new Set();
        const list = [];
        for (const item of taxonomy || []) {
            const name = String(item?.name || '').trim();
            if (!name) continue;
            const shortcut = String(item?.shortcut || '').trim();
            const normalizedShortcut = /^[1-9]$/.test(shortcut) && !used.has(shortcut) ? shortcut : '';
            if (normalizedShortcut) used.add(normalizedShortcut);
            list.push({
                name,
                color: item?.color ? String(item.color) : '',
                shortcut: normalizedShortcut,
            });
            if (list.length >= 9) break;
        }
        return list;
    }

    _toAnnotationList() {
        return Array.from(this._linkedLabels.values()).map((l) => ({
            id: l.id,
            start: l.start,
            end: l.end,
            species: l.species || l.label || '',
            confidence: l.confidence,
            color: l.color,
            scientificName: l.scientificName || '',
            commonName: l.commonName || '',
            origin: l.origin || '',
            author: l.author || '',
            tags: l.tags || {},
        }));
    }

    _toSpectrogramLabelList() {
        return Array.from(this._linkedLabels.values()).map((l) => ({
            id: l.id,
            start: l.start,
            end: l.end,
            freqMin: l.freqMin,
            freqMax: l.freqMax,
            label: l.label || l.species || '',
            color: l.color,
            scientificName: l.scientificName || '',
            commonName: l.commonName || '',
            origin: l.origin || '',
            author: l.author || '',
            tags: l.tags || {},
        }));
    }

    _normalizeLinkedLabel(label: Partial<LinkedLabel>) {
        const duration = Math.max(0.001, this.duration || this._state?.audioBuffer?.duration || 0.001);
        const nyquist = (this._state?.sampleRateHz || DEFAULT_SAMPLE_RATE) / 2;
        const selected = parseFloat(this._state?.d?.maxFreqSelect?.value || `${nyquist}`);
        const maxFreq = clamp(selected, 1, nyquist);

        const start = clamp(Number(label?.start ?? 0), 0, duration);
        const end = clamp(Number(label?.end ?? start + 0.01), start + 0.01, duration);
        const freqMin = clamp(Number(label?.freqMin ?? 0), 0, maxFreq);
        const freqMax = clamp(Number(label?.freqMax ?? maxFreq), freqMin + 1, maxFreq);

        const meta = normalizeLabelStrings(label as any);
        const tax = meta.label
            ? this._labelTaxonomy.find((t) => t.name.toLowerCase() === meta.label.toLowerCase())
            : null;

        return {
            id: label?.id || `lbl_${Math.random().toString(36).slice(2, 10)}`,
            start,
            end,
            freqMin,
            freqMax,
            species: meta.species,
            label: meta.label,
            confidence: label?.confidence,
            color: meta.color || tax?.color || colorForName(meta.label),
            scientificName: meta.scientificName,
            commonName: meta.commonName,
            origin: meta.origin,
            author: meta.author,
            tags: meta.tags,
        };
    }
}
