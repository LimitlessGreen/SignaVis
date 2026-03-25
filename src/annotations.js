// ═══════════════════════════════════════════════════════════════════════
// annotations.js — Region layer for detections/annotations
// ═══════════════════════════════════════════════════════════════════════

import { pixelYToFrequency, frequencyToPixelY } from './spectrogram.js';

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

const _colorCtx = (() => {
    try {
        const canvas = document.createElement('canvas');
        return canvas.getContext('2d');
    } catch {
        return null;
    }
})();

function _parseColorToRgb(color) {
    const raw = String(color || '').trim();
    if (!raw || !_colorCtx) return null;
    try {
        _colorCtx.fillStyle = '#000000';
        _colorCtx.fillStyle = raw;
        const normalized = _colorCtx.fillStyle;
        if (!normalized) return null;
        if (normalized.startsWith('#')) {
            const hex = normalized.slice(1);
            if (hex.length === 3) {
                return {
                    r: parseInt(hex[0] + hex[0], 16),
                    g: parseInt(hex[1] + hex[1], 16),
                    b: parseInt(hex[2] + hex[2], 16),
                };
            }
            if (hex.length === 6) {
                return {
                    r: parseInt(hex.slice(0, 2), 16),
                    g: parseInt(hex.slice(2, 4), 16),
                    b: parseInt(hex.slice(4, 6), 16),
                };
            }
        }
        const m = normalized.match(/rgba?\(([^)]+)\)/i);
        if (!m) return null;
        const parts = m[1].split(',').map((x) => Number(x.trim()));
        if (parts.length < 3 || parts.some((n, i) => i < 3 && !Number.isFinite(n))) return null;
        return { r: parts[0], g: parts[1], b: parts[2] };
    } catch {
        return null;
    }
}

