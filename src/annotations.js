// ═══════════════════════════════════════════════════════════════════════
// annotations.js — Region layer for detections/annotations
// ═══════════════════════════════════════════════════════════════════════

import { escapeHtml, clamp } from './utils.js';
import { DEFAULT_SAMPLE_RATE } from './constants.js';


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

/**
 * Deterministic color for a label name — same name always produces the same
 * color.  Uses a simple string hash mapped onto a golden-angle hue wheel.
 * @param {string} name
 * @returns {string} hex color
 */
export function colorForName(name) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return _hslToHex(0, 0, 55); // grey fallback
    let h = 0;
    for (let i = 0; i < key.length; i++) {
        h = ((h << 5) - h + key.charCodeAt(i)) | 0;
    }
    const hue = ((h % 360) + 360) % 360;
    return _hslToHex(hue, 65, 58);
}

/**
 * Generate a perceptually distinct color using golden-angle hue rotation.
 * Avoids hues already used by existing labels (min distance in hue space).
 * @param {Array<{color?:string}>} existingLabels
 * @returns {string} hex color
 */
function _autoAssignColor(existingLabels) {
    // Extract existing hues
    const usedHues = [];
    for (const lbl of existingLabels) {
        const rgb = _parseColorToRgb(lbl.color);
        if (!rgb) continue;
        const r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        if (max === min) continue; // achromatic
        let h;
        const d = max - min;
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        else if (max === g) h = ((b - r) / d + 2) / 6;
        else h = ((r - g) / d + 4) / 6;
        usedHues.push(h * 360);
    }

    // Golden-angle rotation: try N candidates, pick the one farthest from existing hues
    const GOLDEN_ANGLE = 137.508;
    const S = 65, L = 58; // vivid but readable on dark bg
    const n = existingLabels.length;

    if (usedHues.length === 0) {
        // First label — start with a pleasant blue-cyan
        const h = (n * GOLDEN_ANGLE) % 360;
        return _hslToHex(h, S, L);
    }

    let bestHue = 0, bestDist = -1;
    for (let i = 0; i < 32; i++) {
        const candidateHue = ((n + i) * GOLDEN_ANGLE) % 360;
        let minDist = 360;
        for (const used of usedHues) {
            const diff = Math.abs(candidateHue - used);
            minDist = Math.min(minDist, diff, 360 - diff);
        }
        if (minDist > bestDist) {
            bestDist = minDist;
            bestHue = candidateHue;
        }
    }

    return _hslToHex(bestHue, S, L);
}

function _hslToHex(h, s, l) {
    s /= 100;
    l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
        const k = (n + h / 30) % 12;
        const color = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
        return Math.round(255 * Math.max(0, Math.min(1, color)));
    };
    return _rgbToHex({ r: f(0), g: f(8), b: f(4) });
}

/**
 * @param {Object} opts
 * @param {*} opts.player
 * @param {Element|null} [opts.anchorEl]
 * @param {string} opts.initialValue
 * @param {string|null} opts.initialColor
 * @param {Record<string,string>|null} [opts.initialTags]
 * @param {(string|{name:string, color?:string, scientificName?:string, tags?:Record<string,string>})[]|null} [opts.existingLabels]
 * @param {string|null} [opts.title]
 * @param {function({name:string, color:string, scientificName?:string, tags?:Record<string,string>}):void} opts.onSubmit
 * @param {(function():void)|null} [opts.onDelete]
 */
