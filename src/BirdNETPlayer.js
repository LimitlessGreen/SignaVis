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
import { PlayerState } from './PlayerState.js';
import { AnnotationLayer, SpectrogramLabelLayer } from './annotations.js';
import './player.css';  // Vite extracts this into birdnet-player.css

const WAVESURFER_CDN = 'https://unpkg.com/wavesurfer.js@7/dist/wavesurfer.esm.js';
const DEFAULT_LABEL_TAXONOMY = [
    { name: 'Bird Call', color: '#0ea5e9', shortcut: '1' },
    { name: 'Song', color: '#22c55e', shortcut: '2' },
    { name: 'Chirp', color: '#f59e0b', shortcut: '3' },
    { name: 'Noise', color: '#ef4444', shortcut: '4' },
];

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
        this._labelLibrary = new Map();
        this._labelTaxonomy = this._normalizeTaxonomy(options.labelTaxonomy || DEFAULT_LABEL_TAXONOMY);
        this._activeLabelId = null;
        this._globalKeyHandler = null;

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
    getLabelTaxonomy() {
        return this._labelTaxonomy.map((item) => ({ ...item }));
    }
    setLabelTaxonomy(taxonomy = []) {
        this._labelTaxonomy = this._normalizeTaxonomy(taxonomy);
        this._syncLinkedLabelsToLayers();
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
     * @param {string} [options.mode='perch'] - 'perch'|'classic' (affects freq axis labels)
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
     * @param {number} [options.sampleRate] - for freq labels
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
        if (this._state.audioBuffer) this._state._generateSpectrogram();
    }

    setPlaybackViewportConfig(config = {}) {
        return this._state?.updatePlaybackViewportConfig?.(config) || null;
    }
    getPlaybackViewportConfig() {
        return this._state?.getPlaybackViewportConfig?.() || null;
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
            const id = String(e?.detail?.id || '').trim();
            this._activeLabelId = id || null;
        });
        this.on('annotationpreview', (e) => this._previewFromAnnotationEvent(e.detail.annotation));
        this.on('spectrogramlabelpreview', (e) => this._previewFromSpectrogramEvent(e.detail.label));
        this.on('annotationcreate', (e) => this._upsertFromAnnotationEvent(e.detail.annotation));
        this.on('annotationupdate', (e) => this._upsertFromAnnotationEvent(e.detail.annotation));
        this.on('spectrogramlabelcreate', (e) => this._upsertFromSpectrogramEvent(e.detail.label));
        this.on('spectrogramlabelupdate', (e) => this._upsertFromSpectrogramEvent(e.detail.label));
    }

    _bindGlobalHotkeys() {
        this._globalKeyHandler = (event) => {
            if (!this._activeLabelId) return;
            const tag = event?.target?.tagName?.toLowerCase?.() || '';
            const typing = tag === 'input' || tag === 'textarea' || event?.target?.isContentEditable;
            if (typing) return;
            const key = String(event.key || '');
            if (!/^[1-9]$/.test(key)) return;
            const idx = Number(key) - 1;
            if (idx >= this._labelTaxonomy.length) return;
            event.preventDefault();
            this.applyTaxonomyToLabel(this._activeLabelId, idx);
        };
        document.addEventListener('keydown', this._globalKeyHandler, true);
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
        this._isSyncingLabels = true;
        try {
            this.annotations.set(this._toAnnotationList());
            this.spectrogramLabels.set(this._toSpectrogramLabelList());
            this._rebuildLabelLibrary();
        } finally {
            this._isSyncingLabels = false;
        }
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
        }));
    }

    _normalizeLinkedLabel(label) {
        const duration = Math.max(0.001, this.duration || this._state?.audioBuffer?.duration || 0.001);
        const nyquist = (this._state?.sampleRateHz || 32000) / 2;
        const selected = parseFloat(this._state?.d?.maxFreqSelect?.value || `${nyquist}`);
        const maxFreq = Math.max(1, Math.min(selected, nyquist));

        const start = Math.max(0, Math.min(Number(label?.start ?? 0), duration));
        const end = Math.max(start + 0.01, Math.min(duration, Number(label?.end ?? start + 0.01)));
        const freqMinRaw = Number(label?.freqMin ?? 0);
        const freqMaxRaw = Number(label?.freqMax ?? maxFreq);
        const freqMin = Math.max(0, Math.min(freqMinRaw, maxFreq));
        const freqMax = Math.max(freqMin + 1, Math.min(maxFreq, freqMaxRaw));
        const labelName = String(label?.label || label?.species || '').trim();
        const tax = labelName
            ? this._labelTaxonomy.find((t) => t.name.toLowerCase() === labelName.toLowerCase())
            : null;

        return {
            id: label?.id || `lbl_${Math.random().toString(36).slice(2, 10)}`,
            start,
            end,
            freqMin,
            freqMax,
            species: label?.species || '',
            label: label?.label || label?.species || '',
            confidence: label?.confidence,
            color: label?.color || tax?.color || '',
        };
    }
}