function _rgbToHex({ r, g, b }) {
    const toHex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function getOverlayColorStyle(color) {
    const rgb = _parseColorToRgb(color);
    if (!rgb) return null;
    return {
        fill: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.22)`,
        edge: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.95)`,
        soft: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.55)`,
        hex: _rgbToHex(rgb),
    };
}

function openLabelNameEditor({ player, anchorEl, initialValue, initialColor, onSubmit }) {
    const host = player?.root || player?.container || document.body;
    if (!host || !anchorEl || typeof onSubmit !== 'function') return;

    const panel = document.createElement('div');
    panel.className = 'label-name-editor';
    panel.innerHTML = `
        <input class="label-name-input" type="text" maxlength="96" />
        <div class="label-name-color">
            <span>Color</span>
            <input class="label-color-input" type="color" />
        </div>
        <div class="label-name-suggestions"></div>
        <div class="label-name-actions">
            <button type="button" class="label-name-btn cancel">Cancel</button>
            <button type="button" class="label-name-btn save">Save</button>
        </div>
    `;
    host.appendChild(panel);

    const input = /** @type {HTMLInputElement} */ (panel.querySelector('.label-name-input'));
    const colorInput = /** @type {HTMLInputElement} */ (panel.querySelector('.label-color-input'));
    const sugg = /** @type {HTMLElement | null} */ (panel.querySelector('.label-name-suggestions'));
    const saveBtn = /** @type {HTMLButtonElement | null} */ (panel.querySelector('.label-name-btn.save'));
    const cancelBtn = /** @type {HTMLButtonElement | null} */ (panel.querySelector('.label-name-btn.cancel'));
    if (!input || !colorInput) return;
    input.value = String(initialValue || '').trim();
    const initialStyle = getOverlayColorStyle(initialColor);
    colorInput.value = initialStyle?.hex || '#0ea5e9';

    const anchorRect = anchorEl.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    panel.style.left = `${Math.max(4, anchorRect.left - hostRect.left)}px`;
    panel.style.top = `${Math.max(4, anchorRect.bottom - hostRect.top + 6)}px`;

    const close = () => {
        if (panel.parentNode) panel.parentNode.removeChild(panel);
    };

    const submit = (value) => {
        const trimmed = String(value || '').trim();
        if (!trimmed) return;
        onSubmit({ name: trimmed, color: colorInput.value });
        close();
    };

    const renderSuggestions = () => {
        const taxonomy = player?.getLabelTaxonomy?.() || [];
        const recent = player?.getLabelSuggestions?.('', 8) || [];
        const filtered = player?.getLabelSuggestions?.(input.value, 8) || [];
        const names = [];
        const seen = new Set();
        for (const name of recent) {
            if (!name || seen.has(name)) continue;
            seen.add(name);
            names.push(name);
        }
        for (const name of filtered) {
            if (!name || seen.has(name)) continue;
            seen.add(name);
            names.push(name);
        }
        if (sugg) sugg.innerHTML = '';
        for (const item of taxonomy) {
            if (!item?.name) continue;
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'label-name-chip taxonomy';
            chip.textContent = item.shortcut ? `${item.shortcut}: ${item.name}` : item.name;
            if (item.color) chip.style.setProperty('--chip-color', item.color);
            chip.addEventListener('click', () => {
                if (item.color) colorInput.value = getOverlayColorStyle(item.color)?.hex || colorInput.value;
                submit(item.name);
            });
            sugg?.appendChild(chip);
        }
        for (const name of names) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'label-name-chip';
            chip.textContent = name;
            chip.addEventListener('click', () => submit(name));
            sugg?.appendChild(chip);
        }
    };

    input.addEventListener('input', renderSuggestions);
    input.addEventListener('keydown', (e) => {
        if (/** @type {KeyboardEvent} */ (e).key === 'Enter') {
            e.preventDefault();
            submit(input.value);
        } else if (/** @type {KeyboardEvent} */ (e).key === 'Escape') {
            e.preventDefault();
            close();
        }
    });
    saveBtn?.addEventListener('click', () => submit(input.value));
    cancelBtn?.addEventListener('click', close);
    setTimeout(() => input.focus(), 0);
    input.select();
    renderSuggestions();
}

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
    constructor() {
        this.player = null;
        this.overlay = null;
        this.annotations = [];
        this._liveLinkedId = null;
        this._unsubs = [];
        this._domCleanups = [];
        this._editing = null;
        this._suppressClickUntil = 0;
    }

    attach(player) {
        this.detach();
        this.player = player;

        const root = this.player?._state?.d?.waveformContent || this.player?.root?.querySelector('.waveform-content');
        if (!root) return;

        this.overlay = document.createElement('div');
        this.overlay.className = 'annotation-layer';
        root.appendChild(this.overlay);

        this._unsubs.push(this.player.on('ready', () => this.render()));
        this._unsubs.push(this.player.on('zoomchange', () => this.render()));
        this._unsubs.push(this.player.on('viewresize', () => this.render()));
        this._unsubs.push(this.player.on('seek', (e) => this.highlightActiveRegion(e.detail.currentTime)));
        this._unsubs.push(this.player.on('timeupdate', (e) => this.highlightActiveRegion(e.detail.currentTime)));
        this._bindEditingInteractions(root);
        this.render();
    }

    detach() {
        for (const unsub of this._unsubs) unsub();
        this._unsubs = [];
        for (const cleanup of this._domCleanups) cleanup();
        this._domCleanups = [];
        if (this.overlay?.parentNode) this.overlay.parentNode.removeChild(this.overlay);
        this.overlay = null;
        this.player = null;
        this._editing = null;
    }

    add(annotation) {
        const region = this._normalize(annotation);
        this.annotations.push(region);
        this.render();
        this.player?._emit?.('annotationcreate', { annotation: { ...region } });
        return region.id;
    }

    set(regions = []) {
        this.annotations = regions.map((r) => this._normalize(r));
        this.render();
    }

    clear() {
        this.annotations = [];
        this.render();
    }

    remove(id) {
        this.annotations = this.annotations.filter((a) => a.id !== id);
        this.render();
    }

    getAll() {
        return [...this.annotations];
    }

    setLiveLinkedId(id = null) {
        this._liveLinkedId = id || null;
    }

    highlightActiveRegion(currentTime) {
        if (!this.overlay) return;
        for (const el of this.overlay.querySelectorAll('.annotation-region')) {
            const h = /** @type {HTMLElement} */ (el);
            const start = parseFloat(h.dataset.start || '0');
            const end = parseFloat(h.dataset.end || '0');
            el.classList.toggle('active', currentTime >= start && currentTime <= end);
        }
    }

    exportRavenFormat(regions = this.annotations) {
        return regions
            .map((r) => `${r.start}\t${r.end}\t${r.species || ''}\t${r.confidence ?? ''}`)
            .join('\n');
    }

    render() {
        if (!this.overlay || !this.player) return;

        const pps = this.player._state?.pixelsPerSecond || 100;
        const duration = this.player.duration || this.player._state?.audioBuffer?.duration || 0;
        const width = Math.max(1, Math.floor(duration * pps));
        this.overlay.style.width = `${width}px`;
        this.overlay.innerHTML = '';

        for (const region of this.annotations) {
            const el = this._createRegionElement(region, pps);
            this.overlay.appendChild(el);
        }
    }

    _createRegionElement(region, pixelsPerSecond) {
        const el = document.createElement('div');
        el.className = 'annotation-region';
        if (this._liveLinkedId && region.id === this._liveLinkedId) el.classList.add('linked-live');
        el.setAttribute('role', 'button');
        el.setAttribute('tabindex', '0');
        el.style.left = `${Math.max(0, region.start * pixelsPerSecond)}px`;
        el.style.width = `${Math.max(1, (region.end - region.start) * pixelsPerSecond)}px`;
        const colorStyle = getOverlayColorStyle(region.color);
        if (colorStyle) {
            el.style.setProperty('--annotation-color-fill', colorStyle.fill);
            el.style.setProperty('--annotation-color-edge', colorStyle.edge);
            el.style.setProperty('--annotation-color-soft', colorStyle.soft);
        }

        el.dataset.id = region.id;
        el.dataset.start = String(region.start);
        el.dataset.end = String(region.end);
        el.title = `${region.species || 'Annotation'} (${region.start.toFixed(2)}s–${region.end.toFixed(2)}s)`;
        el.innerHTML = `
            <span class="annotation-label">${region.species || 'Annotation'}</span>
            <span class="annotation-confidence">${region.confidence != null ? `${Math.round(region.confidence * 100)}%` : ''}</span>
            <span class="annotation-handle handle-l" data-mode="resize-l"></span>
            <span class="annotation-handle handle-r" data-mode="resize-r"></span>
        `;

        el.addEventListener('click', (event) => {
            if (performance.now() < this._suppressClickUntil) return;
            event.preventDefault();
            event.stopPropagation();
            this.player?._emit?.('labelfocus', { id: region.id, source: 'waveform' });
            this.player?._state?._blockSeekClicks?.(260);
            this.player?.playSegment?.(region.start, region.end, { labelId: region.id });
        });
        el.addEventListener('dblclick', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this._suppressClickUntil = performance.now() + 250;
            this._renameRegionPrompt(region.id);
        });
        el.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            this.player?._emit?.('labelfocus', { id: region.id, source: 'waveform' });
            const handle = /** @type {HTMLElement | null} */ (event.target)?.closest?.('.annotation-handle');
            const mode = /** @type {HTMLElement | null} */ (handle)?.dataset?.mode || 'move';
            this._startEditInteraction(region.id, mode, event.clientX, el);
            event.preventDefault();
            event.stopPropagation();
        });
        return el;
    }

    _bindEditingInteractions(root) {
        const onPointerMove = (e) => {
            if (!this._editing) return;
            this._updateEditInteraction(e.clientX);
            e.preventDefault();
            e.stopPropagation();
        };

        const onPointerUp = (e) => {
            if (!this._editing) return;
            this._finishEditInteraction();
            e.preventDefault();
            e.stopPropagation();
        };

        root.addEventListener('pointermove', onPointerMove, true);
        document.addEventListener('pointerup', onPointerUp, true);
        document.addEventListener('pointercancel', onPointerUp, true);
        this._domCleanups.push(() => root.removeEventListener('pointermove', onPointerMove, true));
        this._domCleanups.push(() => document.removeEventListener('pointerup', onPointerUp, true));
        this._domCleanups.push(() => document.removeEventListener('pointercancel', onPointerUp, true));
    }

    _startEditInteraction(id, mode, clientX, element) {
        const region = this.annotations.find((a) => a.id === id);
        if (!region) return;
        this._editing = {
            id,
            mode,
            startX: clientX,
            startRegion: { ...region },
            element,
            pending: mode === 'move',
            moved: mode !== 'move',
            forceSuppressClick: mode !== 'move',
        };
        if (mode !== 'move') element.classList.add('editing');
    }

    _updateEditInteraction(clientX) {
        if (!this._editing) return;
        const editing = this._editing;
        const region = this.annotations.find((a) => a.id === editing.id);
        if (!region) return;
        const pps = this.player?._state?.pixelsPerSecond || 100;
        const duration = Math.max(0.001, this.player?.duration || this.player?._state?.audioBuffer?.duration || 0.001);
        const dt = (clientX - this._editing.startX) / Math.max(1, pps);
        const src = this._editing.startRegion;
        let next = { ...region };
        if (this._editing.pending) {
            if (Math.abs(clientX - this._editing.startX) < 4) return;
            this._editing.pending = false;
            this._editing.moved = true;
            this._editing.element?.classList?.add('editing');
        }

        if (this._editing.mode === 'move') {
            const span = src.end - src.start;
            next.start = clamp(src.start + dt, 0, Math.max(0, duration - span));
            next.end = next.start + span;
        } else if (this._editing.mode === 'resize-l') {
            next.start = clamp(src.start + dt, 0, src.end - 0.01);
        } else if (this._editing.mode === 'resize-r') {
            next.end = clamp(src.end + dt, src.start + 0.01, duration);
        }

        Object.assign(region, this._normalize({ ...src, ...next, id: src.id }));
        this.player?._state?.updateActiveSegmentFromLabel?.(region);
        this.player?._emit?.('annotationpreview', { annotation: { ...region } });
        const el = this._editing.element;
        if (el) {
            el.dataset.start = String(region.start);
            el.dataset.end = String(region.end);
            el.style.left = `${Math.max(0, region.start * pps)}px`;
            el.style.width = `${Math.max(1, (region.end - region.start) * pps)}px`;
        }
    }

    _finishEditInteraction() {
        if (!this._editing) return;
        const editing = this._editing;
        const shouldSuppressClick = editing.forceSuppressClick || editing.moved;
        editing.element?.classList?.remove('editing');
        const region = this.annotations.find((a) => a.id === editing.id);
        if (region && editing.moved) this.player?._emit?.('annotationupdate', { annotation: { ...region } });
        this._editing = null;
        if (shouldSuppressClick) {
            this._suppressClickUntil = performance.now() + 250;
            this.render();
        }
    }

    _renameRegionPrompt(id) {
        const region = this.annotations.find((a) => a.id === id);
        if (!region) return;
        const current = region.species || 'Annotation';
        const el = this.overlay?.querySelector?.(`.annotation-region[data-id="${region.id}"]`);
        openLabelNameEditor({
            player: this.player,
            anchorEl: el || this.overlay,
            initialValue: current,
            initialColor: region.color,
            onSubmit: ({ name, color }) => {
                const currentHex = getOverlayColorStyle(region.color)?.hex || '';
                if (name === current && color === currentHex) return;
                region.species = name;
                region.color = color;
                this.player?._emit?.('annotationupdate', { annotation: { ...region } });
                this.render();
            },
        });
    }

    _normalize(annotation) {
        const start = Number(annotation?.start ?? 0);
        const end = Number(annotation?.end ?? start);
        if (!Number.isFinite(start) || !Number.isFinite(end)) {
            throw new Error('AnnotationLayer: start/end must be finite numbers');
        }
        const s = Math.max(0, Math.min(start, end));
        const e = Math.max(0, Math.max(start, end));
        return {
            id: annotation?.id || `ann_${Math.random().toString(36).slice(2, 10)}`,
            start: s,
            end: Math.max(s + 0.01, e),
            species: annotation?.species || '',
            confidence: annotation?.confidence,
            color: String(annotation?.color || '').trim(),
        };
    }
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
    constructor() {
        this.player = null;
        this.overlay = null;
        this.labels = [];
        this._liveLinkedId = null;
        this._unsubs = [];
        this._domCleanups = [];
        this._draftEl = null;
        this._drawing = null;
        this._editing = null;
        this._counter = 1;
        this._suppressClickUntil = 0;
    }

    attach(player) {
        this.detach();
        this.player = player;
        const root = this.player?._state?.d?.canvasWrapper || this.player?.root?.querySelector('.canvas-wrapper');
        if (!root) return;

        this.overlay = document.createElement('div');
        this.overlay.className = 'spectrogram-label-layer';
        root.appendChild(this.overlay);

        this._unsubs.push(this.player.on('ready', () => this.render()));
        this._unsubs.push(this.player.on('zoomchange', () => this.render()));
        this._unsubs.push(this.player.on('viewresize', () => this.render()));
        this._unsubs.push(this.player.on('spectrogramscalechange', () => this.render()));
        this._unsubs.push(this.player.on('timeupdate', (e) => this.highlightActiveLabel(e.detail.currentTime)));
        this._bindDrawingInteractions(root);
        this.render();
    }

    detach() {
        for (const unsub of this._unsubs) unsub();
        this._unsubs = [];
        for (const cleanup of this._domCleanups) cleanup();
        this._domCleanups = [];
        if (this.overlay?.parentNode) this.overlay.parentNode.removeChild(this.overlay);
        this.overlay = null;
        this.player = null;
        this._draftEl = null;
        this._drawing = null;
        this._editing = null;
    }

    add(label) {
        const region = this._normalize(label);
        this.labels.push(region);
        this.render();
        this.player?._emit?.('spectrogramlabelcreate', { label: region });
        return region.id;
    }

    set(labels = []) {
        this.labels = labels.map((l) => this._normalize(l));
        this.render();
    }

    clear() {
        this.labels = [];
        this.render();
    }

    remove(id) {
        this.labels = this.labels.filter((l) => l.id !== id);
        this.render();
    }

    getAll() {
        return [...this.labels];
    }

    setLiveLinkedId(id = null) {
        this._liveLinkedId = id || null;
    }

    highlightActiveLabel(currentTime) {
        if (!this.overlay) return;
        for (const el of this.overlay.querySelectorAll('.spectrogram-label-region')) {
            const h = /** @type {HTMLElement} */ (el);
            const start = parseFloat(h.dataset.start || '0');
            const end = parseFloat(h.dataset.end || '0');
            el.classList.toggle('active', currentTime >= start && currentTime <= end);
        }
    }

    render() {
        if (!this.overlay || !this.player) return;
        const state = this.player._state;
        const duration = this.player.duration || state?.audioBuffer?.duration || 0;
        const width = Math.max(1, state?.d?.spectrogramCanvas?.width || Math.floor(duration * (state?.pixelsPerSecond || 100)));
        const height = Math.max(1, state?.d?.spectrogramCanvas?.height || 1);
        this.overlay.style.width = `${width}px`;
        this.overlay.style.height = `${height}px`;
        this.overlay.innerHTML = '';

        for (const label of this.labels) {
            const el = this._createLabelElement(label, width, height);
            this.overlay.appendChild(el);
        }
    }

    _createLabelElement(label, canvasWidth, canvasHeight) {
        const el = document.createElement('div');
        el.className = 'spectrogram-label-region';
        if (this._liveLinkedId && label.id === this._liveLinkedId) el.classList.add('linked-live');
        el.setAttribute('role', 'button');
        el.setAttribute('tabindex', '0');

        this._applyGeometryToElement(el, this._toGeometry(label, canvasWidth, canvasHeight));
        const colorStyle = getOverlayColorStyle(label.color);
        if (colorStyle) {
            el.style.setProperty('--spectrogram-label-color', colorStyle.fill);
            el.style.setProperty('--spectrogram-label-edge', colorStyle.edge);
            el.style.setProperty('--spectrogram-label-soft', colorStyle.soft);
        }

        el.dataset.id = label.id;
        el.dataset.start = String(label.start);
        el.dataset.end = String(label.end);
        el.title = `${label.label || 'Label'} ${label.start.toFixed(2)}s–${label.end.toFixed(2)}s / ${Math.round(label.freqMin)}-${Math.round(label.freqMax)} Hz`;
        el.innerHTML = `
            <span class="spectrogram-label-text">${label.label || 'Label'}</span>
            <span class="spectrogram-label-meta">${Math.round(label.freqMin)}-${Math.round(label.freqMax)} Hz</span>
            <span class="label-handle handle-tl" data-mode="resize-tl"></span>
            <span class="label-handle handle-tr" data-mode="resize-tr"></span>
            <span class="label-handle handle-bl" data-mode="resize-bl"></span>
            <span class="label-handle handle-br" data-mode="resize-br"></span>
            <span class="label-handle handle-l" data-mode="resize-l"></span>
            <span class="label-handle handle-r" data-mode="resize-r"></span>
            <span class="label-handle handle-t" data-mode="resize-t"></span>
            <span class="label-handle handle-b" data-mode="resize-b"></span>
        `;

        el.addEventListener('click', (event) => {
            if (performance.now() < this._suppressClickUntil) return;
            event.stopPropagation();
            event.preventDefault();
            this.player?._emit?.('labelfocus', { id: label.id, source: 'spectrogram' });
            this.player?._state?._blockSeekClicks?.(260);
            this.player?.playBandpassedSegment?.(
                label.start,
                label.end,
                label.freqMin,
                label.freqMax,
                { labelId: label.id },
            );
        });
        el.addEventListener('dblclick', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this._suppressClickUntil = performance.now() + 250;
            this._renameSpectrogramLabelPrompt(label.id);
        });
        el.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            this.player?._emit?.('labelfocus', { id: label.id, source: 'spectrogram' });
            const handle = /** @type {HTMLElement | null} */ (event.target)?.closest?.('.label-handle');
            const mode = /** @type {HTMLElement | null} */ (handle)?.dataset?.mode || 'move';
            this._startEditInteraction(label.id, mode, event.clientX, event.clientY, el);
            event.preventDefault();
            event.stopPropagation();
        });
        return el;
    }

    _applyGeometryToElement(el, geometry) {
        el.style.left = `${geometry.left}px`;
        el.style.top = `${geometry.top}px`;
        el.style.width = `${geometry.width}px`;
        el.style.height = `${geometry.height}px`;
    }

    _toGeometry(label, canvasWidth, canvasHeight) {
        const state = this.player?._state;
        const duration = Math.max(0.001, this.player?.duration || state?.audioBuffer?.duration || 0.001);
        const maxFreq = this._getMaxFreq();
        const sampleRateHz = state?.sampleRateHz || 32000;
        const nMels = state?.spectrogramMels || 128;
        const mode = state?.d?.spectrogramModeSelect?.value || 'perch';

        const x1 = clamp((label.start / duration) * canvasWidth, 0, canvasWidth);
        const x2 = clamp((label.end / duration) * canvasWidth, 0, canvasWidth);
        const yHigh = clamp(frequencyToPixelY(label.freqMax, canvasHeight, maxFreq, sampleRateHz, nMels, mode), 0, canvasHeight);
        const yLow = clamp(frequencyToPixelY(label.freqMin, canvasHeight, maxFreq, sampleRateHz, nMels, mode), 0, canvasHeight);

        return {
            left: Math.min(x1, x2),
            top: Math.min(yHigh, yLow),
            width: Math.max(1, Math.abs(x2 - x1)),
            height: Math.max(1, Math.abs(yLow - yHigh)),
        };
    }

    _bindDrawingInteractions(wrapper) {
        const onPointerDown = (e) => {
            if (e.target?.closest?.('.spectrogram-label-region')) return;
            if (!e.shiftKey || e.button !== 0) return;
            if (!this.player?._state?.audioBuffer) return;

            const start = this._clientXToTime(e.clientX);
            const freq = this._clientYToFreq(e.clientY);
            this._drawing = { startTime: start, startFreq: freq, endTime: start, endFreq: freq };
            this._ensureDraft();
            this._updateDraft();
            e.preventDefault();
            e.stopPropagation();
        };

        const onPointerMove = (e) => {
            if (this._editing) {
                this._updateEditInteraction(e.clientX, e.clientY);
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            if (this._drawing) {
                this._drawing.endTime = this._clientXToTime(e.clientX);
                this._drawing.endFreq = this._clientYToFreq(e.clientY);
                this._updateDraft();
                e.preventDefault();
                e.stopPropagation();
            }
        };

        const onPointerUp = (e) => {
            if (this._editing) {
                this._finishEditInteraction();
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            if (this._drawing) {
                const region = this._finalizeDraft();
                if (region) this.add(region);
                this._clearDraft();
                e.preventDefault();
                e.stopPropagation();
            }
        };

        wrapper.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('pointermove', onPointerMove, true);
        document.addEventListener('pointerup', onPointerUp, true);
        document.addEventListener('pointercancel', onPointerUp, true);

        this._domCleanups.push(() => wrapper.removeEventListener('pointerdown', onPointerDown, true));
        this._domCleanups.push(() => document.removeEventListener('pointermove', onPointerMove, true));
        this._domCleanups.push(() => document.removeEventListener('pointerup', onPointerUp, true));
        this._domCleanups.push(() => document.removeEventListener('pointercancel', onPointerUp, true));
    }

    _ensureDraft() {
        if (!this.overlay || this._draftEl) return;
        this._draftEl = document.createElement('div');
        this._draftEl.className = 'spectrogram-label-draft';
        this.overlay.appendChild(this._draftEl);
    }

    _updateDraft() {
        if (!this._drawing || !this._draftEl || !this.overlay) return;
        const width = parseFloat(this.overlay.style.width) || 1;
        const height = parseFloat(this.overlay.style.height) || 1;
        const preview = this._normalize({
            start: this._drawing.startTime,
            end: this._drawing.endTime,
            freqMin: Math.min(this._drawing.startFreq, this._drawing.endFreq),
            freqMax: Math.max(this._drawing.startFreq, this._drawing.endFreq),
            label: 'New label',
        });
        const g = this._toGeometry(preview, width, height);
        this._draftEl.style.left = `${g.left}px`;
        this._draftEl.style.top = `${g.top}px`;
        this._draftEl.style.width = `${g.width}px`;
        this._draftEl.style.height = `${g.height}px`;
    }

    _finalizeDraft() {
        if (!this._drawing) return null;
        const region = this._normalize({
            start: this._drawing.startTime,
            end: this._drawing.endTime,
            freqMin: Math.min(this._drawing.startFreq, this._drawing.endFreq),
            freqMax: Math.max(this._drawing.startFreq, this._drawing.endFreq),
            label: `Label ${this._counter++}`,
        });
        const duration = Math.abs(region.end - region.start);
        const freqSpan = Math.abs(region.freqMax - region.freqMin);
        if (duration < 0.02 || freqSpan < 20) return null;
        return region;
    }

    _clearDraft() {
        this._drawing = null;
        if (this._draftEl?.parentNode) this._draftEl.parentNode.removeChild(this._draftEl);
        this._draftEl = null;
    }

    _startEditInteraction(labelId, mode, clientX, clientY, element) {
        const label = this.labels.find((l) => l.id === labelId);
        if (!label) return;
        this._editing = {
            id: labelId,
            mode,
            startX: clientX,
            startY: clientY,
            startLabel: { ...label },
            element,
            pending: mode === 'move',
            moved: mode !== 'move',
            forceSuppressClick: mode !== 'move',
        };
        if (mode !== 'move') element.classList.add('editing');
    }

    _updateEditInteraction(clientX, clientY) {
        if (!this._editing) return;
        const editing = this._editing;
        const label = this.labels.find((l) => l.id === editing.id);
        if (!label) return;

        const duration = Math.max(0.001, this.player?.duration || this.player?._state?.audioBuffer?.duration || 0.001);
        const maxFreq = this._getMaxFreq();
        const width = Math.max(1, this.player?._state?.d?.spectrogramCanvas?.width || 1);
        const height = Math.max(1, this.player?._state?.d?.spectrogramCanvas?.height || 1);

        const dt = (clientX - this._editing.startX) / width * duration;
        const startFreq = this._clientYToFreq(this._editing.startY);
        const currentFreq = this._clientYToFreq(clientY);
        const df = currentFreq - startFreq;
        const src = this._editing.startLabel;
        if (this._editing.pending) {
            if (Math.abs(clientX - this._editing.startX) < 4 && Math.abs(clientY - this._editing.startY) < 4) return;
            this._editing.pending = false;
            this._editing.moved = true;
            this._editing.element?.classList?.add('editing');
        }

        let next = { ...label };
        switch (this._editing.mode) {
            case 'move':
                next.start = src.start + dt;
                next.end = src.end + dt;
                next.freqMin = src.freqMin + df;
                next.freqMax = src.freqMax + df;
                break;
            case 'resize-l':
                next.start = src.start + dt;
                break;
            case 'resize-r':
                next.end = src.end + dt;
                break;
            case 'resize-t':
                next.freqMax = src.freqMax + df;
                break;
            case 'resize-b':
                next.freqMin = src.freqMin + df;
                break;
            case 'resize-tl':
                next.start = src.start + dt;
                next.freqMax = src.freqMax + df;
                break;
            case 'resize-tr':
                next.end = src.end + dt;
                next.freqMax = src.freqMax + df;
                break;
            case 'resize-bl':
                next.start = src.start + dt;
                next.freqMin = src.freqMin + df;
                break;
            case 'resize-br':
                next.end = src.end + dt;
                next.freqMin = src.freqMin + df;
                break;
            default:
                break;
        }

        next = this._normalize({ ...src, ...next, id: src.id, label: src.label, color: src.color });

        // Preserve band thickness on pure move
        if (this._editing.mode === 'move') {
            const timeSpan = Math.max(0.01, src.end - src.start);
            const freqSpan = Math.max(1, src.freqMax - src.freqMin);
            next.end = next.start + timeSpan;
            next.freqMax = next.freqMin + freqSpan;
            if (next.end > duration) {
                const shift = next.end - duration;
                next.start = Math.max(0, next.start - shift);
                next.end = duration;
            }
            if (next.freqMax > maxFreq) {
                const shift = next.freqMax - maxFreq;
                next.freqMin = Math.max(0, next.freqMin - shift);
                next.freqMax = maxFreq;
            }
        }

        Object.assign(label, next);
        this.player?._state?.updateActiveSegmentFromLabel?.(label);
        this.player?._emit?.('spectrogramlabelpreview', { label: { ...label } });
        if (this._editing.element) {
            this._editing.element.dataset.start = String(label.start);
            this._editing.element.dataset.end = String(label.end);
            this._editing.element.title = `${label.label || 'Label'} ${label.start.toFixed(2)}s–${label.end.toFixed(2)}s / ${Math.round(label.freqMin)}-${Math.round(label.freqMax)} Hz`;
            const geometry = this._toGeometry(label, width, height);
            this._applyGeometryToElement(this._editing.element, geometry);
            const meta = this._editing.element.querySelector('.spectrogram-label-meta');
            if (meta) meta.textContent = `${Math.round(label.freqMin)}-${Math.round(label.freqMax)} Hz`;
        }
    }

    _finishEditInteraction() {
        if (!this._editing) return;
        const editing = this._editing;
        const shouldSuppressClick = editing.forceSuppressClick || editing.moved;
        editing.element?.classList?.remove('editing');
        const label = this.labels.find((l) => l.id === editing.id);
        if (label && editing.moved) this.player?._emit?.('spectrogramlabelupdate', { label });
        this._editing = null;
        if (shouldSuppressClick) {
            this._suppressClickUntil = performance.now() + 250;
            this.render();
        }
    }

    _renameSpectrogramLabelPrompt(id) {
        const label = this.labels.find((l) => l.id === id);
        if (!label) return;
        const current = label.label || 'Label';
        const el = this.overlay?.querySelector?.(`.spectrogram-label-region[data-id="${label.id}"]`);
        openLabelNameEditor({
            player: this.player,
            anchorEl: el || this.overlay,
            initialValue: current,
            initialColor: label.color,
            onSubmit: ({ name, color }) => {
                const currentHex = getOverlayColorStyle(label.color)?.hex || '';
                if (name === current && color === currentHex) return;
                label.label = name;
                label.color = color;
                this.player?._emit?.('spectrogramlabelupdate', { label: { ...label } });
                this.render();
            },
        });
    }

    _clientXToTime(clientX) {
        return this.player?._state?._clientXToTime?.(clientX, 'spectrogram') || 0;
    }

    _clientYToFreq(clientY) {
        const state = this.player?._state;
        const wrapper = state?.d?.canvasWrapper;
        const canvas = state?.d?.spectrogramCanvas;
        if (!wrapper || !canvas) return 0;
        const rect = wrapper.getBoundingClientRect();
        const localY = clamp(clientY - rect.top, 0, rect.height);
        const canvasY = localY / Math.max(1, rect.height) * canvas.height;
        const maxFreq = this._getMaxFreq();
        const sampleRateHz = state?.sampleRateHz || 32000;
        const nMels = state?.spectrogramMels || 128;
        const mode = state?.d?.spectrogramModeSelect?.value || 'perch';
        return pixelYToFrequency(canvasY, canvas.height, maxFreq, sampleRateHz, nMels, mode);
    }

    _getMaxFreq() {
        const state = this.player?._state;
        const selected = parseFloat(state?.d?.maxFreqSelect?.value || '10000');
        const nyquist = (state?.sampleRateHz || 32000) / 2;
        return Math.max(1, Math.min(selected, nyquist));
    }

    _normalize(label) {
        const start = Number(label?.start ?? 0);
        const end = Number(label?.end ?? start);
        const freqMin = Number(label?.freqMin ?? 0);
        const freqMax = Number(label?.freqMax ?? freqMin);
        if (![start, end, freqMin, freqMax].every(Number.isFinite)) {
            throw new Error('SpectrogramLabelLayer: numeric start/end/freqMin/freqMax required');
        }
        const maxFreq = this._getMaxFreq();
        const s = Math.max(0, Math.min(start, end));
        const duration = Math.max(0.001, this.player?.duration || this.player?._state?.audioBuffer?.duration || Math.max(start, end, 0.001));
        const e = Math.min(duration, Math.max(0, Math.max(start, end)));
        const f0 = clamp(Math.min(freqMin, freqMax), 0, maxFreq);
        const f1 = clamp(Math.max(freqMin, freqMax), 0, maxFreq);
        return {
            id: label?.id || `slabel_${Math.random().toString(36).slice(2, 10)}`,
            start: s,
            end: Math.max(s + 0.01, e),
            freqMin: f0,
            freqMax: Math.max(f0 + 1, f1),
            label: label?.label || '',
            color: String(label?.color || '').trim(),
        };
    }
}
