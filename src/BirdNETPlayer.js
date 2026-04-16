// ═══════════════════════════════════════════════════════════════════════
// BirdNETPlayer.js - Public API for the BirdNET Audio Player module
//
// Usage:
//   import { BirdNETPlayer } from './BirdNETPlayer.js';
//   const player = new BirdNETPlayer(document.getElementById('root'));
//   await player.ready;
//   await player.loadUrl('https://example.com/audio.wav');
//   player.play();
// ═══════════════════════════════════════════════════════════════════════

import { createPlayerHTML, DEFAULT_OPTIONS } from './template.js';
import { DEFAULT_SAMPLE_RATE } from './constants.js';
import { clamp } from './utils.js';
import { PlayerState } from './PlayerState.js';
import { AnnotationLayer, SpectrogramLabelLayer, colorForName } from './annotations.js';
import { UndoStack } from './undoStack.js';
import './styles/main.scss';  // Vite compiles SCSS and extracts into birdnet-player.css

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
} from './xenoCantoApi.js';
export {
    DEFAULT_XC_RECORDINGS_ENDPOINT,
    normalizeXcId,
    getRecordingScientificName,
    fetchXenoCantoRecording,
    extractXenoCantoRawLabels,
    mapXenoCantoLabelsToSpectrogram,
    importXenoCantoSpectrogramLabels,
} from './xenoCantoRecordingsApi.js';
export { TaxonomyResolver } from './taxonomyResolver.js';
export { BirdNETInference, BIRDNET_MODEL_URL } from './birdnetInference.js';

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
    constructor(container, options = {}) {
        if (!container) throw new Error('BirdNETPlayer: container element required');
        this.container = container;
        this.options = options;
        /** @type {PlayerState | null} */
        this._state = null;
        this._events = new EventTarget();
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
        /** @type {Array<{ name: string, scientificName?: string }>} */
        this._backgroundSpecies = [];
        /** @type {{ name: string, color: string, scientificName: string } | null} */
        this._speciesBarSelection = null;

        this.on = (event, callback, options) => {
            this._events.addEventListener(event, callback, options);
            return () => this.off(event, callback, options);
        };

        this.off = (event, callback, options) => {
            this._events.removeEventListener(event, callback, options);
        };

        this.ready = this._init();
    }

    // ── Initialization ──────────────────────────────────────────────

    async _init() {
        // 1. Inject player DOM (pass options for section visibility)
        this.container.innerHTML = createPlayerHTML(this.options);
        this.root = /** @type {HTMLElement} */ (this.container.querySelector('.daw-shell'));

        // 2. Resolve WaveSurfer (option → global → CDN import)
        const WaveSurfer = this.options.WaveSurfer
            || /** @type {any} */ (window).WaveSurfer
            || (await import(/* @vite-ignore */ WAVESURFER_CDN)).default;

        // 3. Create internal state machine
        this._state = new PlayerState(
            this.root,
            WaveSurfer,
            (event, detail) => this._emit(event, detail),
            this.options,
        );
        this.annotations.attach(this);
        this.spectrogramLabels.attach(this);
        this._bindLinkedLabelSync();
        this._bindGlobalHotkeys();
        this._injectAnnotationToolbar();
        // Sync stamp button when stamp mode exits from inside the label layer
        this.on('stampmodechange', (e) => {
            const on = e?.detail?.active ?? false;
            if (this._stampBtn) this._stampBtn.classList.toggle('active', on);
            this.root?.classList.toggle('stamp-mode-active', on);
            if (!on) this.spectrogramLabels._stampAxisLock = false;
        });
        this._emit('ready', { phase: 'init' });
        return this;
    }

    _emit(event, detail = {}) {
        this._events.dispatchEvent(new CustomEvent(event, { detail }));
    }

    // ── Public API ──────────────────────────────────────────────────

    /** Load audio from a URL (http, blob:, data: URLs all supported) */
    async loadUrl(url) {
        await this.ready;
        return this._state?.loadUrl(url);
    }

    /** Load audio from a File object (e.g. from an <input type="file">) */
    async loadFile(file) {
        await this.ready;
        return this._state?._handleFileSelect({ target: { files: [file] } });
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
    playSegment(startSec, endSec, options) { this._state?.playSegment(startSec, endSec, options); }
    playBandpassedSegment(startSec, endSec, freqMinHz, freqMaxHz, options) {
        this._state?.playBandpassedSegment(startSec, endSec, freqMinHz, freqMaxHz, options);
    }
    addAnnotation(annotation) {
        const id = annotation?.id || `lbl_${Math.random().toString(36).slice(2, 10)}`;
        const existing = this._linkedLabels.get(id);
        const merged = this._normalizeLinkedLabel({
            ...existing,
            ...annotation,
            id,
            label: annotation?.label ?? annotation?.species ?? existing?.label ?? 'Label',
        });
        this._linkedLabels.set(id, merged);
        this._syncLinkedLabelsToLayers();
        return id;
    }
    setAnnotations(annotations) {
        const next = new Map();
        for (const ann of annotations || []) {
            const id = ann?.id || `lbl_${Math.random().toString(36).slice(2, 10)}`;
            const existing = this._linkedLabels.get(id);
            next.set(id, this._normalizeLinkedLabel({
                ...existing,
                ...ann,
                id,
                label: ann?.label ?? ann?.species ?? existing?.label ?? 'Label',
            }));
        }
        this._linkedLabels = next;
        this._syncLinkedLabelsToLayers();
    }
    clearAnnotations() {
        this._linkedLabels.clear();
        this._syncLinkedLabelsToLayers();
    }
    exportAnnotationsRaven() {
        return this.annotations.exportRavenFormat(this._toAnnotationList());
    }
    addSpectrogramLabel(label) {
        const id = label?.id || `lbl_${Math.random().toString(36).slice(2, 10)}`;
        const existing = this._linkedLabels.get(id);
        const merged = this._normalizeLinkedLabel({
            ...existing,
            ...label,
            id,
            species: label?.species ?? label?.label ?? existing?.species ?? '',
            label: label?.label ?? existing?.label ?? label?.species ?? 'Label',
        });
        this._linkedLabels.set(id, merged);
        this._syncLinkedLabelsToLayers();
        return id;
    }
    setSpectrogramLabels(labels) {
        const next = new Map();
        for (const lbl of labels || []) {
            const id = lbl?.id || `lbl_${Math.random().toString(36).slice(2, 10)}`;
            const existing = this._linkedLabels.get(id);
            next.set(id, this._normalizeLinkedLabel({
                ...existing,
                ...lbl,
                id,
                species: lbl?.species ?? lbl?.label ?? existing?.species ?? '',
                label: lbl?.label ?? existing?.label ?? lbl?.species ?? 'Label',
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
    renameLabel(id, name) {
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
    getLabelSuggestions(prefix = '', limit = 10) {
        const q = String(prefix || '').trim().toLowerCase();
        const ranked = Array.from(this._labelLibrary.entries())
            .filter(([name]) => !q || name.toLowerCase().includes(q))
            .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
            .slice(0, Math.max(1, limit))
            .map(([name]) => name);
        return ranked;
    }
    setLabelSuggestionProvider(provider = null) {
        this._labelSuggestionProvider = typeof provider === 'function' ? provider : null;
    }
    setLabelEditorSuggestionMode(mode = 'merge') {
        const m = String(mode || '').trim().toLowerCase();
        this._labelEditorSuggestionMode = (m === 'custom-only') ? 'custom-only' : 'merge';
    }
    getLabelEditorSuggestionMode() {
        return this._labelEditorSuggestionMode || 'merge';
    }
    getLabelEditorSuggestions(query = '', limit = 12) {
        if (!this._labelSuggestionProvider) return [];
        try {
            const out = this._labelSuggestionProvider(String(query || ''), Math.max(1, Number(limit) || 12));
            if (!Array.isArray(out)) return [];
            return out
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
                .filter(Boolean);
        } catch {
            return [];
        }
    }
    getLabelTaxonomy() {
        return this._labelTaxonomy.map((item) => ({ ...item }));
    }
    setLabelTaxonomy(taxonomy = []) {
        this._labelTaxonomy = this._normalizeTaxonomy(taxonomy);
        this._syncLinkedLabelsToLayers();
    }

    /**
     * Override or extend the tag presets shown in the label editor dialog.
     * Each entry: { key, label, options: string[] }
     * @param {Array<{ key: string, label?: string, options: string[] }>} presets
     */
    setTagPresets(presets) {
        this._tagPresets = (presets || []).map((p) => ({
            key: String(p.key || ''),
            label: String(p.label || p.key || ''),
            options: Array.isArray(p.options) ? p.options.map(String) : [],
        })).filter((p) => p.key);
    }
    getTagPresets() {
        return this._tagPresets ? this._tagPresets.map((p) => ({ ...p, options: p.options.slice() })) : null;
    }

    applyTaxonomyToLabel(id, shortcutOrIndex) {
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
    async setSpectrogramData(data, nFrames, nMels, options = {}) {
        await this.ready;
        return this._state?._setExternalSpectrogram(data, nFrames, nMels, options);
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
    async setSpectrogramImage(image, options = {}) {
        await this.ready;
        return this._state?._setExternalSpectrogramImage(image, options);
    }

    /**
     * Clear any externally-injected spectrogram and re-enable auto-compute.
     */
    async clearExternalSpectrogram() {
        await this.ready;
        if (!this._state) return;
        this._state._externalSpectrogram = false;
        this._state._externalImageConfig = null;
        this._state._setDspControlsEnabled(true);
        if (this._state.audioBuffer) this._state._generateSpectrogram();
    }

    setPlaybackViewportConfig(config = {}) {
        return this._state?.updatePlaybackViewportConfig?.(config) || null;
    }
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
        if (s.spectrogramData && s.spectrogramFrames > 0) s._drawSpectrogram();
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
        this.annotations.detach();
        this.spectrogramLabels.detach();
        this._state?.dispose();
        this._state = null;
        this.container.innerHTML = '';
    }

    _bindLinkedLabelSync() {
        this.on('labelfocus', (e) => {
            const id = String(e?.detail?.id || '').trim() || null;
            const interaction = e?.detail?.interaction;
            if (interaction === 'click') {
                // Sticky selection — hotkeys operate on this label
                this._activeLabelId = id;
            } else {
                // Transient hover — only update if not currently selected,
                // so hovering over a different label doesn't steal hotkeys
                // from an explicitly selected one.
                if (!this._activeLabelId || id === null) {
                    this._activeLabelId = id;
                }
            }
        });
        this.on('annotationpreview', (e) => this._previewFromAnnotationEvent(e.detail.annotation));
        this.on('spectrogramlabelpreview', (e) => this._previewFromSpectrogramEvent(e.detail.label));
        this.on('annotationcreate', (e) => this._upsertFromAnnotationEvent(e.detail.annotation));
        this.on('annotationupdate', (e) => this._upsertFromAnnotationEvent(e.detail.annotation));
        this.on('spectrogramlabelcreate', (e) => this._upsertFromSpectrogramEvent(e.detail.label));
        this.on('spectrogramlabelupdate', (e) => this._upsertFromSpectrogramEvent(e.detail.label));
        this.on('spectrogramlabelremove', (e) => this._removeFromLinkedLabels(e.detail.label));
        this.on('annotationremove', (e) => this._removeFromLinkedLabels(e.detail.annotation));
    }

    _bindGlobalHotkeys() {
        this._globalKeyHandler = (event) => {
            const tag = event?.target?.tagName?.toLowerCase?.() || '';
            const typing = tag === 'input' || tag === 'textarea' || event?.target?.isContentEditable;
            if (typing) return;
            const key = String(event.key || '');
            const ctrl = event.ctrlKey || event.metaKey;

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
                const sLabel = this.spectrogramLabels?.labels?.find((l) => l.id === id);
                if (sLabel) {
                    this.spectrogramLabels.remove(id);
                    this._emit?.('spectrogramlabelremove', { label: { ...sLabel } });
                } else {
                    const ann = this.annotations?.annotations?.find((a) => a.id === id);
                    if (ann) {
                        this.annotations.remove(id);
                        this._emit?.('annotationremove', { annotation: { ...ann } });
                    }
                }
                this._activeLabelId = null;
                return;
            }
            if (key === 'g') {
                event.preventDefault();
                // Try spectrogram labels first, then waveform annotations
                const sLabel = this.spectrogramLabels?.labels?.find((l) => l.id === this._activeLabelId);
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
            this.applyTaxonomyToLabel(this._activeLabelId, idx);
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
    setSpeciesBar(name, opts = {}) {
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
    setBackgroundSpecies(species) {
        this._backgroundSpecies = (species || []).map((s) =>
            typeof s === 'string' ? { name: s } : { name: s.name || '', scientificName: s.scientificName || '' },
        ).filter((s) => s.name);
    }

    _previewFromAnnotationEvent(annotation) {
        if (this._isSyncingLabels || !annotation) return;
        const id = annotation.id || `lbl_${Math.random().toString(36).slice(2, 10)}`;
        const existing = this._linkedLabels.get(id);
        const next = this._normalizeLinkedLabel({
            ...existing,
            ...annotation,
            id,
            label: annotation?.species ?? existing?.label ?? 'Label',
        });
        this._linkedLabels.set(id, next);
        this._state?.updateActiveSegmentFromLabel?.(next);
        this.spectrogramLabels.setLiveLinkedId(id);
        this.spectrogramLabels.set(this._toSpectrogramLabelList());
    }

    _previewFromSpectrogramEvent(label) {
        if (this._isSyncingLabels || !label) return;
        const id = label.id || `lbl_${Math.random().toString(36).slice(2, 10)}`;
        const existing = this._linkedLabels.get(id);
        const nextName = String(label?.label || label?.species || existing?.label || existing?.species || 'Label').trim();
        const next = this._normalizeLinkedLabel({
            ...existing,
            ...label,
            id,
            species: nextName,
            label: nextName,
        });
        this._linkedLabels.set(id, next);
        this._state?.updateActiveSegmentFromLabel?.(next);
        this.annotations.setLiveLinkedId(id);
        this.annotations.set(this._toAnnotationList());
    }

    _upsertFromAnnotationEvent(annotation) {
        if (this._isSyncingLabels || !annotation) return;
        const id = annotation.id || `lbl_${Math.random().toString(36).slice(2, 10)}`;
        const existing = this._linkedLabels.get(id);
        const next = this._normalizeLinkedLabel({
            ...existing,
            ...annotation,
            id,
            label: annotation?.species ?? existing?.label ?? 'Label',
        });
        this._linkedLabels.set(id, next);
        this._state?.updateActiveSegmentFromLabel?.(next);
        this.annotations.setLiveLinkedId(null);
        this.spectrogramLabels.setLiveLinkedId(null);
        this._syncLinkedLabelsToLayers();
    }

    _removeFromLinkedLabels(label) {
        if (this._isSyncingLabels || !label?.id) return;
        this._linkedLabels.delete(label.id);
        this.annotations.setLiveLinkedId(null);
        this.spectrogramLabels.setLiveLinkedId(null);
        this._syncLinkedLabelsToLayers();
    }

    _upsertFromSpectrogramEvent(label) {
        if (this._isSyncingLabels || !label) return;
        const id = label.id || `lbl_${Math.random().toString(36).slice(2, 10)}`;
        const existing = this._linkedLabels.get(id);
        const nextName = String(label?.label || label?.species || existing?.label || existing?.species || 'Label').trim();
        const next = this._normalizeLinkedLabel({
            ...existing,
            ...label,
            id,
            species: nextName,
            label: nextName,
        });
        this._linkedLabels.set(id, next);
        this._state?.updateActiveSegmentFromLabel?.(next);
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
    _snapshotLabels() {
        return Array.from(this._linkedLabels.values()).map((l) => ({ ...l, tags: { ...l.tags } }));
    }

    /** Restore a snapshot from the undo stack. */
    _restoreSnapshot(snapshot) {
        if (!snapshot) return;
        this._isRestoring = true;
        this._linkedLabels.clear();
        for (const label of snapshot) {
            this._linkedLabels.set(label.id, { ...label, tags: { ...label.tags } });
        }
        this._syncLinkedLabelsToLayers();
        this._isRestoring = false;
        this._emit?.('undochange', { canUndo: this._undoStack.canUndo, canRedo: this._undoStack.canRedo });
    }

    /** Undo the last label mutation. */
    undo() {
        const snapshot = this._undoStack.undo();
        if (snapshot) this._restoreSnapshot(snapshot);
        return !!snapshot;
    }

    /** Redo the last undone label mutation. */
    redo() {
        const snapshot = this._undoStack.redo();
        if (snapshot) this._restoreSnapshot(snapshot);
        return !!snapshot;
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

    setMultiSelectedOverview(ids) {
        const container = this._state?.d?.overviewLabelTracks;
        if (!container) return;
        const set = new Set(ids);
        for (const el of container.querySelectorAll('.overview-label-segment')) {
            const h = /** @type {HTMLElement} */ (el);
            h.classList.toggle('multi-selected', set.has(h.dataset?.id || ''));
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
        /** @type {Map<string, Map<string, {color: string, segments: {id: string, start: number, end: number}[]}>>} */
        const originGroups = new Map();
        for (const item of this._linkedLabels.values()) {
            const origin = String(item?.origin || 'manual').trim() || 'manual';
            const name = String(item?.label || item?.species || '').trim();
            if (!name) continue;

            if (!originGroups.has(origin)) originGroups.set(origin, new Map());
            const nameMap = /** @type {Map<string, {color: string, segments: {id: string, start: number, end: number}[]}>} */ (originGroups.get(origin));

            if (!nameMap.has(name)) nameMap.set(name, { color: item.color || '', segments: [] });
            const g = /** @type {{color: string, segments: {id: string, start: number, end: number}[]}} */ (nameMap.get(name));
            if (!g.color && item.color) g.color = item.color;
            g.segments.push({ id: item.id || '', start: item.start, end: item.end });
        }

        if (originGroups.size === 0) { container.innerHTML = ''; this._afterOverviewRowChange(prevRowCount, 0); return; }

        // Sort origins: manual → BirdNET → xeno-canto → alphabetical
        const ORDER = { manual: 0, BirdNET: 1, 'xeno-canto': 2 };
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
                    const rgb = this._parseLabelColorRgb(color);
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
                        if (seg.id) this._activeLabelId = seg.id;
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
    }

    /**
     * When the overview label track row count changes, the spectrogram container
     * shrinks/grows (flexbox). Schedule a resize-aware redraw so canvas, coords,
     * AND label overlay layers all stay in sync.
     */
    _afterOverviewRowChange(prevCount, nextCount) {
        if (prevCount !== nextCount) {
            this._state?._queueResizeRedraw({ redrawSpectrogram: true });
        }
    }

    /** @param {string} color @returns {{r:number,g:number,b:number}|null} */
    _parseLabelColorRgb(color) {
        if (!color) return null;
        const s = String(color).trim();
        const hexMatch = s.match(/^#?([0-9a-f]{3,6})$/i);
        if (hexMatch) {
            let h = hexMatch[1];
            if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
            return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16) };
        }
        const rgbMatch = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (rgbMatch) return { r: +rgbMatch[1], g: +rgbMatch[2], b: +rgbMatch[3] };
        return null;
    }

    _normalizeTaxonomy(taxonomy) {
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

    _normalizeLinkedLabel(label) {
        const duration = Math.max(0.001, this.duration || this._state?.audioBuffer?.duration || 0.001);
        const nyquist = (this._state?.sampleRateHz || DEFAULT_SAMPLE_RATE) / 2;
        const selected = parseFloat(this._state?.d?.maxFreqSelect?.value || `${nyquist}`);
        const maxFreq = clamp(selected, 1, nyquist);

        const start = clamp(Number(label?.start ?? 0), 0, duration);
        const end = clamp(Number(label?.end ?? start + 0.01), start + 0.01, duration);
        const freqMinRaw = Number(label?.freqMin ?? 0);
        const freqMaxRaw = Number(label?.freqMax ?? maxFreq);
        const freqMin = clamp(freqMinRaw, 0, maxFreq);
        const freqMax = clamp(freqMaxRaw, freqMin + 1, maxFreq);
        const labelName = String(label?.label || label?.species || '').trim();
        const tax = labelName
            ? this._labelTaxonomy.find((t) => t.name.toLowerCase() === labelName.toLowerCase())
            : null;
        const explicitColor = String(label?.color || '').trim();

        return {
            id: label?.id || `lbl_${Math.random().toString(36).slice(2, 10)}`,
            start,
            end,
            freqMin,
            freqMax,
            species: label?.species || '',
            label: label?.label || label?.species || '',
            confidence: label?.confidence,
            color: explicitColor || tax?.color || colorForName(labelName),
            scientificName: label?.scientificName || '',
            commonName: label?.commonName || '',
            origin: label?.origin || '',
            author: label?.author || '',
            tags: (label?.tags && typeof label.tags === 'object') ? { ...label.tags } : {},
        };
    }
}
