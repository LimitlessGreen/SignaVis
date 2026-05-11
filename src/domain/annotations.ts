// ═══════════════════════════════════════════════════════════════════════
// annotations.js — Region layer for detections/annotations
// ═══════════════════════════════════════════════════════════════════════

import { escapeHtml, clamp } from '../shared/utils.ts';
import { DEFAULT_SAMPLE_RATE } from '../shared/constants.ts';
import { LabelEditorModal } from '../ui/components/label-editor/LabelEditorModal.ts';
import type { AnnotationRegion, SpectrogramLabel } from '../shared/label.types.ts';
import { normalizeLabelStrings } from '../shared/labelNormalize.ts';


const _colorCtx = (() => {
    try {
        const canvas = document.createElement('canvas');
        return canvas.getContext('2d');
    } catch {
        return null;
    }
})();

export function parseColorToRgb(color: unknown): { r: number; g: number; b: number } | null {
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

function _rgbToHex({ r, g, b }: { r: number; g: number; b: number }) {
    const toHex = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function getOverlayColorStyle(color: unknown): { fill: string; edge: string; soft: string; hex: string } | null {
    const rgb = parseColorToRgb(color);
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
export function colorForName(name: unknown): string {
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
function _autoAssignColor(existingLabels: any[]) {
    // Extract existing hues
    const usedHues = [];
    for (const lbl of existingLabels) {
        const rgb = parseColorToRgb(lbl.color);
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

function _hslToHex(h: number, s: number, l: number) {
    s /= 100;
    l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
        const k = (n + h / 30) % 12;
        const color = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
        return Math.round(255 * clamp(color, 0, 1));
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
 * @param {string|null} [opts.initialScientificName]
 * @param {string|null} [opts.title]
 * @param {function(import('./annotations/LabelEditorModal.ts').LabelEditResult):void} opts.onSubmit
 * @param {(function():void)|null} [opts.onDelete]
 */
/**
 * Open the label editor modal. If `opts.layer` is provided (an AnnotationLayerBase
 * instance), tag-management events (tagcustom*) are dispatched on that layer
 * instead of calling player._emit() directly — eliminating the circular dependency.
 * @param {any} opts
 */
function openLabelNameEditor(opts: any) {
    const layer = opts?.layer;
    const rest  = { ...opts };
    delete rest.layer;
    // Wire onLayerEmit: dispatch tag events on the layer (which BirdNETPlayer
    // already listens to), or fall back to player._emit for legacy callers.
    const onLayerEmit = layer
        ? (event: string, detail: any) => layer.dispatchEvent(new CustomEvent(String(event), { detail }))
        : (event: string, detail: any) => opts.player?._emit?.(event, detail);
    const modal = new LabelEditorModal({ ...rest, onLayerEmit });
    modal.open();
    return modal;
}


// Export helper for tests that need to exercise the label editor behavior
export { openLabelNameEditor };

export type { AnnotationRegion } from '../shared/label.types.ts';

// ═══════════════════════════════════════════════════════════════════════
// AnnotationLayerBase — shared lifecycle, CRUD, and selection for all
// annotation/label overlay layers.
// ═══════════════════════════════════════════════════════════════════════

class AnnotationLayerBase extends EventTarget {
    declare player: any;
    declare overlay: HTMLElement | null;
    declare _items: any[];
    declare _liveLinkedId: string | null;
    declare _unsubs: Array<() => void>;
    declare _domCleanups: Array<() => void>;
    declare _editing: any | null;
    declare _suppressClickUntil: number;
    declare _multiSelectedIds: Set<string>;
    declare _lastPointerX: number | null;
    declare _lastPointerY: number | null;
    declare _grabbing: boolean;
    declare drawMode: boolean;
    declare stampMode: boolean;
    declare _stampGhostEl: HTMLElement | null;
    declare _stampAxisLock: boolean;
    declare _stampRefLabelId: string | null;
    declare _axisConstraint: 'x' | 'y' | null;
    declare _draftEl: HTMLElement | null;
    declare _drawing: any | null;
    declare _counter: number;
    declare _suppressContextMenuUntil: number;
    declare _focusedLabelId: string | null;
    declare _selectedLabelId: string | null;
    declare _lockedIds: Set<string>;
    declare _clipboard: any | null;
    constructor() {
        super();
        this.player = null;
        this.overlay = null;
        /** @type {any[]} */
        this._items = [];
        this._liveLinkedId = null;
        this._unsubs = [];
        this._domCleanups = [];
        /** @type {any} */
        this._editing = null;
        this._suppressClickUntil = 0;
        /** @type {Set<string>} */
        this._multiSelectedIds = new Set();
        /** @type {Set<string>} */
        this._lockedIds = new Set();
        this._lastPointerX = 0;
        this._lastPointerY = 0;
        this._grabbing = false;
    }

    // ── Template-method hooks (override in subclass) ─────────────────
    /** CSS class name for the created overlay element. */
    get _overlayClassName() { return 'annotation-layer-base'; }
    /** CSS selector matching all item elements within the overlay. */
    get _itemElSelector() { return '.annotation-item'; }
    /** Return the DOM root element to mount the overlay into. */
    _getRoot(): HTMLElement | null { return null; }
    /** Subscribe player events. Called inside attach(), after overlay creation. */
    _subscribePlayerEvents() {}
    /** Bind mouse/pointer interactions. Called inside attach(), after overlay creation. */
    _bindInteractions(_root: HTMLElement) {}
    /**
     * Normalize a raw item object (must return object with .id).
     * @param {*} _item
     * @returns {{id: string}}
     * @abstract
     */
    _normalize(_item: any): any { throw new Error(`${this.constructor.name}._normalize not implemented`); }
    /** Emit a player event when a new item is created via add(). */
    _emitCreate(_item: any) {}
    /** Emit a player event when an item is updated after drag/resize. */
    _emitUpdate(_item: any) {}

    // ── Lifecycle ────────────────────────────────────────────────────
    /** Render the overlay. Override in subclasses; default no-op for base typing. */
    render() {}

    attach(player: unknown): void {
        this.detach();
        this.player = player;
        const root = this._getRoot();
        if (!root) return;
        this.overlay = document.createElement('div');
        this.overlay.className = this._overlayClassName;
        root.appendChild(this.overlay);
        this._subscribePlayerEvents();
        this._bindInteractions(root);
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

    // ── CRUD ─────────────────────────────────────────────────────────
    add(item: Record<string, unknown>): void {
        const region = this._normalize(item);
        this._items.push(region);
        this.render();
        this._emitCreate(region);
        return region.id;
    }

    set(items: Record<string, unknown>[] = []): void {
        this._items = items.map((i) => this._normalize(i));
        this.render();
    }

    clear() {
        this._items = [];
        this.render();
    }

    remove(id: string): void {
        this._items = this._items.filter((i: any) => i.id !== id);
        this.render();
    }

    getAll() {
        return [...this._items];
    }

    // ── Linked / Selection ───────────────────────────────────────────
    setLiveLinkedId(id: string | null = null): void {
        this._liveLinkedId = id || null;
    }

    setMultiSelected(ids: string[]): void {
        this._multiSelectedIds = new Set(ids);
        this._updateMultiSelectedVisual();
    }

    setLockedIds(ids: string[] = []): void {
        this._lockedIds = new Set(ids);
        this.render();
    }

    toggleMultiSelected(id: string): void {
        if (this._multiSelectedIds.has(id)) this._multiSelectedIds.delete(id);
        else this._multiSelectedIds.add(id);
        this._updateMultiSelectedVisual();
    }

    _updateMultiSelectedVisual() {
        if (!this.overlay) return;
        for (const el of this.overlay.querySelectorAll(this._itemElSelector)) {
            const h = el as HTMLElement;
            h.classList.toggle('multi-selected', this._multiSelectedIds.has(h.dataset?.id || ''));
        }
    }

    // ── Edit interaction shared finish ───────────────────────────────
    _finishEditInteraction() {
        if (!this._editing) return;
        const editing = this._editing as any;
        const shouldSuppressClick = editing.forceSuppressClick || editing.moved;
        editing.element?.classList?.remove('editing');
        const item = this._items.find((i: any) => i.id === editing.id);
        if (item && editing.moved) this._emitUpdate(item);
        this._editing = null;
        if (shouldSuppressClick) {
            this._suppressClickUntil = performance.now() + 250;
            this.render();
        }
    }
}

export class AnnotationLayer extends AnnotationLayerBase {
    overlay: any;
    _items: any;
    _liveLinkedId: any;
    _unsubs: any;
    _domCleanups: any;
    _editing: any;
    _suppressClickUntil: any;
    _multiSelectedIds: any;
    _lastPointerX: any;
    _lastPointerY: any;
    _grabbing: any;
    appendChild: any;
    closest: any;
    preventDefault: any;
    stopPropagation: any;
    drawMode: any;
    stampMode: any;
    _stampGhostEl: any;
    _stampAxisLock: any;
    _stampRefLabelId: any;
    _axisConstraint: any;
    _draftEl: any;
    _drawing: any;
    _counter: any;
    _suppressContextMenuUntil: any;
    _focusedLabelId: any;
    _selectedLabelId: any;
    _lockedIds: any;
    _clipboard: any;
    detail: any;
    target: any;
    length: any;
    map: any;
    name: any;
    // ── Template-method overrides ────────────────────────────────────
    get _overlayClassName() { return 'annotation-layer'; }
    get _itemElSelector() { return '.annotation-region'; }

    _getRoot() {
        return this.player?._state?.d?.waveformContent || this.player?.root?.querySelector('.waveform-content');
    }

    _subscribePlayerEvents() {
        this._unsubs.push(this.player.on('ready', () => this.render()));
        this._unsubs.push(this.player.on('zoomchange', () => this.render()));
        this._unsubs.push(this.player.on('viewresize', () => this.render()));
        this._unsubs.push(this.player.on('seek', (e: any) => this.highlightActiveRegion(e.detail.currentTime)));
        this._unsubs.push(this.player.on('timeupdate', (e: any) => this.highlightActiveRegion(e.detail.currentTime)));
        this._unsubs.push(this.player.on('labelfocus', (e: any) => {
            const id = e?.detail?.id || null;
            const interaction = e?.detail?.interaction;
            if (interaction === 'click') {
                this._selectedLabelId = id;
                this._updateSelectedVisual();
            } else {
                this._focusedLabelId = id;
                this._updateFocusedVisual();
            }
        }));
    }

    _updateFocusedVisual() {
        if (!this.overlay) return;
        for (const el of this.overlay.querySelectorAll('.annotation-region')) {
            const h = el as HTMLElement;
            h.classList.toggle('annotation-region--focused', !!this._focusedLabelId && h.dataset?.id === this._focusedLabelId);
        }
    }

    _updateSelectedVisual() {
        if (!this.overlay) return;
        for (const el of this.overlay.querySelectorAll('.annotation-region')) {
            const h = el as HTMLElement;
            h.classList.toggle('annotation-region--selected', !!this._selectedLabelId && h.dataset?.id === this._selectedLabelId);
        }
    }

    _bindInteractions(root: HTMLElement) { this._bindEditingInteractions(root); }

    _emitCreate(region: any) { this.player?._emit?.('annotationcreate', { annotation: { ...(region as any) } }); }
    _emitUpdate(item: any) { this.player?._emit?.('annotationupdate', { annotation: { ...(item as any) } }); }

    /** Public alias for the internal items array (backward compat). */
    get annotations() { return this._items; }

    highlightActiveRegion(currentTime: number) {
        if (!this.overlay) return;
            for (const el of this.overlay.querySelectorAll(this._itemElSelector)) {
                const h = el as HTMLElement;
            const start = parseFloat(h.dataset.start || '0');
            const end = parseFloat(h.dataset.end || '0');
            el.classList.toggle('active', currentTime >= start && currentTime <= end);
        }
    }

    exportRavenFormat(regions = this._items) {
        return regions
            .map((r: any) => `${r.start}\t${r.end}\t${r.species || ''}\t${r.confidence ?? ''}`)
            .join('\n');
    }

    render() {
        if (!this.overlay || !this.player) return;
        if (this._editing) return;

        const coords = this.player._state?.coords;
        const pps = this.player._state?.pixelsPerSecond || 100;
        const duration = this.player.duration || this.player._state?.audioBuffer?.duration || 0;
        const width = Math.max(1, Math.floor(coords ? coords.timeToScrollX(duration) : duration * pps));
        this.overlay.style.width = `${width}px`;
        this.overlay.innerHTML = '';

        // Swimlane row assignment: stack overlapping regions into rows
        const sorted = [...this._items].sort((a, b) => a.start - b.start || a.end - b.end);
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
        const localLayout = new Map<string, { depth: number; localRow: number }>();
        if (totalRows > 1) {
            const par = new Map<string, string>();
            const find = (x: string) => {
                while (par.get(x) !== x) {
                    par.set(x, (par.get(par.get(x) || x) || x) as string);
                    x = String(par.get(x));
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
            const clusters = new Map<string, Array<{ id: string; row: number }>>();
            for (const r of sorted) {
                const root = find(r.id);
                if (!clusters.has(root)) clusters.set(root, []);
                (clusters.get(root) as Array<{ id: string; row: number }>).push({ id: r.id, row: rowMap.get(r.id) ?? 0 });
            }

            for (const [, members] of clusters) {
                if (members.length < 2) continue;
                const rowSet = new Set(members.map((m: any) => m.row));
                const rowsSorted = [...rowSet].sort((a, b) => a - b);
                const depth = rowsSorted.length;
                if (depth < 2) continue;
                for (const m of members) {
                    localLayout.set(m.id, { depth, localRow: rowsSorted.indexOf(m.row) });
                }
            }
        }

        for (const region of this._items) {
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

        // Re-acquire editing element after innerHTML wipe
        if (this._editing) {
            const editing = this._editing as any;
            const freshEl = this.overlay.querySelector(
                `.annotation-region[data-id="${editing.id}"]`,
            );
            if (freshEl) {
                editing.element = freshEl as HTMLElement;
                freshEl.classList.add('editing');
            }
        }
        this._updateMultiSelectedVisual();
        this._updateFocusedVisual();
        this._updateSelectedVisual();
    }

    _createRegionElement(region: any, pixelsPerSecond: number): HTMLElement {
        const coords = this.player?._state?.coords;
        const el = document.createElement('div');
        const isLocked = this._lockedIds.has(region.id);
        const isBlocked = isLocked || region.readonly === true;
        el.className = 'annotation-region';
        if (region.readonly) el.classList.add('annotation-region--readonly');
        if (isLocked) el.classList.add('annotation-region--locked');
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
        const readonlyNote = isBlocked ? ' [gesperrt]' : '';
        el.title = `${region.species || 'Annotation'} (${region.start.toFixed(2)}s–${region.end.toFixed(2)}s)${readonlyNote}`;
        el.setAttribute('aria-label', el.title);
        const confidenceStr = region.confidence != null ? `${Math.round(region.confidence * 100)}%` : '';
        const aiTag = region.aiSuggested ? `<span class="annotation-ai-badge" title="AI: ${escapeHtml(region.aiSuggested.model || '')} ${escapeHtml(region.aiSuggested.version || '')}">AI</span>` : '';
        const lockIcon = isBlocked ? `<span class="annotation-lock" title="${region.readonly ? 'Read-only (imported from XC)' : 'Locked'}">🔒</span>` : '';
        el.innerHTML = `
            <span class="annotation-label">${escapeHtml(region.species || 'Annotation')}</span>
            <span class="annotation-confidence">${confidenceStr}</span>
            ${aiTag}${lockIcon}
            ${isBlocked ? '' : `
            <span class="annotation-handle handle-l" data-mode="resize-l"></span>
            <span class="annotation-handle handle-r" data-mode="resize-r"></span>
            `}
        `;

        el.addEventListener('click', (event) => {
            if (performance.now() < this._suppressClickUntil) return;
            event.preventDefault();
            event.stopPropagation();
            if (event.ctrlKey || event.metaKey) {
                this.dispatchEvent(new CustomEvent('labelfocus', { detail: { id: region.id, source: 'waveform', interaction: 'ctrl-click' } }));
                return;
            }
            this.dispatchEvent(new CustomEvent('labelfocus', { detail: { id: region.id, source: 'waveform', interaction: 'click' } }));
            this.player?._state?._blockSeekClicks?.(260);
            this.player?.playSegment?.(region.start, region.end, { labelId: region.id });
        });
        el.addEventListener('dblclick', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (isBlocked) return;
            this._suppressClickUntil = performance.now() + 250;
            this._renameRegionPrompt(region.id);
        });
        el.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            if (isBlocked) { event.preventDefault(); event.stopPropagation(); return; }
            const handle = (event.target as Element | null)?.closest?.('.annotation-handle') as HTMLElement | null;
            const mode = handle?.dataset?.mode || 'move';
            this._startEditInteraction(region.id, mode, event.clientX, el);
            event.preventDefault();
            event.stopPropagation();
            this.dispatchEvent(new CustomEvent('labelfocus', { detail: { id: region.id, source: 'waveform', interaction: 'click' } }));
        });
        el.addEventListener('pointerenter', (event) => {
            this._lastPointerX = event.clientX;
            this.dispatchEvent(new CustomEvent('labelfocus', { detail: { id: region.id, source: 'waveform', interaction: 'hover' } }));
        });
        el.addEventListener('pointerleave', () => {
            if (!this._grabbing && !this._editing) {
                this.dispatchEvent(new CustomEvent('labelfocus', { detail: { id: null, source: 'waveform', interaction: 'hover' } }));
            }
        });
        el.addEventListener('pointermove', (event) => {
            this._lastPointerX = event.clientX;
        });
        return el;
    }

    _bindEditingInteractions(root: HTMLElement) {
        const onPointerMove = (e: PointerEvent) => {
            if (!this._editing) return;
            this._updateEditInteraction(e.clientX);
            e.preventDefault();
            e.stopPropagation();
        };

        const onPointerUp = (e: PointerEvent) => {
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

    _startEditInteraction(id: any, mode: any, clientX: number, element: any) {
        const region = this._items.find((a: any) => a.id === id);
        if (!region || region.readonly || this._lockedIds.has(id)) return;
        this._editing = {
            id,
            mode,
            startX: clientX,
            startRegion: { ...region },
            element: element as HTMLElement,
            pending: mode === 'move',
            moved: mode !== 'move',
            forceSuppressClick: mode !== 'move',
        };
        if (mode !== 'move') element.classList.add('editing');
    }

    _updateEditInteraction(clientX: number) {
        if (!this._editing) return;
        const editing = this._editing as any;
        const region = this._items.find((a: any) => a.id === editing.id);
        if (!region) return;
        const pps = this.player?._state?.pixelsPerSecond || 100;
        const duration = Math.max(0.001, this.player?.duration || this.player?._state?.audioBuffer?.duration || 0.001);
        const dt = (clientX - editing.startX) / Math.max(1, pps);
        const src = editing.startRegion;
        let next = { ...region };
        if (editing.pending) {
            if (Math.abs(clientX - editing.startX) < 4) return;
            editing.pending = false;
            editing.moved = true;
            editing.element?.classList?.add('editing');
        }

        if (editing.mode === 'move') {
            const span = src.end - src.start;
            next.start = clamp(src.start + dt, 0, Math.max(0, duration - span));
            next.end = next.start + span;
        } else if (editing.mode === 'resize-l') {
            next.start = clamp(src.start + dt, 0, src.end - 0.01);
        } else if (editing.mode === 'resize-r') {
            next.end = clamp(src.end + dt, src.start + 0.01, duration);
        }

        Object.assign(region, this._normalize({ ...src, ...next, id: src.id }));
        this.player?._state?.updateActiveSegmentFromLabel?.(region);
        this.dispatchEvent(new CustomEvent('annotationpreview', { detail: { annotation: { ...region } } }));
        const el = editing.element;
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

    /**
     * Blender-style grab for waveform annotations (horizontal only).
     */
    startGrab(annotationId: any) {
        const region = this._items.find((a: any) => a.id === annotationId);
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
            element: el as HTMLElement,
            pending: false,
            moved: true,
            forceSuppressClick: true,
        };
        this._grabbing = true;

        const onMove = (e: PointerEvent) => {
            this._updateEditInteraction(e.clientX);
        };
        const confirm = (e: Event) => {
            e?.preventDefault?.();
            e?.stopPropagation?.();
            cleanup();
            this._finishEditInteraction();
        };
        const cancel = (e: Event) => {
            e?.preventDefault?.();
            e?.stopPropagation?.();
            cleanup();
            Object.assign(region, snapshot);
            el.classList.remove('editing');
            this._editing = null;
            this._suppressClickUntil = performance.now() + 250;
            this.render();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') cancel(e as Event);
            if (e.key === 'g') confirm(e as Event);
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

    _renameRegionPrompt(id: any) {
        const region = this._items.find((a: any) => a.id === id);
        if (!region || region.readonly || this._lockedIds.has(id)) return;
        const current = region.species || 'Annotation';
        const el = this.overlay?.querySelector?.(`.annotation-region[data-id="${region.id}"]`);
        openLabelNameEditor({
            layer: this,
            player: this.player,
            anchorEl: el || this.overlay,
            initialValue: current,
            initialColor: region.color,
            initialScientificName: region.scientificName || '',
            onSubmit: ({ name, color }: any) => {
                const currentHex = getOverlayColorStyle(region.color)?.hex || '';
                if (name === current && color === currentHex) return;
                region.species = name;
                region.color = color;
                this.dispatchEvent(new CustomEvent('annotationupdate', { detail: { annotation: { ...region } } }));
                this.render();
            },
        });
    }

    _normalize(annotation: any) {
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
            readonly: annotation?.readonly === true,
            aiSuggested: annotation?.aiSuggested ?? null,
            recordingId: annotation?.recordingId ?? null,
        };
    }
}

export type { SpectrogramLabel } from '../shared/label.types.ts';

export class SpectrogramLabelLayer extends AnnotationLayerBase {
    overlay: HTMLElement | null = null;
    player: any;
    _items: SpectrogramLabel[] = [];
    _liveLinkedId: any = null;
    _unsubs: any[] = [];
    _domCleanups: any[] = [];
    _editing: any = null;
    _suppressClickUntil: number = 0;
    _multiSelectedIds: Set<string> = new Set();
    _lastPointerX: number | null = null;
    _lastPointerY: number | null = null;
    _grabbing: boolean = false;
    appendChild: any;
    closest: any;
    preventDefault: any;
    stopPropagation: any;
    drawMode: boolean = true;
    stampMode: boolean = false;
    _stampGhostEl: any = null;
    _stampAxisLock: any = false;
    _stampRefLabelId: any = null;
    _axisConstraint: any = null;
    _draftEl: any = null;
    _drawing: any = null;
    _counter: number = 0;
    _suppressContextMenuUntil: number = 0;
    _focusedLabelId: any = null;
    _selectedLabelId: any = null;
    _lockedIds: Set<string> = new Set();
    _clipboard: any = null;
    detail: any;
    target: any;
    length: any;
    map: any;
    name: any;
    constructor() {
        super();
        this.drawMode = true;
        // stampMode: click-to-stamp the last or focused label (see Player: Ctrl+D)
        this.stampMode = false;
        this._stampGhostEl = null;
        this._stampAxisLock = false;   // X pressed → lock freq to reference
        this._stampRefLabelId = null;  // persistent clicked-label ref for stamp
        this._axisConstraint = null;   // 'x' | 'y' | null  (Blender-style)
        this._draftEl = null;
        this._drawing = null;
        this._counter = 1;
        this._suppressContextMenuUntil = 0;
        this._focusedLabelId = null;
        this._selectedLabelId = null;
        /** @type {Set<string>} ids of labels whose set is locked — no drag/resize/edit */
        this._lockedIds = new Set();
        this._clipboard = null;
    }

    // ── Template-method overrides ────────────────────────────────────
    get _overlayClassName() { return 'spectrogram-label-layer'; }
    get _itemElSelector() { return '.spectrogram-label-region'; }

    _getRoot() {
        return this.player?._state?.d?.canvasWrapper || this.player?.root?.querySelector('.canvas-wrapper');
    }

    _subscribePlayerEvents() {
        this._unsubs.push(this.player.on('ready', () => this.render()));
        this._unsubs.push(this.player.on('zoomchange', () => this.render()));
        this._unsubs.push(this.player.on('viewresize', () => this.render()));
        this._unsubs.push(this.player.on('spectrogramscalechange', () => this.render()));
        this._unsubs.push(this.player.on('timeupdate', (e: any) => this.highlightActiveLabel(e.detail.currentTime)));
        this._unsubs.push(this.player.on('labelfocus', (e: any) => {
            const id = e?.detail?.id || null;
            const interaction = e?.detail?.interaction;
            if (interaction === 'click') {
                this._selectedLabelId = id;
                this._updateSelectedVisual();
            } else {
                // hover or unspecified — update transient focus highlight
                this._focusedLabelId = id;
                this._updateFocusedVisual();
            }
        }));
    }

    _bindInteractions(root: HTMLElement) { this._bindDrawingInteractions(root); }

    _emitCreate(region: any) { this.player?._emit?.('spectrogramlabelcreate', { label: { ...(region as any) } }); }
    _emitUpdate(item: any) { this.player?._emit?.('spectrogramlabelupdate', { label: { ...(item as any) } }); }

    /** Public alias for the internal items array (backward compat). */
    get labels() { return this._items; }
    set labels(v) {
        if (!Array.isArray(v)) {
            this._items = [];
            return;
        }
        // Ensure incoming items are normalized (IDs, defaults)
        this._items = v.map((i) => this._normalize(i));
    }

    detach() {
        super.detach();
        this._draftEl = null;
        this._drawing = null;
        this._stampGhostEl = null;
        this._stampAxisLock = false;
    }

    /** Accept a suggestion label — change its origin to 'manual'. */
    _acceptSuggestion(id: any) {
        const label = this._items.find((l: any) => l.id === id);
        if (!label) return;
        label.origin = 'manual';
        this.render();
        this.dispatchEvent(new CustomEvent('spectrogramlabelupdate', { detail: { label: { ...label } } }));
    }

    /**
     * Mark a set of label ids as locked (no drag, resize, edit, delete).
     * @param {Set<string>|string[]} ids
     */
    setLockedIds(ids = []) {
        this._lockedIds = new Set(ids);
        this.render();
    }

    copyLabel(id: any) {
        const label = this._items.find((l: any) => l.id === id);
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

    /**
     * Returns the reference label for stamp/paste defaults.
     * Priority: 1) explicit stamp ref  2) click-focused  3) last label
     */
    _getReferenceLabelForDefaults(): any {
        if (this._stampRefLabelId) {
            const ref = this._items.find((l: any) => l.id === this._stampRefLabelId);
            if (ref) return ref as any;
        }
        if (this._focusedLabelId) {
            const focused = this._items.find((l: any) => l.id === this._focusedLabelId);
            if (focused) return focused as any;
        }
        return this._items.length ? (this._items[this._items.length - 1] as any) : null;
    }

    highlightActiveLabel(currentTime: number) {
        if (!this.overlay) return;
        for (const el of this.overlay.querySelectorAll('.spectrogram-label-region')) {
            const h = el as HTMLElement;
            const start = parseFloat(h.dataset.start || '0');
            const end = parseFloat(h.dataset.end || '0');
            el.classList.toggle('active', currentTime >= start && currentTime <= end);
        }
    }

    /** Set .focused class on the currently hovered label element (transient). */
    _updateFocusedVisual() {
        if (!this.overlay) return;
        for (const el of this.overlay.querySelectorAll('.spectrogram-label-region')) {
            const h = el as HTMLElement;
            h.classList.toggle('focused', !!this._focusedLabelId && h.dataset?.id === this._focusedLabelId);
        }
    }

    /** Set .selected class on the explicitly selected label element (sticky). */
    _updateSelectedVisual() {
        if (!this.overlay) return;
        for (const el of this.overlay.querySelectorAll('.spectrogram-label-region')) {
            const h = el as HTMLElement;
            h.classList.toggle('selected', !!this._selectedLabelId && h.dataset?.id === this._selectedLabelId);
        }
    }

    render() {
        if (!this.overlay || !this.player) return;
        if (this._editing) return;
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
        for (const label of this._items) {
            const el = this._createLabelElement(label, width, height);
            const geo = this._toGeometry(label, width, height);
            this.overlay.appendChild(el);
            elements.push(el);
            geometries.push(geo);
        }
        // Resolve overlapping text badges
        this._resolveTextCollisions(elements, geometries);

        // Re-acquire editing element after innerHTML wipe
        if (this._editing) {
            const editing = this._editing as any;
            const freshEl = this.overlay.querySelector(
                `.spectrogram-label-region[data-id="${editing.id}"]`,
            );
            if (freshEl) {
                editing.element = freshEl as HTMLElement;
                freshEl.classList.add('editing');
            }
        }

        // Re-apply focus and selection visuals after innerHTML wipe
        this._updateFocusedVisual();
        this._updateSelectedVisual();
        this._updateMultiSelectedVisual();

        // Re-attach ghost stamp if it exists (innerHTML wipe removes it)
        if (this._stampGhostEl && this.stampMode) {
            this.overlay.appendChild(this._stampGhostEl);
        }
    }

    /**
     * Detect overlapping text badges and nudge colliding ones to bottom-left.
     * Uses a simple greedy approach: first label keeps top-left, subsequent
     * labels that would collide get moved to bottom-left of their box.
     * @param {HTMLElement[]} elements
     * @param {Array<{left: number, top: number, width: number, height: number}>} geometries
     */
    _resolveTextCollisions(elements: HTMLElement[], geometries: Array<{ left: number; top: number; width: number; height: number }>) {
        const TEXT_H = 16;
        const occupiedRects: Array<{ left: number; top: number; right: number; bottom: number }> = [];

        for (let i = 0; i < elements.length; i++) {
            const geo = geometries[i];
            const textEl = elements[i].querySelector('.spectrogram-label-text') as HTMLElement | null;
            if (!textEl) continue;

            const textWidth = clamp(geo.width * 0.7, 100, 200);
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

    _createLabelElement(label: SpectrogramLabel, canvasWidth: number, canvasHeight: number): HTMLElement {
        const el = document.createElement('div');
        el.className = 'spectrogram-label-region';
        const isLocked = this._lockedIds.has(label.id);
        const isReadonly = label.readonly === true;
        const isBlocked = isLocked || isReadonly;
        if (isLocked) el.classList.add('spectrogram-label-region--locked');
        if (isReadonly) el.classList.add('spectrogram-label-region--readonly');
        const isSuggestion = label.origin && label.origin !== 'manual' && label.origin !== 'xeno-canto';
        if (isSuggestion) el.classList.add('suggestion');
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
        const readonlyNote = isReadonly ? ' [read-only]' : '';
        el.title = `${label.label || 'Label'} ${label.start.toFixed(2)}s–${label.end.toFixed(2)}s / ${Math.round(label.freqMin ?? 0)}-${Math.round(label.freqMax ?? 0)} Hz${readonlyNote}`;
        el.setAttribute('aria-label', el.title);
        const aiTagHtml = label.aiSuggested ? `<span class="spectrogram-label-ai-badge" title="AI: ${escapeHtml(label.aiSuggested.model || '')} ${escapeHtml(label.aiSuggested.version || '')}">AI</span>` : '';
        const lockIconHtml = isReadonly ? `<span class="spectrogram-label-lock" title="Read-only (imported from XC)">🔒</span>` : '';
        el.innerHTML = `
            <span class="spectrogram-label-text">${escapeHtml(label.label || 'Label')}</span>
            <span class="spectrogram-label-meta">${Math.round(label.freqMin ?? 0)}-${Math.round(label.freqMax ?? 0)} Hz</span>
            ${aiTagHtml}${lockIconHtml}
            ${!isBlocked ? `
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
            ` : ''}
            ${isSuggestion ? `
            <button class="label-accept-btn" type="button" title="Accept label">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                </svg>
            </button>
            <button class="label-discard-btn" type="button" title="Discard label">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
            </button>
            ` : ''}
        `;

        const editBtn = el.querySelector('.label-edit-btn') as HTMLButtonElement | null;
        if (editBtn && !isBlocked) {
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

        const deleteBtn = el.querySelector('.label-delete-btn') as HTMLButtonElement | null;
        if (deleteBtn && !isBlocked) {
            deleteBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                this._suppressClickUntil = performance.now() + 250;
                this.remove(label.id);
                this.dispatchEvent(new CustomEvent('spectrogramlabelremove', { detail: { label: { ...label } } }));
            });
            deleteBtn.addEventListener('pointerdown', (event) => {
                event.stopPropagation();
            });
        }

        // ── Accept / Discard for suggestion labels ──
        const acceptBtn = /** @type {HTMLButtonElement | null} */ (el.querySelector('.label-accept-btn'));
        if (acceptBtn) {
            acceptBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                this._suppressClickUntil = performance.now() + 250;
                this._acceptSuggestion(label.id);
            });
            acceptBtn.addEventListener('pointerdown', (event) => { event.stopPropagation(); });
        }
        const discardBtn = /** @type {HTMLButtonElement | null} */ (el.querySelector('.label-discard-btn'));
        if (discardBtn) {
            discardBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                this._suppressClickUntil = performance.now() + 250;
                this.remove(label.id);
                this.dispatchEvent(new CustomEvent('spectrogramlabelremove', { detail: { label: { ...label } } }));
            });
            discardBtn.addEventListener('pointerdown', (event) => { event.stopPropagation(); });
        }

        el.addEventListener('click', (event) => {
            if (performance.now() < this._suppressClickUntil) return;
            event.stopPropagation();
            event.preventDefault();
            if (event.ctrlKey || event.metaKey) {
                // Ctrl+Click: toggle label into sidebar multi-selection without playing
                this.dispatchEvent(new CustomEvent('labelfocus', { detail: { id: label.id, source: 'spectrogram', interaction: 'ctrl-click' } }));
                return;
            }
            // Emit labelfocus but explicitly request no automatic seek
            // (seek is handled by playBandpassedSegment; we only want
            // to highlight/pin without changing viewport).
            this.dispatchEvent(new CustomEvent('labelfocus', { detail: { id: label.id, source: 'spectrogram', interaction: 'click', seekMode: 'none' } }));
            this.player?._state?._blockSeekClicks?.(260);
            this.player?.playBandpassedSegment?.(
                label.start,
                label.end,
                label.freqMin ?? 0,
                label.freqMax ?? 0,
                { labelId: label.id },
            );
        });
        el.addEventListener('dblclick', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (isBlocked) return;
            this._suppressClickUntil = performance.now() + 250;
            this._renameSpectrogramLabelPrompt(label.id);
        });
        el.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            if (isBlocked) { event.preventDefault(); event.stopPropagation(); return; }
            // In stamp mode, clicking a label sets the stamp reference — do NOT start move
            if (this.stampMode) {
                this._stampRefLabelId = label.id;
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            const handle = (event.target as Element | null)?.closest?.('.label-handle') as HTMLElement | null;
            const mode = handle?.dataset?.mode || 'move';
            this._startEditInteraction(label.id, mode, event.clientX, event.clientY, el);
            event.preventDefault();
            event.stopPropagation();
        });
        el.addEventListener('pointerenter', (event) => {
            this._lastPointerX = event.clientX;
            this._lastPointerY = event.clientY;
            this.dispatchEvent(new CustomEvent('labelfocus', { detail: { id: label.id, source: 'spectrogram', interaction: 'hover' } }));
        });
        el.addEventListener('pointerleave', () => {
            if (!this._grabbing && !this._editing) {
                this.dispatchEvent(new CustomEvent('labelfocus', { detail: { id: null, source: 'spectrogram', interaction: 'hover' } }));
            }
        });
        el.addEventListener('pointermove', (event) => {
            this._lastPointerX = event.clientX;
            this._lastPointerY = event.clientY;
        });
        return el;
    }

    _applyGeometryToElement(el: HTMLElement, geometry: { left: number; top: number; width: number; height: number }) {
        el.style.left = `${geometry.left}px`;
        el.style.top = `${geometry.top}px`;
        el.style.width = `${geometry.width}px`;
        el.style.height = `${geometry.height}px`;
    }

    _toGeometry(label: SpectrogramLabel | any, canvasWidth: number, canvasHeight: number) {
        const c = this.player?._state?.coords;
        const duration = c?.duration || Math.max(0.001, this.player?.duration || this.player?._state?.audioBuffer?.duration || 0.001);

        const x1 = c ? clamp(c.timeToPixelX(label.start), 0, canvasWidth) : clamp((label.start / duration) * canvasWidth, 0, canvasWidth);
        const x2 = c ? clamp(c.timeToPixelX(label.end), 0, canvasWidth) : clamp((label.end / duration) * canvasWidth, 0, canvasWidth);
        const yHigh = c ? clamp(c.frequencyToPixelY(label.freqMax ?? 0), 0, canvasHeight) : 0;
        const yLow = c ? clamp(c.frequencyToPixelY(label.freqMin ?? 0), 0, canvasHeight) : canvasHeight;

        return {
            left: Math.min(x1, x2),
            top: Math.min(yHigh, yLow),
            width: Math.max(1, Math.abs(x2 - x1)),
            height: Math.max(1, Math.abs(yLow - yHigh)),
        };
    }

    // ── Stamp-mode ghost helpers ──

    _ensureStampGhost() {
        if (this._stampGhostEl || !this.overlay) return;
        this._stampGhostEl = document.createElement('div');
        this._stampGhostEl.className = 'spectrogram-label-ghost';
        this.overlay.appendChild(this._stampGhostEl);
    }

    _removeStampGhost() {
        if (this._stampGhostEl?.parentNode) this._stampGhostEl.parentNode.removeChild(this._stampGhostEl);
        this._stampGhostEl = null;
    }

    _updateStampGhost(clientX: number, clientY: number) {
        if (!this.stampMode || !this.overlay) { this._removeStampGhost(); return; }
        const ref = this._getReferenceLabelForDefaults();
        if (!ref) { this._removeStampGhost(); return; }
        this._ensureStampGhost();
        const t = this._clientXToTime(clientX);
        const duration = Math.max(0.01, (ref.end - ref.start) || 0.01);
        const freq = this._stampAxisLock ? null : this._clientYToFreq(clientY);
        const freqSpan = (ref.freqMax ?? 0) - (ref.freqMin ?? 0);
        const freqMin = freq != null ? (freq - freqSpan / 2) : (ref.freqMin ?? 0);
        const freqMax = freq != null ? (freq + freqSpan / 2) : (ref.freqMax ?? 0);
        const width = parseFloat(this.overlay.style.width) || 1;
        const height = parseFloat(this.overlay.style.height) || 1;
        const ghost = { start: t, end: t + duration, freqMin, freqMax, label: ref.label };
        const geo = this._toGeometry(ghost, width, height);
        if (!this._stampGhostEl) return;
        const el = this._stampGhostEl;
        el.style.left = `${geo.left}px`;
        el.style.top = `${geo.top}px`;
        el.style.width = `${geo.width}px`;
        el.style.height = `${geo.height}px`;
        const colorStyle = getOverlayColorStyle(ref.color);
        if (colorStyle) {
            el.style.setProperty('--ghost-color', colorStyle.edge);
            el.style.setProperty('--ghost-fill', colorStyle.fill);
        }
        el.textContent = ref.label || 'Label';
        el.classList.toggle('axis-locked', this._stampAxisLock);
    }

    /** Exit stamp mode and clean up ghost. */
    exitStampMode() {
        this.stampMode = false;
        this._stampAxisLock = false;
        this._stampRefLabelId = null;
        this._removeStampGhost();
        this.player?.root?.classList.remove('stamp-mode-active');
        // Notify BirdNETPlayer to sync button state
        this.dispatchEvent(new CustomEvent('stampmodechange', { detail: { active: false } }));
    }

    _bindDrawingInteractions(wrapper: any) {
        const onPointerDown = (e: PointerEvent) => {
            // Stamp mode: left-click places label, right-click exits mode
            if (this.stampMode) {
                if (e.button === 2) {
                    e.preventDefault();
                    e.stopPropagation();
                    this._suppressContextMenuUntil = performance.now() + 400;
                    this.exitStampMode();
                    return;
                }
                if (e.button === 0) {
                    if (!this.player?._state?.audioBuffer) return;
                    const ref = this._getReferenceLabelForDefaults();
                    if (!ref) return;
                    const t = this._clientXToTime(e.clientX);
                    const duration = Math.max(0.01, (ref.end - ref.start) || 0.01);
                    const freq = this._stampAxisLock ? null : this._clientYToFreq(e.clientY);
                    const freqSpan = (ref.freqMax ?? 0) - (ref.freqMin ?? 0);
                    const isXc = ref.origin === 'xeno-canto';
                    this.add({
                        start: t,
                        end: t + duration,
                        freqMin: freq != null ? (freq - freqSpan / 2) : ref.freqMin,
                        freqMax: freq != null ? (freq + freqSpan / 2) : ref.freqMax,
                        label: ref.label,
                        color: ref.color,
                        scientificName: ref.scientificName,
                        commonName: ref.commonName,
                        origin: 'manual',
                        author: isXc ? '' : ref.author,
                        tags: isXc ? {} : (ref.tags ? { ...ref.tags } : {}),
                    });
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
            }

            if ((e.target as Element)?.closest?.('.spectrogram-label-region')) return;
            if ((!e.shiftKey && !this.drawMode) || e.button !== 0) return;
            if (!this.player?._state?.audioBuffer) return;

            const start = this._clientXToTime(e.clientX);
            const freq = this._clientYToFreq(e.clientY);
            this._drawing = { startTime: start, startFreq: freq, endTime: start, endFreq: freq };
            this._ensureDraft();
            this._updateDraft();
            e.preventDefault();
            e.stopPropagation();
        };

        const onPointerMove = (e: PointerEvent) => {
            // Update ghost stamp preview
            if (this.stampMode) {
                this._updateStampGhost(e.clientX, e.clientY);
            }
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

        const onPointerUp = (e: PointerEvent) => {
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

        // Prevent browser context-menu in stamp mode (and briefly after exiting via right-click)
        const onContextMenu = (e: Event) => {
            if (this.stampMode || this._suppressContextMenuUntil > performance.now()) {
                e.preventDefault(); e.stopPropagation();
            }
        };

        // Keyboard: X/Y = axis lock (stamp + grab), Escape = exit stamp
        const onKeyDown = (e: KeyboardEvent) => {
            // Don't intercept when user is typing in an input
            const tag = ((e.target as HTMLElement)?.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || (e.target as any)?.isContentEditable) return;

            // Escape exits stamp mode
            if (this.stampMode && e.key === 'Escape') {
                e.preventDefault();
                this.exitStampMode();
                return;
            }

            // X/Y axis lock in stamp mode
            if (this.stampMode) {
                if (e.key === 'x' || e.key === 'X') {
                    e.preventDefault();
                    this._stampAxisLock = !this._stampAxisLock;
                    if (this._stampGhostEl) {
                        this._stampGhostEl.classList.toggle('axis-locked', this._stampAxisLock);
                    }
                    return;
                }
            }

            // X/Y axis constraint during drag-edit (not grab — grab has its own handler)
            if (this._editing && !this._grabbing) {
                if (e.key === 'x' || e.key === 'X') {
                    e.preventDefault();
                    this._axisConstraint = this._axisConstraint === 'x' ? null : 'x';
                    return;
                }
                if (e.key === 'y' || e.key === 'Y') {
                    e.preventDefault();
                    this._axisConstraint = this._axisConstraint === 'y' ? null : 'y';
                    return;
                }
            }
        };

        wrapper.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('pointermove', onPointerMove, true);
        document.addEventListener('pointerup', onPointerUp, true);
        document.addEventListener('pointercancel', onPointerUp, true);
        wrapper.addEventListener('contextmenu', onContextMenu, true);
        document.addEventListener('keydown', onKeyDown, true);

        this._domCleanups.push(() => wrapper.removeEventListener('pointerdown', onPointerDown, true));
        this._domCleanups.push(() => document.removeEventListener('pointermove', onPointerMove, true));
        this._domCleanups.push(() => document.removeEventListener('pointerup', onPointerUp, true));
        this._domCleanups.push(() => document.removeEventListener('pointercancel', onPointerUp, true));
        this._domCleanups.push(() => wrapper.removeEventListener('contextmenu', onContextMenu, true));
        this._domCleanups.push(() => document.removeEventListener('keydown', onKeyDown, true));
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

    _openNewLabelPicker(region: any) {
        // If species search bar has a selection, skip the dialog entirely
        const barSel = this.player?.getSpeciesBarSelection?.();
        if (barSel && barSel.name) {
            region.label = barSel.name;
            region.color = barSel.color || colorForName(barSel.name);
            region.scientificName = barSel.scientificName || '';
            region.tags = {};
            this.add(region);
            return;
        }

        // Collect unique labels with their colors for quick pick
        const seen = new Set();
        const existingLabels = [];
        for (const l of this._items) {
            const name = (l.label || '').trim();
            if (!name) continue;
            const key = name.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            // Don't propagate tags from imported (xeno-canto) labels — those belong to that recording
            const isXc = l.origin === 'xeno-canto';
            existingLabels.push({ name, color: l.color || '', scientificName: l.scientificName || '', tags: isXc ? {} : (l.tags || {}), detail: isXc ? 'xeno-canto' : (l.origin && l.origin !== 'manual' ? l.origin : '') });
        }
        // Pre-fill from focused/last label (skip XC metadata)
        const ref = this._getReferenceLabelForDefaults();
        const isXcRef = ref?.origin === 'xeno-canto';
        const initialColor = ref?.color || _autoAssignColor(this._items);
        const refName = (ref?.label || '').trim().toLowerCase();
        openLabelNameEditor({
            layer: this,
            player: this.player,
            initialValue: ref?.label || '',
            initialColor,
            initialTags: isXcRef ? null : (ref?.tags || null),
            initialScientificName: ref?.scientificName || '',
            existingLabels,
            title: 'New Label',
            onSubmit: ({ name, color, scientificName = '', tags = {}, changed = {} }: any) => {
                // If user typed a different name but didn't manually change color,
                // auto-assign a deterministic color for the new name.
                const nameChanged = name.trim().toLowerCase() !== refName;
                region.label = name;
                region.color = (nameChanged && !changed.color) ? colorForName(name) : color;
                region.scientificName = String(scientificName || '').trim();
                region.tags = tags;
                this.add(region);
            },
        });
    }

    _startEditInteraction(labelId: any, mode: any, clientX: number, clientY: number, element: any) {
        const label = this._items.find((l: any) => l.id === labelId);
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
            element: element as HTMLElement,
            pending: mode === 'move',
            moved: mode !== 'move',
            forceSuppressClick: mode !== 'move',
        };
        if (mode !== 'move') element.classList.add('editing');
    }

    _updateEditInteraction(clientX: number, clientY: number) {
        if (!this._editing) return;
        const editing = this._editing as any;
        const label = this._items.find((l: any) => l.id === editing.id) as any;
        if (!label) return;

        const duration = Math.max(0.001, this.player?.duration || this.player?._state?.audioBuffer?.duration || 0.001);
        const maxFreq = this._getMaxFreq();
        const c = this.player?._state?.coords;
        const pps = this.player?._state?.pixelsPerSecond || 100;
        // Use total scrollable width (same formula as render()), not canvas element width
        // which is only viewport-wide with sticky/viewport rendering.
        const width = Math.max(1, c ? Math.floor(c.timeToScrollX(duration)) : Math.floor(duration * pps));
        const height = Math.max(1, this.player?._state?.d?.spectrogramCanvas?.height || 1);

        // Use CoordinateSystem for time delta
        const currentTime = this._clientXToTime(clientX);
        const dt = currentTime - editing.startTime;

        // Compute frequency changes in pixel space so that on a mel
        // (logarithmic) scale dragging still feels perceptually linear.
        const currentCanvasY = this._clientYToCanvasY(clientY);
        const deltaCanvasY = currentCanvasY - editing.startCanvasY;

        const src = editing.startLabel as any;

        // Pixel-Y positions of the original label edges (via CoordinateSystem)
        const srcMaxPy = c ? c.frequencyToPixelY(src.freqMax) : 0;
        const srcMinPy = c ? c.frequencyToPixelY(src.freqMin) : height;

        /** Shift a frequency edge by deltaCanvasY in pixel space, then convert back to Hz. */
        const shiftedFreq = (origFreq: number) => {
            if (!c) return origFreq;
            const origPy = c.frequencyToPixelY(origFreq);
            return c.pixelYToFrequency(origPy + deltaCanvasY);
        };

        if (editing.pending) {
            if (Math.abs(clientX - editing.startX) < 4 && Math.abs(clientY - editing.startY) < 4) return;
            editing.pending = false;
            editing.moved = true;
            editing.element?.classList?.add('editing');
        }

        let next = { ...label };
        // Blender-style axis constraint: 'x' = time only, 'y' = freq only
        const ax = this._axisConstraint;
        switch (editing.mode) {
            case 'move':
                if (ax !== 'y') { next.start = src.start + dt; next.end = src.end + dt; }
                if (ax !== 'x') { next.freqMin = shiftedFreq(src.freqMin); next.freqMax = shiftedFreq(src.freqMax); }
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
        if (editing.mode === 'move') {
            const timeSpan = Math.max(0.01, src.end - src.start);
            next.end = next.start + timeSpan;

            // Keep the original pixel height: shift freqMax from freqMin's
            // new pixel position by the original pixel span.
            const origPixelSpan = Math.abs(srcMinPy - srcMaxPy);
            const newMinPy = c ? c.frequencyToPixelY(next.freqMin ?? 0) : height;
            const newMaxPy = newMinPy - origPixelSpan;  // top = lower Y
            next.freqMax = c ? c.pixelYToFrequency(Math.max(0, newMaxPy)) : (next.freqMax ?? 0);

            if (next.end > duration) {
                const shift = next.end - duration;
                next.start = Math.max(0, next.start - shift);
                next.end = duration;
            }
            if ((next.freqMax ?? 0) > maxFreq) {
                const shift = (next.freqMax ?? 0) - maxFreq;
                next.freqMin = Math.max(0, (next.freqMin ?? 0) - shift);
                next.freqMax = maxFreq;
            }
        }

        Object.assign(label, next);
        this.player?._state?.updateActiveSegmentFromLabel?.(label);
        this.dispatchEvent(new CustomEvent('spectrogramlabelpreview', { detail: { label: { ...label } } }));
        if (editing.element) {
            editing.element.dataset.start = String(label.start);
            editing.element.dataset.end = String(label.end);
            editing.element.title = `${label.label || 'Label'} ${label.start.toFixed(2)}s–${label.end.toFixed(2)}s / ${Math.round(label.freqMin ?? 0)}-${Math.round(label.freqMax ?? 0)} Hz`;
            const geometry = this._toGeometry(label, width, height);
            this._applyGeometryToElement(editing.element, geometry);
            const meta = editing.element.querySelector('.spectrogram-label-meta');
            if (meta) meta.textContent = `${Math.round(label.freqMin ?? 0)}-${Math.round(label.freqMax ?? 0)} Hz`;
        }
    }

    /**
     * Blender-style grab: label follows the mouse until click (confirm) or Escape (cancel).
     */
    startGrab(labelId: unknown) {
        const label = this._items.find((l: any) => l.id === labelId) as any;
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
            element: el as HTMLElement,
            pending: false,
            moved: true,
            forceSuppressClick: true,
        };
        this._grabbing = true;
        this._axisConstraint = null;

        const onMove = (e: PointerEvent) => {
            this._updateEditInteraction(e.clientX, e.clientY);
        };
        const confirm = (e: Event) => {
            e?.preventDefault?.();
            e?.stopPropagation?.();
            cleanup();
            this._finishEditInteraction();
        };
        const cancel = (e: Event) => {
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
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') cancel(e as Event);
            if (e.key === 'g') confirm(e as Event);
            // Blender-style axis constraints during grab
            if (e.key === 'x' || e.key === 'X') {
                e.preventDefault();
                this._axisConstraint = this._axisConstraint === 'x' ? null : 'x';
            }
            if (e.key === 'y' || e.key === 'Y') {
                e.preventDefault();
                this._axisConstraint = this._axisConstraint === 'y' ? null : 'y';
            }
        };
        const cleanup = () => {
            this._grabbing = false;
            this._axisConstraint = null;
            document.removeEventListener('pointermove', onMove, true);
            document.removeEventListener('pointerdown', confirm, true);
            document.removeEventListener('keydown', onKey, true);
        };

        document.addEventListener('pointermove', onMove, true);
        document.addEventListener('pointerdown', confirm, true);
        document.addEventListener('keydown', onKey, true);
    }

    _renameSpectrogramLabelPrompt(id: any) {
        const label = this._items.find((l: any) => l.id === id);
        if (!label || label.readonly || this._lockedIds.has(id)) return;
        const current = label.label || 'Label';
        const el = this.overlay?.querySelector?.(`.spectrogram-label-region[data-id="${label.id}"]`);
        openLabelNameEditor({
            layer: this,
            player: this.player,
            anchorEl: el || this.overlay,
            initialValue: current,
            initialColor: label.color,
            initialTags: label.tags || {},
            initialScientificName: label.scientificName || '',
            onSubmit: ({ name, color, scientificName = '', tags = {}, changed = {} }: any) => {
                if (!changed.name && !changed.color && !changed.scientificName && !changed.tags) return;
                const nextSci = String(scientificName || '').trim();
                label.label = name;
                label.color = color;
                label.tags = tags;
                if (nextSci) label.scientificName = nextSci;
                // Apply color to all labels with the same name
                const labelKey = name.toLowerCase();
                for (const other of this._items) {
                    if (other.id !== label.id && (other.label || '').toLowerCase() === labelKey) {
                        other.color = color;
                        this.dispatchEvent(new CustomEvent('spectrogramlabelupdate', { detail: { label: { ...other } } }));
                    }
                }
                this.dispatchEvent(new CustomEvent('spectrogramlabelupdate', { detail: { label: { ...label } } }));
                this.render();
            },
            onDelete: () => {
                this.remove(id);
                this.dispatchEvent(new CustomEvent('spectrogramlabelremove', { detail: { label: { ...label } } }));
            },
        });
    }

    _renameBulkPrompt(ids: any[]) {
        if (!ids || ids.length === 0) return;
        const labels = ids
            .map((id: any) => this._items.find((l: any) => l.id === id))
            .filter(Boolean)
            .filter((l: any) => !l.readonly && !this._lockedIds.has(l.id)) as any[];
        if (labels.length === 0) return;
        const first = labels[0];
        const anchorEl = this.overlay || null;
        openLabelNameEditor({
            layer: this,
            player: this.player,
            anchorEl,
            initialValue: first.label || '',
            initialColor: first.color,
            initialTags: first.tags || {},
            initialScientificName: first.scientificName || '',
            title: `Rename ${labels.length} label${labels.length > 1 ? 's' : ''}`,
            onSubmit: ({ name, color, scientificName = '', tags = {}, changed: reportedChanged = {} }: any) => {
                // If the editor reports which fields were changed, only apply
                // those fields to the whole selected group. This avoids
                // unintentionally overwriting untouched fields on bulk edits.
                // For the bulk-rename flow, preserve the previous behavior where
                // saving without touching fields applies the first label's
                // `name` and `tags` to the whole selection — interpret a
                // completely-empty `changed` as intent to apply name+tags.
                const changed = { ...reportedChanged };
                // If no meaningful fields were changed by the user (ignore
                // incidental color normalization differences in fake DOMs),
                // default to applying the `name` and `tags` from the first
                // label to the whole selection — preserving previous bulk
                // behavior.
                if (!changed.name && !changed.scientificName && !changed.tags) {
                    changed.name = true;
                    changed.tags = true;
                }
                for (const lbl of labels) {
                    if (changed.name) lbl.label = name;
                    if (changed.color) lbl.color = color;
                    if (changed.tags) {
                        lbl.tags = (tags && typeof tags === 'object') ? { ...tags } : {};
                    }
                    
                    if (changed.scientificName) {
                        if (String(scientificName || '').trim()) lbl.scientificName = String(scientificName || '').trim();
                        else { lbl.scientificName = ''; lbl.commonName = ''; }
                    }
                    this.dispatchEvent(new CustomEvent('spectrogramlabelupdate', { detail: { label: { ...lbl } } }));
                }
                this._multiSelectedIds.clear();
                this._updateMultiSelectedVisual();
                this.render();
            },
        });
    }

    _clientXToTime(clientX: number) {
        return this.player?._state?._clientXToTime?.(clientX, 'spectrogram') || 0;
    }

    _clientYToCanvasY(clientY: number) {
        const state = this.player?._state;
        const c = state?.coords;
        const wrapper = state?.d?.canvasWrapper;
        if (!wrapper || !c) return 0;
        const rect = wrapper.getBoundingClientRect();
        const localY = clamp(clientY - rect.top, 0, rect.height);
        return localY / Math.max(1, rect.height) * c.canvasHeight;
    }

    _clientYToFreq(clientY: number) {
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
        return clamp(selected, 1, nyquist);
    }

    _normalize(label: any) {
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
        const e = clamp(Math.max(start, end), 0, duration);
        const f0 = clamp(Math.min(freqMin, freqMax), 0, maxFreq);
        const f1 = clamp(Math.max(freqMin, freqMax), 0, maxFreq);
        const meta = normalizeLabelStrings(label ?? {});
        return {
            id: label?.id || `slabel_${Math.random().toString(36).slice(2, 10)}`,
            start: s,
            end: Math.max(s + 0.01, e),
            freqMin: f0,
            freqMax: Math.max(f0 + 1, f1),
            label: meta.label,
            color: meta.color || colorForName(meta.label),
            scientificName: meta.scientificName,
            commonName: meta.commonName,
            origin: meta.origin,
            author: meta.author,
            tags: meta.tags,
            readonly: label?.readonly === true,
            aiSuggested: label?.aiSuggested ?? null,
            recordingId: label?.recordingId ?? null,
        };
    }
}