function openLabelNameEditor({ player, anchorEl = null, initialValue, initialColor, initialTags = null, existingLabels = null, title = null, onSubmit, onDelete = null }) {
    const host = player?.root || player?.container || document.body;
    if (!host || typeof onSubmit !== 'function') return;

    const backdrop = document.createElement('div');
    backdrop.className = 'label-editor-backdrop';

    const panel = document.createElement('div');
    panel.className = 'label-name-editor';

    // Search row: input + color swatch
    const searchRow = document.createElement('div');
    searchRow.className = 'label-search-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 96;
    input.className = 'label-search-input';
    input.placeholder = title || 'Search species or label\u2026';
    input.value = String(initialValue || '').trim();

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'label-search-color';
    const initialStyle = getOverlayColorStyle(initialColor);
    colorInput.value = initialStyle?.hex || '#0ea5e9';

    searchRow.append(input, colorInput);

    // ── Tags row ──
    const TAG_PRESETS = [
        { key: 'sex', label: 'Sex', options: ['male', 'female', 'unknown'] },
        { key: 'lifeStage', label: 'Life stage', options: ['adult', 'juvenile', 'immature', 'subadult'] },
        { key: 'soundType', label: 'Sound type', options: ['song', 'call', 'alarm call', 'flight call', 'begging call', 'drumming', 'nocturnal flight call'] },
    ];
    const currentTags = { ...(initialTags || {}) };

    const tagsRow = document.createElement('div');
    tagsRow.className = 'label-tags-row';

    /** renders preset selects and the custom tag input */
    const renderTags = () => {
        tagsRow.innerHTML = '';

        // Preset dropdowns
        for (const preset of TAG_PRESETS) {
            const sel = document.createElement('select');
            sel.className = 'label-tag-select';
            sel.title = preset.label;
            const emptyOpt = document.createElement('option');
            emptyOpt.value = '';
            emptyOpt.textContent = preset.label;
            sel.appendChild(emptyOpt);
            for (const opt of preset.options) {
                const optEl = document.createElement('option');
                optEl.value = opt;
                optEl.textContent = opt;
                if (currentTags[preset.key] === opt) optEl.selected = true;
                sel.appendChild(optEl);
            }
            sel.addEventListener('change', () => {
                if (sel.value) currentTags[preset.key] = sel.value;
                else delete currentTags[preset.key];
            });
            tagsRow.appendChild(sel);
        }

        // Show current custom tags as badges + add-button
        const customKeys = Object.keys(currentTags).filter((k) => !TAG_PRESETS.some((p) => p.key === k));
        for (const key of customKeys) {
            const badge = document.createElement('span');
            badge.className = 'label-tag-badge';
            badge.textContent = `${key}: ${currentTags[key]}`;
            const delBtn = document.createElement('span');
            delBtn.className = 'label-tag-badge-del';
            delBtn.textContent = '\u00d7';
            delBtn.addEventListener('click', () => { delete currentTags[key]; renderTags(); });
            badge.appendChild(delBtn);
            tagsRow.appendChild(badge);
        }

        // "+" button to add custom tag
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'label-tag-add';
        addBtn.textContent = '+ Tag';
        addBtn.addEventListener('click', () => {
            const key = prompt('Tag name (e.g. territoryStatus):');
            if (!key?.trim()) return;
            const val = prompt(`Value for "${key.trim()}":`);
            if (val == null) return;
            currentTags[key.trim()] = val.trim();
            renderTags();
        });
        tagsRow.appendChild(addBtn);
    };
    renderTags();

    // Results list
    const results = document.createElement('div');
    results.className = 'label-search-results';

    // Footer with keyboard hints + optional delete
    const footer = document.createElement('div');
    footer.className = 'label-search-footer';
    const hints = document.createElement('span');
    hints.className = 'label-search-hints';
    hints.textContent = '\u2191\u2193 navigate \u00b7 click select \u00b7 dblclick confirm \u00b7 esc close';
    footer.appendChild(hints);

    if (onDelete) {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'label-search-delete';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', () => { close(); onDelete(); });
        footer.appendChild(delBtn);
    }

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'label-search-confirm';
    confirmBtn.textContent = 'Save';
    confirmBtn.addEventListener('click', () => {
        submit(input.value);
    });
    footer.appendChild(confirmBtn);

    panel.append(searchRow, tagsRow, results, footer);
    backdrop.appendChild(panel);
    host.appendChild(backdrop);

    let activeIndex = -1;
    let resultItems = [];
    let selectedScientificName = '';

    const close = () => {
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    };

    backdrop.addEventListener('pointerdown', (e) => {
        if (e.target === backdrop) close();
    });

    const submit = (value, opts = {}) => {
        const trimmed = String(value || '').trim();
        if (!trimmed) return;
        const scientificName = String(opts?.scientificName || selectedScientificName || '').trim();
        // Merge preset tags with any tags passed from a suggestion
        const tags = { ...currentTags, ...(opts?.tags || {}) };
        // Remove empty-valued tags
        for (const k of Object.keys(tags)) { if (!tags[k]) delete tags[k]; }
        onSubmit({ name: trimmed, color: colorInput.value, scientificName, tags });
        close();
    };

    const updateHighlight = () => {
        for (let i = 0; i < resultItems.length; i++) {
            resultItems[i].classList.toggle('active', i === activeIndex);
        }
        if (activeIndex >= 0 && resultItems[activeIndex]) {
            resultItems[activeIndex].scrollIntoView({ block: 'nearest' });
        }
    };

    const renderResults = () => {
        const suggestionMode = player?.getLabelEditorSuggestionMode?.() || 'merge';
        const customOnly = suggestionMode === 'custom-only';
        const taxonomy = player?.getLabelTaxonomy?.() || [];
        const recent = player?.getLabelSuggestions?.('', 8) || [];
        const filtered = player?.getLabelSuggestions?.(input.value, 8) || [];
        const custom = player?.getLabelEditorSuggestions?.(input.value, 14) || [];
        const seen = new Set();
        results.innerHTML = '';
        resultItems = [];
        activeIndex = -1;

        const addResult = ({ name, scientificName = '', color = '', detail = '', tags = {} }) => {
            const label = String(name || '').trim();
            if (!label) return;
            const key = label.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);

            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'label-search-item';

            if (color) {
                const dot = document.createElement('span');
                dot.className = 'label-search-dot';
                const dotHex = getOverlayColorStyle(color)?.hex || color;
                dot.style.background = dotHex;
                row.appendChild(dot);
            }

            const nameSpan = document.createElement('span');
            nameSpan.className = 'label-search-name';
            nameSpan.textContent = label;
            row.appendChild(nameSpan);

            if (scientificName) {
                const sub = document.createElement('span');
                sub.className = 'label-search-sci';
                sub.textContent = scientificName;
                row.appendChild(sub);
            }

            if (detail) {
                const detailSpan = document.createElement('span');
                detailSpan.className = 'label-search-detail';
                detailSpan.textContent = detail;
                row.appendChild(detailSpan);
            }

            row.addEventListener('click', () => {
                // Fill fields — don't close yet so user can adjust tags/color
                input.value = label;
                if (color) colorInput.value = getOverlayColorStyle(color)?.hex || colorInput.value;
                selectedScientificName = String(scientificName || '').trim();
                // Merge suggestion tags into current tag state
                if (tags && typeof tags === 'object') {
                    for (const [k, v] of Object.entries(tags)) {
                        if (v) currentTags[k] = v;
                    }
                    renderTags();
                }
                // Visual feedback: highlight selected row
                for (const item of resultItems) item.classList.remove('selected');
                row.classList.add('selected');
                // Enable the Save button visually
                confirmBtn.disabled = false;
            });
            row.addEventListener('dblclick', () => {
                // Double-click: select + immediately submit
                input.value = label;
                if (color) colorInput.value = getOverlayColorStyle(color)?.hex || colorInput.value;
                selectedScientificName = String(scientificName || '').trim();
                if (tags && typeof tags === 'object') {
                    for (const [k, v] of Object.entries(tags)) {
                        if (v) currentTags[k] = v;
                    }
                }
                submit(label);
            });
            row.addEventListener('pointerenter', () => {
                activeIndex = resultItems.indexOf(row);
                updateHighlight();
            });

            results.appendChild(row);
            resultItems.push(row);
        };

        // Existing labels first (quick re-use)
        if (existingLabels?.length) {
            for (const item of existingLabels) {
                if (typeof item === 'string') {
                    addResult({ name: item });
                } else {
                    addResult({ name: item.name, color: item.color || '', scientificName: item.scientificName || '', tags: item.tags || {} });
                }
            }
        }

        // Custom provider results (e.g. taxonomy-aware labeling app suggestions)
        for (const item of custom) {
            addResult({
                name: item?.name,
                scientificName: item?.scientificName || '',
                color: item?.color || '',
                detail: item?.detail || '',
            });
        }

        if (!customOnly) {
            for (const item of taxonomy) {
                addResult({
                    name: item?.shortcut ? `${item.shortcut}: ${item.name}` : item?.name,
                    color: item?.color || '',
                });
            }
            for (const name of recent) addResult({ name });
            for (const name of filtered) addResult({ name });
        }
    };

    input.addEventListener('input', () => {
        selectedScientificName = '';
        renderResults();
    });

    input.addEventListener('keydown', (e) => {
        const key = /** @type {KeyboardEvent} */ (e).key;
        if (key === 'ArrowDown') {
            e.preventDefault();
            if (resultItems.length) {
                activeIndex = (activeIndex + 1) % resultItems.length;
                updateHighlight();
            }
        } else if (key === 'ArrowUp') {
            e.preventDefault();
            if (resultItems.length) {
                activeIndex = activeIndex <= 0 ? resultItems.length - 1 : activeIndex - 1;
                updateHighlight();
            }
        } else if (key === 'Enter') {
            e.preventDefault();
            if (activeIndex >= 0 && resultItems[activeIndex] && !resultItems[activeIndex].classList.contains('selected')) {
                // First Enter: select the item (fills fields)
                resultItems[activeIndex].click();
            } else {
                // Second Enter or no selection: confirm and close
                submit(input.value);
            }
        } else if (key === 'Escape') {
            e.preventDefault();
            close();
        }
    });

    setTimeout(() => input.focus(), 0);
    input.select();
    renderResults();
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

        const coords = this.player._state?.coords;
        const pps = this.player._state?.pixelsPerSecond || 100;
        const duration = this.player.duration || this.player._state?.audioBuffer?.duration || 0;
        const width = Math.max(1, Math.floor(coords ? coords.timeToScrollX(duration) : duration * pps));
        this.overlay.style.width = `${width}px`;
        this.overlay.innerHTML = '';

        // Swimlane row assignment: stack overlapping regions into rows
        const sorted = [...this.annotations].sort((a, b) => a.start - b.start || a.end - b.end);
        const rowEnds = []; // rowEnds[i] = end time of last region in row i
        const rowMap = new Map();
        for (const region of sorted) {
            let row = -1;
            for (let r = 0; r < rowEnds.length; r++) {
                if (region.start >= rowEnds[r]) {
                    row = r;
                    rowEnds[r] = region.end;
                    break;
                }
            }
            if (row < 0) {
                row = rowEnds.length;
                rowEnds.push(region.end);
            }
            rowMap.set(region.id, row);
        }
        const totalRows = Math.max(1, rowEnds.length);

        // Local overlap clusters via union-find: regions that overlap in time
        // (directly or transitively) form a cluster and share a uniform depth
        // so their top/height positioning never conflicts visually.
        // Isolated regions or non-overlapping clusters keep independent sizing.
        /** @type {Map<string, {depth: number, localRow: number}>} */
        const localLayout = new Map();
        if (totalRows > 1) {
            /** @type {Map<string, string>} */
            const par = new Map();
            /** @param {string} x */
            const find = (x) => {
                while (par.get(x) !== x) {
                    par.set(x, /** @type {string} */ (par.get(/** @type {string} */ (par.get(x)) || x) || x));
                    x = /** @type {string} */ (par.get(x));
                }
                return x;
            };
            for (const r of sorted) par.set(r.id, r.id);

            // Union overlapping pairs (sorted by start → early break)
            for (let i = 0; i < sorted.length; i++) {
                for (let j = i + 1; j < sorted.length; j++) {
                    if (sorted[j].start >= sorted[i].end) break;
                    const ra = find(sorted[i].id), rb = find(sorted[j].id);
                    if (ra !== rb) par.set(ra, rb);
                }
            }

            // Group regions by cluster root
            /** @type {Map<string, Array<{id: string, row: number}>>} */
            const clusters = new Map();
            for (const r of sorted) {
                const root = find(r.id);
                if (!clusters.has(root)) clusters.set(root, []);
                /** @type {Array<{id: string, row: number}>} */ (clusters.get(root)).push({ id: r.id, row: rowMap.get(r.id) ?? 0 });
            }

            for (const [, members] of clusters) {
                if (members.length < 2) continue;
                const rowSet = new Set(members.map(m => m.row));
                const rowsSorted = [...rowSet].sort((a, b) => a - b);
                const depth = rowsSorted.length;
                if (depth < 2) continue;
                for (const m of members) {
                    localLayout.set(m.id, { depth, localRow: rowsSorted.indexOf(m.row) });
                }
            }
        }

        for (const region of this.annotations) {
            const el = this._createRegionElement(region, pps);
            const layout = localLayout.get(region.id);
            if (layout && layout.depth > 1) {
                const pct = 100 / layout.depth;
                el.style.top = `${layout.localRow * pct}%`;
                el.style.height = `${pct}%`;
                el.style.bottom = 'auto';
            }
            this.overlay.appendChild(el);
        }
    }

    _createRegionElement(region, pixelsPerSecond) {
        const coords = this.player?._state?.coords;
        const el = document.createElement('div');
        el.className = 'annotation-region';
        if (this._liveLinkedId && region.id === this._liveLinkedId) el.classList.add('linked-live');
        el.setAttribute('role', 'button');
        el.setAttribute('tabindex', '0');
        const left = coords ? coords.timeToScrollX(region.start) : region.start * pixelsPerSecond;
        const right = coords ? coords.timeToScrollX(region.end) : region.end * pixelsPerSecond;
        el.style.left = `${Math.max(0, left)}px`;
        el.style.width = `${Math.max(1, right - left)}px`;
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
            <span class="annotation-label">${escapeHtml(region.species || 'Annotation')}</span>
            <span class="annotation-confidence">${region.confidence != null ? `${Math.round(region.confidence * 100)}%` : ''}</span>
            <span class="annotation-handle handle-l" data-mode="resize-l"></span>
            <span class="annotation-handle handle-r" data-mode="resize-r"></span>
        `;

        el.addEventListener('click', (event) => {
            if (performance.now() < this._suppressClickUntil) return;
            event.preventDefault();
            event.stopPropagation();
            this.player?._emit?.('labelfocus', { id: region.id, source: 'waveform', interaction: 'click' });
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
            this.player?._emit?.('labelfocus', { id: region.id, source: 'waveform', interaction: 'click' });
            const handle = /** @type {HTMLElement | null} */ (event.target)?.closest?.('.annotation-handle');
            const mode = /** @type {HTMLElement | null} */ (handle)?.dataset?.mode || 'move';
            this._startEditInteraction(region.id, mode, event.clientX, el);
            event.preventDefault();
            event.stopPropagation();
        });
        el.addEventListener('pointerenter', (event) => {
            this._lastPointerX = event.clientX;
            this.player?._emit?.('labelfocus', { id: region.id, source: 'waveform', interaction: 'hover' });
        });
        el.addEventListener('pointerleave', () => {
            if (!this._grabbing && !this._editing) {
                this.player?._emit?.('labelfocus', { id: null, source: 'waveform', interaction: 'hover' });
            }
        });
        el.addEventListener('pointermove', (event) => {
            this._lastPointerX = event.clientX;
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
            const coords = this.player?._state?.coords;
            const left = coords ? coords.timeToScrollX(region.start) : region.start * pps;
            const right = coords ? coords.timeToScrollX(region.end) : region.end * pps;
            el.style.left = `${Math.max(0, left)}px`;
            el.style.width = `${Math.max(1, right - left)}px`;
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

    /**
     * Blender-style grab for waveform annotations (horizontal only).
     */
    startGrab(annotationId) {
        const region = this.annotations.find((a) => a.id === annotationId);
        if (!region || this._grabbing) return;
        const el = this.overlay?.querySelector?.(`.annotation-region[data-id="${region.id}"]`);
        if (!el) return;

        const snapshot = { ...region };
        el.classList.add('editing');
        const startX = this._lastPointerX ?? 0;

        this._editing = {
            id: annotationId,
            mode: 'move',
            startX,
            startRegion: snapshot,
            element: el,
            pending: false,
            moved: true,
            forceSuppressClick: true,
        };
        this._grabbing = true;

        const onMove = (e) => {
            this._updateEditInteraction(e.clientX);
        };
        const confirm = (e) => {
            e?.preventDefault?.();
            e?.stopPropagation?.();
            cleanup();
            this._finishEditInteraction();
        };
        const cancel = (e) => {
            e?.preventDefault?.();
            e?.stopPropagation?.();
            cleanup();
            Object.assign(region, snapshot);
            el.classList.remove('editing');
            this._editing = null;
            this._suppressClickUntil = performance.now() + 250;
            this.render();
        };
        const onKey = (e) => {
            if (e.key === 'Escape') cancel(e);
            if (e.key === 'g') confirm(e);
        };
        const cleanup = () => {
            this._grabbing = false;
            document.removeEventListener('pointermove', onMove, true);
            document.removeEventListener('pointerdown', confirm, true);
            document.removeEventListener('keydown', onKey, true);
        };

        document.addEventListener('pointermove', onMove, true);
        document.addEventListener('pointerdown', confirm, true);
        document.addEventListener('keydown', onKey, true);
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
        this._focusedLabelId = null;
        this._clipboard = null;
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
        this._unsubs.push(this.player.on('labelfocus', (e) => {
            this._focusedLabelId = e?.detail?.id || null;
        }));
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

    copyLabel(id) {
        const label = this.labels.find((l) => l.id === id);
        if (!label) return;
        this._clipboard = { ...label };
    }

    pasteLabel(atTime = null) {
        if (!this._clipboard) return null;
        const src = this._clipboard;
        const duration = src.end - src.start;
        const t = atTime ?? (this.player?.currentTime ?? src.start);
        const region = this._normalize({
            start: t,
            end: t + duration,
            freqMin: src.freqMin,
            freqMax: src.freqMax,
            label: src.label,
            color: src.color,
            scientificName: src.scientificName,
            commonName: src.commonName,
            origin: src.origin,
            author: src.author,
            tags: src.tags ? { ...src.tags } : {},
        });
        this.add(region);
        return region;
    }

    /** Returns the focused label, falling back to the most recently added label. */
    _getReferenceLabelForDefaults() {
        if (this._focusedLabelId) {
            const focused = this.labels.find((l) => l.id === this._focusedLabelId);
            if (focused) return focused;
        }
        return this.labels.length ? this.labels[this.labels.length - 1] : null;
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
        const c = state?.coords;
        const duration = this.player.duration || state?.audioBuffer?.duration || 0;
        const pps = state?.pixelsPerSecond || 100;
        const width = Math.max(1, Math.floor(c ? c.timeToScrollX(duration) : duration * pps));
        const height = Math.max(1, state?.d?.spectrogramCanvas?.height || 1);
        this.overlay.style.width = `${width}px`;
        this.overlay.style.height = `${height}px`;
        this.overlay.innerHTML = '';

        const elements = [];
        const geometries = [];
        for (const label of this.labels) {
            const el = this._createLabelElement(label, width, height);
            const geo = this._toGeometry(label, width, height);
            this.overlay.appendChild(el);
            elements.push(el);
            geometries.push(geo);
        }
        // Resolve overlapping text badges
        this._resolveTextCollisions(elements, geometries);
    }

    /**
     * Detect overlapping text badges and nudge colliding ones to bottom-left.
     * Uses a simple greedy approach: first label keeps top-left, subsequent
     * labels that would collide get moved to bottom-left of their box.
     * @param {HTMLElement[]} elements
     * @param {Array<{left: number, top: number, width: number, height: number}>} geometries
     */
    _resolveTextCollisions(elements, geometries) {
        const TEXT_H = 16;
        const occupiedRects = [];

        for (let i = 0; i < elements.length; i++) {
            const geo = geometries[i];
            const textEl = elements[i].querySelector('.spectrogram-label-text');
            if (!textEl) continue;

            const textWidth = Math.min(Math.max(geo.width * 0.7, 100), 200);
            let rect = {
                left: geo.left,
                top: geo.top,
                right: geo.left + textWidth,
                bottom: geo.top + TEXT_H,
            };

            const collides = occupiedRects.some((r) =>
                rect.left < r.right && rect.right > r.left &&
                rect.top < r.bottom && rect.bottom > r.top,
            );

            if (collides) {
                textEl.classList.add('label-text-bottom');
                rect = {
                    left: geo.left,
                    top: geo.top + geo.height - TEXT_H,
                    right: geo.left + textWidth,
                    bottom: geo.top + geo.height,
                };
            }

            occupiedRects.push(rect);
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
            <span class="spectrogram-label-text">${escapeHtml(label.label || 'Label')}</span>
            <span class="spectrogram-label-meta">${Math.round(label.freqMin)}-${Math.round(label.freqMax)} Hz</span>
            <button class="label-edit-btn" type="button" title="Edit label">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
                </svg>
            </button>
            <button class="label-delete-btn" type="button" title="Delete label">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                </svg>
            </button>
            <span class="label-handle handle-tl" data-mode="resize-tl"></span>
            <span class="label-handle handle-tr" data-mode="resize-tr"></span>
            <span class="label-handle handle-bl" data-mode="resize-bl"></span>
            <span class="label-handle handle-br" data-mode="resize-br"></span>
            <span class="label-handle handle-l" data-mode="resize-l"></span>
            <span class="label-handle handle-r" data-mode="resize-r"></span>
            <span class="label-handle handle-t" data-mode="resize-t"></span>
            <span class="label-handle handle-b" data-mode="resize-b"></span>
        `;

        const editBtn = /** @type {HTMLButtonElement | null} */ (el.querySelector('.label-edit-btn'));
        if (editBtn) {
            editBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                this._suppressClickUntil = performance.now() + 250;
                this._renameSpectrogramLabelPrompt(label.id);
            });
            editBtn.addEventListener('pointerdown', (event) => {
                event.stopPropagation();
            });
        }

        const deleteBtn = /** @type {HTMLButtonElement | null} */ (el.querySelector('.label-delete-btn'));
        if (deleteBtn) {
            deleteBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                this._suppressClickUntil = performance.now() + 250;
                this.remove(label.id);
                this.player?._emit?.('spectrogramlabelremove', { label: { ...label } });
            });
            deleteBtn.addEventListener('pointerdown', (event) => {
                event.stopPropagation();
            });
        }

        el.addEventListener('click', (event) => {
            if (performance.now() < this._suppressClickUntil) return;
            event.stopPropagation();
            event.preventDefault();
            this.player?._emit?.('labelfocus', { id: label.id, source: 'spectrogram', interaction: 'click' });
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
            this.player?._emit?.('labelfocus', { id: label.id, source: 'spectrogram', interaction: 'click' });
            const handle = /** @type {HTMLElement | null} */ (event.target)?.closest?.('.label-handle');
            const mode = /** @type {HTMLElement | null} */ (handle)?.dataset?.mode || 'move';
            this._startEditInteraction(label.id, mode, event.clientX, event.clientY, el);
            event.preventDefault();
            event.stopPropagation();
        });
        el.addEventListener('pointerenter', (event) => {
            this._lastPointerX = event.clientX;
            this._lastPointerY = event.clientY;
            this.player?._emit?.('labelfocus', { id: label.id, source: 'spectrogram', interaction: 'hover' });
        });
        el.addEventListener('pointerleave', () => {
            if (!this._grabbing && !this._editing) {
                this.player?._emit?.('labelfocus', { id: null, source: 'spectrogram', interaction: 'hover' });
            }
        });
        el.addEventListener('pointermove', (event) => {
            this._lastPointerX = event.clientX;
            this._lastPointerY = event.clientY;
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
        const c = this.player?._state?.coords;
        const duration = c?.duration || Math.max(0.001, this.player?.duration || this.player?._state?.audioBuffer?.duration || 0.001);

        const x1 = c ? clamp(c.timeToPixelX(label.start), 0, canvasWidth) : clamp((label.start / duration) * canvasWidth, 0, canvasWidth);
        const x2 = c ? clamp(c.timeToPixelX(label.end), 0, canvasWidth) : clamp((label.end / duration) * canvasWidth, 0, canvasWidth);
        const yHigh = c ? clamp(c.frequencyToPixelY(label.freqMax), 0, canvasHeight) : 0;
        const yLow = c ? clamp(c.frequencyToPixelY(label.freqMin), 0, canvasHeight) : canvasHeight;

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
                this._clearDraft();
                if (region) {
                    this._openNewLabelPicker(region);
                }
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

    _openNewLabelPicker(region) {
        // Collect unique labels with their colors for quick pick
        const seen = new Set();
        const existingLabels = [];
        for (const l of this.labels) {
            const name = (l.label || '').trim();
            if (!name) continue;
            const key = name.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            existingLabels.push({ name, color: l.color || '', scientificName: l.scientificName || '', tags: l.tags || {} });
        }
        // Pre-fill from focused/last label
        const ref = this._getReferenceLabelForDefaults();
        const initialColor = ref?.color || _autoAssignColor(this.labels);
        const refName = (ref?.label || '').trim().toLowerCase();
        const initialHex = (getOverlayColorStyle(initialColor)?.hex || '').toLowerCase();
        openLabelNameEditor({
            player: this.player,
            initialValue: ref?.label || '',
            initialColor,
            initialTags: ref?.tags || null,
            existingLabels,
            title: 'New Label',
            onSubmit: ({ name, color, scientificName = '', tags = {} }) => {
                // If user typed a different name but didn't manually change color,
                // auto-assign a deterministic color for the new name.
                const nameChanged = name.trim().toLowerCase() !== refName;
                const colorUntouched = (color || '').toLowerCase() === initialHex;
                region.label = name;
                region.color = (nameChanged && colorUntouched) ? colorForName(name) : color;
                region.scientificName = String(scientificName || '').trim();
                region.tags = tags;
                this.add(region);
            },
        });
    }

    _startEditInteraction(labelId, mode, clientX, clientY, element) {
        const label = this.labels.find((l) => l.id === labelId);
        if (!label) return;
        this._editing = {
            id: labelId,
            mode,
            startX: clientX,
            startY: clientY,
            startTime: this._clientXToTime(clientX),
            startFreq: this._clientYToFreq(clientY),
            startCanvasY: this._clientYToCanvasY(clientY),
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
        const c = this.player?._state?.coords;

        // Use CoordinateSystem for time delta
        const currentTime = this._clientXToTime(clientX);
        const dt = currentTime - editing.startTime;

        // Compute frequency changes in pixel space so that on a mel
        // (logarithmic) scale dragging still feels perceptually linear.
        const currentCanvasY = this._clientYToCanvasY(clientY);
        const deltaCanvasY = currentCanvasY - editing.startCanvasY;

        const src = this._editing.startLabel;

        // Pixel-Y positions of the original label edges (via CoordinateSystem)
        const srcMaxPy = c ? c.frequencyToPixelY(src.freqMax) : 0;
        const srcMinPy = c ? c.frequencyToPixelY(src.freqMin) : height;

        /** Shift a frequency edge by deltaCanvasY in pixel space, then convert back to Hz. */
        const shiftedFreq = (origFreq) => {
            if (!c) return origFreq;
            const origPy = c.frequencyToPixelY(origFreq);
            return c.pixelYToFrequency(origPy + deltaCanvasY);
        };

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
                next.freqMin = shiftedFreq(src.freqMin);
                next.freqMax = shiftedFreq(src.freqMax);
                break;
            case 'resize-l':
                next.start = src.start + dt;
                break;
            case 'resize-r':
                next.end = src.end + dt;
                break;
            case 'resize-t':
                next.freqMax = shiftedFreq(src.freqMax);
                break;
            case 'resize-b':
                next.freqMin = shiftedFreq(src.freqMin);
                break;
            case 'resize-tl':
                next.start = src.start + dt;
                next.freqMax = shiftedFreq(src.freqMax);
                break;
            case 'resize-tr':
                next.end = src.end + dt;
                next.freqMax = shiftedFreq(src.freqMax);
                break;
            case 'resize-bl':
                next.start = src.start + dt;
                next.freqMin = shiftedFreq(src.freqMin);
                break;
            case 'resize-br':
                next.end = src.end + dt;
                next.freqMin = shiftedFreq(src.freqMin);
                break;
            default:
                break;
        }

        next = this._normalize({ ...src, ...next, id: src.id, label: src.label, color: src.color });

        // Preserve band thickness on pure move (in pixel space, not Hz)
        if (this._editing.mode === 'move') {
            const timeSpan = Math.max(0.01, src.end - src.start);
            next.end = next.start + timeSpan;

            // Keep the original pixel height: shift freqMax from freqMin's
            // new pixel position by the original pixel span.
            const origPixelSpan = Math.abs(srcMinPy - srcMaxPy);
            const newMinPy = c ? c.frequencyToPixelY(next.freqMin) : height;
            const newMaxPy = newMinPy - origPixelSpan;  // top = lower Y
            next.freqMax = c ? c.pixelYToFrequency(Math.max(0, newMaxPy)) : next.freqMax;

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

    /**
     * Blender-style grab: label follows the mouse until click (confirm) or Escape (cancel).
     */
    startGrab(labelId) {
        const label = this.labels.find((l) => l.id === labelId);
        if (!label || this._grabbing) return;
        const el = this.overlay?.querySelector?.(`.spectrogram-label-region[data-id="${label.id}"]`);
        if (!el) return;

        const snapshot = { ...label };
        el.classList.add('editing');

        // Use the last known pointer position so the label doesn't jump.
        const startX = this._lastPointerX ?? 0;
        const startY = this._lastPointerY ?? 0;

        this._editing = {
            id: labelId,
            mode: 'move',
            startX,
            startY,
            startTime: this._clientXToTime(startX),
            startFreq: this._clientYToFreq(startY),
            startCanvasY: this._clientYToCanvasY(startY),
            startLabel: snapshot,
            element: el,
            pending: false,
            moved: true,
            forceSuppressClick: true,
        };
        this._grabbing = true;

        const onMove = (e) => {
            this._updateEditInteraction(e.clientX, e.clientY);
        };
        const confirm = (e) => {
            e?.preventDefault?.();
            e?.stopPropagation?.();
            cleanup();
            this._finishEditInteraction();
        };
        const cancel = (e) => {
            e?.preventDefault?.();
            e?.stopPropagation?.();
            cleanup();
            // Restore original position
            Object.assign(label, snapshot);
            el.classList.remove('editing');
            this._editing = null;
            this._suppressClickUntil = performance.now() + 250;
            this.render();
        };
        const onKey = (e) => {
            if (e.key === 'Escape') cancel(e);
            if (e.key === 'g') confirm(e);
        };
        const cleanup = () => {
            this._grabbing = false;
            document.removeEventListener('pointermove', onMove, true);
            document.removeEventListener('pointerdown', confirm, true);
            document.removeEventListener('keydown', onKey, true);
        };

        document.addEventListener('pointermove', onMove, true);
        document.addEventListener('pointerdown', confirm, true);
        document.addEventListener('keydown', onKey, true);
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
            initialTags: label.tags || {},
            onSubmit: ({ name, color, scientificName = '', tags = {} }) => {
                const currentHex = getOverlayColorStyle(label.color)?.hex || '';
                const nextSci = String(scientificName || '').trim();
                const prevSci = String(label.scientificName || '').trim();
                if (name === current && color === currentHex && nextSci === prevSci && JSON.stringify(tags) === JSON.stringify(label.tags || {})) return;
                label.label = name;
                label.color = color;
                label.tags = tags;
                if (nextSci) label.scientificName = nextSci;
                // Apply color to all labels with the same name
                const labelKey = name.toLowerCase();
                for (const other of this.labels) {
                    if (other.id !== label.id && (other.label || '').toLowerCase() === labelKey) {
                        other.color = color;
                        this.player?._emit?.('spectrogramlabelupdate', { label: { ...other } });
                    }
                }
                this.player?._emit?.('spectrogramlabelupdate', { label: { ...label } });
                this.render();
            },
            onDelete: () => {
                this.remove(id);
                this.player?._emit?.('spectrogramlabelremove', { label: { ...label } });
            },
        });
    }

    _clientXToTime(clientX) {
        return this.player?._state?._clientXToTime?.(clientX, 'spectrogram') || 0;
    }

    _clientYToCanvasY(clientY) {
        const state = this.player?._state;
        const c = state?.coords;
        const wrapper = state?.d?.canvasWrapper;
        if (!wrapper || !c) return 0;
        const rect = wrapper.getBoundingClientRect();
        const localY = clamp(clientY - rect.top, 0, rect.height);
        return localY / Math.max(1, rect.height) * c.canvasHeight;
    }

    _clientYToFreq(clientY) {
        const state = this.player?._state;
        const c = state?.coords;
        const wrapper = state?.d?.canvasWrapper;
        if (!wrapper || !c) return 0;
        const rect = wrapper.getBoundingClientRect();
        const localY = clamp(clientY - rect.top, 0, rect.height);
        const canvasY = localY / Math.max(1, rect.height) * c.canvasHeight;
        return c.pixelYToFrequency(canvasY);
    }

    _getMaxFreq() {
        const state = this.player?._state;
        const selected = parseFloat(state?.d?.maxFreqSelect?.value || '10000');
        const nyquist = (state?.sampleRateHz || DEFAULT_SAMPLE_RATE) / 2;
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
        const labelName = label?.label || '';
        const explicitColor = String(label?.color || '').trim();
        return {
            id: label?.id || `slabel_${Math.random().toString(36).slice(2, 10)}`,
            start: s,
            end: Math.max(s + 0.01, e),
            freqMin: f0,
            freqMax: Math.max(f0 + 1, f1),
            label: labelName,
            color: explicitColor || colorForName(labelName),
            scientificName: String(label?.scientificName || '').trim(),
            commonName: String(label?.commonName || '').trim(),
            origin: String(label?.origin || '').trim(),
            author: String(label?.author || '').trim(),
            tags: (label?.tags && typeof label.tags === 'object') ? { ...label.tags } : {},
        };
    }
}
