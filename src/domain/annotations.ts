// ═══════════════════════════════════════════════════════════════════════
// annotations.js — Region layer for detections/annotations
// ═══════════════════════════════════════════════════════════════════════

import { escapeHtml, clamp } from '../shared/utils.ts';
import { DEFAULT_SAMPLE_RATE } from '../shared/constants.ts';
import { LabelEditorModal } from '../ui/components/label-editor/LabelEditorModal.ts';
import type { AnnotationRegion, SpectrogramLabel } from '../shared/label.types.ts';
import { normalizeLabelStrings } from '../shared/labelNormalize.ts';
import { getSpectrogramColor } from './spectrogram.ts';
import { snapToCall, bandMedians, SNAP_DEFAULT_SENSITIVITY, SNAP_BOX_DEFAULT_CONF, type SnapBox, type SnapBoxSource, type SnapPatch, type SnapResult } from './snapToCall.ts';

/** Height of one strip in the 'lanes' label display, and the gap above it. */
const LANE_H = 18;
const LANE_GAP = 2;

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

/** JSON replacer: _normalize() stamps a fresh createdAt on every set(); not shown, so not part of a signature. */
function skipTimestamps(key: string, value: unknown): unknown {
    return key === 'createdAt' || key === 'updatedAt' ? undefined : value;
}

/** True when `set` holds exactly the ids in `ids`. */
function sameIdSet(set: Set<string>, ids: Iterable<string>): boolean {
    const next = new Set(ids);   // distinct ids: ['a', 'a'] must not match {a, b}
    if (next.size !== set.size) return false;
    for (const id of next) if (!set.has(id)) return false;
    return true;
}

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

    // ── Keyed rendering (shared by both layers) ──────────────────────
    /** Element per item id from the last render(), and the signature/geometry it was built for. */
    _elById = new Map<string, HTMLElement>();
    _elState = new WeakMap<HTMLElement, { sig: string; geo: string }>();

    /**
     * Keyed DOM update: an item keeps its element while `signature` is unchanged; if only `geometry`
     * changed (zoom, scroll, layout) the element is re-placed. Every other overlay child is removed,
     * as the former `innerHTML = ''` did, and DOM order follows `items`.
     * `create` must return a fully placed element.
     */
    _reconcile<T extends { id: string }>(items: T[], spec: {
        signature: (item: T) => string;
        geometry: (item: T) => string;
        create: (item: T) => HTMLElement;
        place: (el: HTMLElement, item: T) => void;
    }): HTMLElement[] {
        const overlay = this.overlay as HTMLElement;
        const prevById = this._elById;
        const nextById = new Map<string, HTMLElement>();
        const elements: HTMLElement[] = [];
        for (const item of items) {
            const sig = spec.signature(item);
            const geo = spec.geometry(item);
            let el = prevById.get(item.id);
            const st = el && this._elState.get(el);
            if (!el || !st || st.sig !== sig || nextById.has(item.id)) {
                el = spec.create(item);
                this._elState.set(el, { sig, geo });
            } else if (st.geo !== geo) {
                spec.place(el, item);
                st.geo = geo;
            }
            nextById.set(item.id, el);
            elements.push(el);
        }
        this._elById = nextById;
        const keep = new Set<Element>(elements);
        for (const child of [...overlay.children]) if (!keep.has(child)) child.remove();
        let ref = overlay.firstChild;
        for (const el of elements) {
            if (el === ref) ref = ref.nextSibling;
            else overlay.insertBefore(el, ref);
        }
        return elements;
    }

    /** An element was changed outside render() (drag, resize): rebuild it on the next render. */
    _forgetElement(el: HTMLElement | null | undefined): void {
        if (el) this._elState.delete(el);
    }

    /** Signature of an item plus display flags; createdAt/updatedAt are not shown and change on every set(). */
    _signature(item: unknown, ...flags: unknown[]): string {
        return JSON.stringify([item, ...flags], skipTimestamps);
    }

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
        if (sameIdSet(this._lockedIds, ids)) return;   // unchanged: the overlay is already up to date
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
    /**
     * Escape during a drag/resize: put the item back where it started and end the interaction.
     * Nothing is committed (no update event); the preview event resets the other layer.
     */
    _cancelEditInteraction() {
        if (!this._editing) return;
        const editing = this._editing as any;
        const item = this._items.find((i: any) => i.id === editing.id);
        const start = editing.startLabel ?? editing.startRegion;
        if (item && start) Object.assign(item, start);
        editing.element?.classList?.remove('editing');
        (this as any)._hideEditLoupe?.();
        this._editing = null;
        this._axisConstraint = null;
        this._suppressClickUntil = performance.now() + 250;
        if (item && editing.moved) { this._emitPreview(item); this._emitPreviewEnd(editing.id); }
        this.render();
    }
    /** Live position during an interaction (the player mirrors it to the other layer). */
    _emitPreview(_item: any) {}
    /** Interaction over: the player drops the live highlight on the mirrored label. */
    _emitPreviewEnd(id: string) { this.dispatchEvent(new CustomEvent('previewend', { detail: { id } })); }

    _finishEditInteraction() {
        if (!this._editing) return;
        const editing = this._editing as any;
        const shouldSuppressClick = editing.forceSuppressClick || editing.moved;
        editing.element?.classList?.remove('editing');
        (this as any)._hideEditLoupe?.();
        const item = this._items.find((i: any) => i.id === editing.id);
        if (item && editing.moved) this._emitUpdate(item);
        this._editing = null;
        if (editing.moved) this._emitPreviewEnd(editing.id);
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
    _emitPreview(item: any) { this.dispatchEvent(new CustomEvent('annotationpreview', { detail: { annotation: { ...item } } })); }

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

        // Keyed update (see _reconcile): one changed region rebuilds one element.
        const p = this.player as any;
        const geometry = (region: any) => {
            const left = coords ? coords.timeToScrollX(region.start) : region.start * pps;
            const right = coords ? coords.timeToScrollX(region.end) : region.end * pps;
            const layout = localLayout.get(region.id);
            const stacked = layout && layout.depth > 1 ? layout : null;
            return { left: Math.max(0, left), width: Math.max(1, right - left), stacked };
        };
        const place = (el: HTMLElement, region: any) => {
            const g = geometry(region);
            el.style.left = `${g.left}px`;
            el.style.width = `${g.width}px`;
            if (g.stacked) {
                const pct = 100 / g.stacked.depth;
                el.style.top = `${g.stacked.localRow * pct}%`;
                el.style.height = `${pct}%`;
                el.style.bottom = 'auto';
            } else {
                el.style.top = '';
                el.style.height = '';
                el.style.bottom = '';
            }
        };
        this._reconcile(this._items as any[], {
            signature: (region) => this._signature(region, this._lockedIds.has(region.id), this._liveLinkedId === region.id,
                p?._readOnly === true),
            geometry: (region) => {
                const g = geometry(region);
                return `${g.left},${g.width},${g.stacked ? `${g.stacked.depth}/${g.stacked.localRow}` : ''}`;
            },
            create: (region) => { const el = this._createRegionElement(region, pps); place(el, region); return el; },
            place,
        });

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
        const isBlocked = isLocked || region.readonly === true || (this.player as any)?._readOnly === true;
        el.className = 'annotation-region';
        if (region.readonly) el.classList.add('annotation-region--readonly');
        if (isLocked) el.classList.add('annotation-region--locked');
        // Machine detections (BirdNET / BirdBox): locked, but no dashed read-only frame.
        if (region.origin && region.origin !== 'manual' && region.origin !== 'xeno-canto') el.classList.add('suggestion');
        if (region.origin === 'Similar') el.classList.add('annotation-region--similar');
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
        const lockIcon = (isLocked || region.readonly === true) ? `<span class="annotation-lock" title="${region.readonly ? 'Read-only (imported from XC)' : 'Locked'}">🔒</span>` : '';
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

        // Escape while dragging/resizing: back to where it started (grab has its own handler)
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || !this._editing || this._grabbing) return;
            e.preventDefault();
            e.stopPropagation();
            this._cancelEditInteraction();
        };
        document.addEventListener('keydown', onKeyDown, true);
        this._domCleanups.push(() => document.removeEventListener('keydown', onKeyDown, true));

        document.addEventListener('pointermove', onPointerMove, true);
        document.addEventListener('pointerup', onPointerUp, true);
        document.addEventListener('pointercancel', onPointerUp, true);
        this._domCleanups.push(() => document.removeEventListener('pointermove', onPointerMove, true));
        this._domCleanups.push(() => document.removeEventListener('pointerup', onPointerUp, true));
        this._domCleanups.push(() => document.removeEventListener('pointercancel', onPointerUp, true));
    }

    _startEditInteraction(id: any, mode: any, clientX: number, element: any) {
        const region = this._items.find((a: any) => a.id === id);
        if (!region || region.readonly || this._lockedIds.has(id) || (this.player as any)?._readOnly) return;
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
            this._forgetElement(el);   // changed outside render(): rebuilt on the next render
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
            this._cancelEditInteraction();   // back to the snapshot, other layer included
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
        if (!region || region.readonly || this._lockedIds.has(id) || (this.player as any)?._readOnly) return;
        const current = region.species || 'Annotation';
        const el = this.overlay?.querySelector?.(`.annotation-region[data-id="${region.id}"]`);
        openLabelNameEditor({
            layer: this,
            player: this.player,
            anchorEl: el || this.overlay,
            initialValue: current,
            initialColor: region.color,
            initialScientificName: region.scientificName || '',
            onSubmit: ({ name, color, scientificName = '' }: any) => {
                const currentHex = getOverlayColorStyle(region.color)?.hex || '';
                const nextSci = String(scientificName || '').trim();
                if (name === current && color === currentHex && (!nextSci || nextSci === (region.scientificName || ''))) return;
                region.species = name;
                region.color = color;
                if (nextSci) region.scientificName = nextSci;   // as on the spectrogram
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
            origin: annotation?.origin || '',
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
    /** Snap to call: click a call → preview box, Shift+wheel = sensitivity, click/Enter = commit. */
    snapMode: boolean = false;
    _snapSensitivity: number = SNAP_DEFAULT_SENSITIVITY;
    /**
     * Detector boxes for Snap (BirdBox): asked first; without a box under the click the
     * signal-based region growing answers. Null: Snap uses the signal only.
     */
    snapBoxSource: SnapBoxSource | null = null;
    _snapBoxConf: number = SNAP_BOX_DEFAULT_CONF;
    /** `source`: who drew the box; `tune`: what Shift+wheel changes for this click. */
    /** The point of the last snap, kept apart from its result for refreshSnap. */
    _snapAt: { time: number; freq: number } | null = null;
    _snap: { time: number; freq: number; result: SnapResult; source: 'detector' | 'signal'; tune: 'conf' | 'sensitivity'; detector: boolean } | null = null;
    _snapEl: HTMLElement | null = null;
    /** Zoom box ("Lupe"): drag a field → 'zoomboxselect', right-click → 'zoomboxback'. */
    zoomBoxMode: boolean = false;
    _zoomBox: { startTime: number; startFreq: number; endTime: number; endFreq: number; x0: number; y0: number } | null = null;
    _zoomBoxEl: HTMLElement | null = null;
    _editLoupeEl: HTMLCanvasElement | null = null;
    _loupePatch: unknown = null;
    _loupeLut: Uint8ClampedArray | null = null;
    _loupeLutScheme = '';
    _loupeOff: HTMLCanvasElement | null = null;
    _fineCursorEl: HTMLElement | null = null;
    _interactionRoot: HTMLElement | null = null;
    _fineLockRequested = false;
    _fineActive = false;
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

    _bindInteractions(root: HTMLElement) { this._bindDrawingInteractions(root); this._loupeOption('loupeDetailCheck', 'aw-loupe-detail'); this._bindLoupeWindow(root); }

    _emitCreate(region: any) { this.player?._emit?.('spectrogramlabelcreate', { label: { ...(region as any) } }); }
    _emitUpdate(item: any) {
        // A time-only resize reports the band as stored, not as clamped to the display maximum
        const band = (this._editing as any)?.keepBand;
        this.player?._emit?.('spectrogramlabelupdate', { label: { ...(item as any), ...(band || {}) } });
    }
    /** Bands as given to set(), before _normalize clamps them to the display maximum. */
    _storedBands = new Map<string, { freqMin: number; freqMax: number }>();
    _emitPreview(item: any) { this.dispatchEvent(new CustomEvent('spectrogramlabelpreview', { detail: { label: { ...item } } })); }

    /** Public alias for the internal items array (backward compat). */
    get labels() { return this._items; }
    set labels(v) {
        if (!Array.isArray(v)) {
            this._items = [];
            return;
        }
        // Ensure incoming items are normalized (IDs, defaults)
        this._storedBands = new Map(v.filter((i: any) => i?.id && Number.isFinite(i.freqMin) && Number.isFinite(i.freqMax))
            .map((i: any) => [i.id, { freqMin: Number(i.freqMin), freqMax: Number(i.freqMax) }]));
        this._items = v.map((i) => this._normalize(i));
    }

    detach() {
        super.detach();
        this._draftEl = null;
        this._drawing = null;
        this._stampGhostEl = null;
        this._stampAxisLock = false;
        this._snap = null;
        this._snapAt = null;
        this._snapEl = null;
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
        if (sameIdSet(this._lockedIds, ids)) return;   // unchanged: the overlay is already up to date
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
        // Detections shown on the spectrogram (locked BirdBox / BirdNET boxes) are no reference:
        // a snap clicks right on them, and their "Bird" would replace the species
        const own = (l: any) => !this._lockedIds.has(l.id);
        if (this._focusedLabelId) {
            const focused = this._items.find((l: any) => l.id === this._focusedLabelId);
            if (focused && own(focused)) return focused as any;
        }
        for (let i = this._items.length - 1; i >= 0; i--) if (own(this._items[i])) return this._items[i] as any;
        return null;
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

        // Keyed update: an element is kept while its label and display state are unchanged
        // (only its position follows zoom/scroll), so one edit touches one element, not all.
        // Stamp ghost, snap preview and draft are removed, as the old full wipe did.
        this._assignLanes(height);
        const p = this.player as any;
        const geoById = new Map<string, { left: number; top: number; width: number; height: number }>();
        for (const label of this._items) geoById.set(label.id, this._toGeometry(label, width, height));
        const elements = this._reconcile(this._items, {
            signature: (label) => this._signature(label, this._lockedIds.has(label.id), this._liveLinkedId === label.id,
                this._lanes.has(label.id), p?.options?.labelConfidence === true, p?._readOnly === true),
            geometry: (label) => { const g = geoById.get(label.id)!; return `${g.left},${g.top},${g.width},${g.height},${height}`; },
            create: (label) => this._createLabelElement(label, width, height),
            place: (el, label) => {
                const g = geoById.get(label.id)!;
                this._setGeometry(el, g);
                if (this._lanes.has(label.id)) el.style.setProperty('--lane-column', `${Math.max(0, height - g.top - g.height)}px`);
            },
        });
        const geometries = this._items.map((label) => geoById.get(label.id)!);
        // Resolve overlapping text badges
        this._resolveTextCollisions(elements, geometries);
        this._pinAllLabelTexts();
        this._bindTextPinScroll();
        if (this._snap) { this._snapEl = null; this._renderSnapPreview(); }

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
    // ── Keep the label name inside the visible part of a box ──────────
    /**
     * A box can extend past the visible view (scrolled in time or zoomed in
     * frequency). Shift its name into the visible part, staying inside the box.
     */
    _pinLabelText(el: HTMLElement) {
        const view = this._pinView();
        if (view) this._applyPin(el, this._measurePin(el, view));
    }
    /** Pins every name. Reads all layout first, then writes: one reflow instead of one per label. */
    _pinAllLabelTexts() {
        if (!this.overlay) return;
        const view = this._pinView();
        if (!view) return;
        const els = [...this.overlay.querySelectorAll('.spectrogram-label-region')] as HTMLElement[];
        const pins = els.map((el) => this._measurePin(el, view));
        for (let i = 0; i < els.length; i++) this._applyPin(els[i], pins[i]);
    }
    _pinView(): { viewL: number; viewR: number; viewH: number } | null {
        const wrap = this._getRoot() as HTMLElement | null;
        if (!wrap) return null;
        const viewL = wrap.scrollLeft;
        return { viewL, viewR: viewL + wrap.clientWidth, viewH: this.overlay?.offsetHeight || wrap.clientHeight };
    }
    /** Layout reads only (no writes), so measuring many labels in a row costs a single reflow. */
    _measurePin(el: HTMLElement, { viewL, viewR, viewH }: { viewL: number; viewR: number; viewH: number }) {
        const left = el.offsetLeft, top = el.offsetTop, w = el.offsetWidth, h = el.offsetHeight;
        const TEXT_W = 60, TEXT_H = 16;
        // Horizontal: start at the left edge of the visible part
        const dx = clamp(viewL - left, 0, Math.max(0, Math.min(w, viewR - left) - TEXT_W));
        const textEl = el.querySelector('.spectrogram-label-text') as HTMLElement | null;
        const atBottom = !!textEl?.classList.contains('label-text-bottom');
        const compact = el.classList.contains('label-compact');
        // Compact names sit above the box; if that is off-screen, put them inside.
        const inside = compact && top < TEXT_H;
        let dy = 0;
        if (atBottom && !compact) dy = -clamp(top + h - viewH, 0, Math.max(0, h - TEXT_H));
        else if (!compact || inside) dy = clamp(-top, 0, Math.max(0, h - TEXT_H));
        return { dx: Math.round(dx), dy: Math.round(dy), inside };
    }
    _applyPin(el: HTMLElement, { dx, dy, inside }: { dx: number; dy: number; inside: boolean }) {
        el.classList.toggle('label-text-inside', inside);
        // Unchanged values are not written: a style write invalidates the element even when equal.
        const sx = `${dx}px`, sy = `${dy}px`;
        if (el.style.getPropertyValue('--label-text-dx') !== sx) el.style.setProperty('--label-text-dx', sx);
        if (el.style.getPropertyValue('--label-text-dy') !== sy) el.style.setProperty('--label-text-dy', sy);
    }

    _textPinScrollBound: HTMLElement | null = null;
    _textPinRaf = 0;
    _bindTextPinScroll() {
        const wrap = this._getRoot() as HTMLElement | null;
        if (!wrap || this._textPinScrollBound === wrap) return;
        this._textPinScrollBound = wrap;
        wrap.addEventListener('scroll', () => {
            if (this._textPinRaf) return;
            this._textPinRaf = requestAnimationFrame(() => { this._textPinRaf = 0; this._pinAllLabelTexts(); });
        }, { passive: true });
    }

    _resolveTextCollisions(elements: HTMLElement[], geometries: Array<{ left: number; top: number; width: number; height: number }>) {
        const TEXT_H = 16;
        const occupiedRects: Array<{ left: number; top: number; right: number; bottom: number }> = [];

        for (let i = 0; i < elements.length; i++) {
            const geo = geometries[i];
            if (elements[i].classList.contains('spectrogram-label-region--lane')) continue;
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
            textEl.classList.toggle('label-text-bottom', collides);   // reused elements may still have it

            if (collides) {
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
        const isBlocked = isLocked || isReadonly || (this.player as any)?._readOnly === true;
        if (isLocked) el.classList.add('spectrogram-label-region--locked');
        if (isReadonly) el.classList.add('spectrogram-label-region--readonly');
        const isSuggestion = label.origin && label.origin !== 'manual' && label.origin !== 'xeno-canto';
        if (isSuggestion) el.classList.add('suggestion');
        // Found as a repeat of an own label (app/suggest-similar.ts): dotted until copied or rejected
        if (label.origin === 'Similar') el.classList.add('spectrogram-label-region--similar');
        // The one under review (similar-review.ts): stands out, and resizable for fine corrections
        if (label.origin === 'Similar' && (label as any).reviewing) el.classList.add('spectrogram-label-region--reviewing');
        if (this._liveLinkedId && label.id === this._liveLinkedId) el.classList.add('linked-live');
        el.setAttribute('role', 'button');
        el.setAttribute('tabindex', '0');

        const geo = this._toGeometry(label, canvasWidth, canvasHeight);
        const inLane = this._lanes.has(label.id);
        if (inLane) {
            el.classList.add('spectrogram-label-region--lane');
            // The selected strip shades its time span down to the bottom edge.
            el.style.setProperty('--lane-column', `${Math.max(0, canvasHeight - geo.top - geo.height)}px`);
        }
        this._applyGeometryToElement(el, geo);
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
        const conf = Number.isFinite(label.confidence) ? Number(label.confidence) : null;
        const confText = conf != null ? `${Math.round(conf * 100)}%` : '';
        const showConf = conf != null && (this.player as any)?.options?.labelConfidence === true;
        const band = label.fullBand ? '' : ` / ${Math.round(label.freqMin ?? 0)}-${Math.round(label.freqMax ?? 0)} Hz`;
        el.title = `${label.label || 'Label'}${confText ? ` (${confText})` : ''} ${label.start.toFixed(2)}s–${label.end.toFixed(2)}s${band}${readonlyNote}`;
        el.setAttribute('aria-label', el.title);
        if (showConf) {
            // Confidence as a meter: the strip's bottom edge (lanes) and a mini bar in the name pill,
            // tinted from red (low) over amber to green (high).
            el.classList.add('has-conf');
            el.style.setProperty('--label-conf', String(Math.max(0, Math.min(1, conf))));
            el.style.setProperty('--label-conf-color', `hsl(${Math.round(Math.max(0, Math.min(1, conf)) * 125)} 75% 52%)`);
        }
        const confHtml = showConf
            ? ` <span class="spectrogram-label-conf"><span class="spectrogram-label-conf-meter" aria-hidden="true"></span>${Math.round(conf * 100)}<small>%</small></span>`
            : '';
        const aiTagHtml = label.aiSuggested ? `<span class="spectrogram-label-ai-badge" title="AI: ${escapeHtml(label.aiSuggested.model || '')} ${escapeHtml(label.aiSuggested.version || '')}">AI</span>` : '';
        // A read-only player has nothing to edit: a lock on every label would only be noise.
        const lockIconHtml = isReadonly && (this.player as any)?._readOnly !== true ? `<span class="spectrogram-label-lock" title="Read-only (imported from XC)">🔒</span>` : '';
        el.innerHTML = `
            <span class="spectrogram-label-text"><span class="spectrogram-label-name">${escapeHtml(label.label || 'Label')}</span>${confHtml}</span>
            ${label.fullBand ? '' : `<span class="spectrogram-label-meta">${Math.round(label.freqMin ?? 0)}-${Math.round(label.freqMax ?? 0)} Hz</span>`}
            ${aiTagHtml}${lockIconHtml}
            ${!isBlocked ? `
            <button class="label-refcalls-btn" type="button" title="Reference calls">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
                </svg>
            </button>
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
            ${isSuggestion && !isReadonly && (this.player as any)?._readOnly !== true ? `
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

        const refBtn = el.querySelector('.label-refcalls-btn') as HTMLButtonElement | null;
        if (refBtn && !isBlocked) {
            refBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                this._suppressClickUntil = performance.now() + 250;
                this.dispatchEvent(new CustomEvent('spectrogramlabelrefcalls', { detail: { label: { ...label } } }));
            });
            refBtn.addEventListener('pointerdown', (event) => {
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
                // Detections in a locked set (BirdNET / BirdBox) are copied into "My labels"
                // by the app; an unlocked suggestion simply becomes a manual label.
                // A similar-call suggestion under review is unlocked (resizable) but still copied.
                if (this._lockedIds.has(label.id)) {
                    this.dispatchEvent(new CustomEvent('spectrogramlabeladopt', { detail: { label: { ...label } } }));
                } else if (label.origin === 'Similar') {
                    const detail: any = { label: { ...label } };
                    this.dispatchEvent(new CustomEvent('spectrogramlabeladopt', { detail }));
                    if (!detail.handled) this._acceptSuggestion(label.id);   // standalone player: no host copies it
                } else {
                    this._acceptSuggestion(label.id);
                }
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
            // (seek is handled by the segment playback; we only want
            // to highlight/pin without changing viewport).
            this.dispatchEvent(new CustomEvent('labelfocus', { detail: { id: label.id, source: 'spectrogram', interaction: 'click', seekMode: 'none' } }));
            this.player?._state?._blockSeekClicks?.(260);
            // Bandpassed to the label's frequency range unless the user turned that off (Audio tab)
            if (this.player?.playLabelSegment) {
                this.player.playLabelSegment(label, { labelId: label.id });
            } else {
                this.player?.playBandpassedSegment?.(label.start, label.end, label.freqMin ?? 0, label.freqMax ?? 0, { labelId: label.id });
            }
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
        this._setGeometry(el, geometry);
        if (el.isConnected) {
            this._forgetElement(el);   // changed outside render(): rebuilt on the next render
            this._pinLabelText(el);
        }
    }
    /** Position + size classes only; no layout reads. */
    _setGeometry(el: HTMLElement, geometry: { left: number; top: number; width: number; height: number }) {
        el.style.left = `${geometry.left}px`;
        el.style.top = `${geometry.top}px`;
        el.style.width = `${geometry.width}px`;
        el.style.height = `${geometry.height}px`;
        // Small boxes: name + buttons go outside
        const lane = el.classList.contains('spectrogram-label-region--lane');
        el.classList.toggle('label-compact', !lane && (geometry.width < 70 || geometry.height < 44));
        // Only really tiny boxes drop the corner dots (12 px dots + edge strips need room)
        el.classList.toggle('label-tiny', geometry.width < 40 || geometry.height < 30);
    }


    /** Lane of each full-band label in 'lanes' display (empty in other modes). */
    _lanes = new Map<string, number>();

    /**
     * 'lanes' display: labels without frequency bounds (BirdNET's 3 s windows)
     * become strips along the top edge. Overlapping ones go to the next lane
     * down, up to half the spectrogram height; beyond that they share the last.
     */
    _assignLanes(canvasHeight: number) {
        this._lanes.clear();
        if ((this.player as any)?.options?.labelDisplay !== 'lanes') return;
        const maxLanes = Math.max(1, Math.floor((canvasHeight * 0.5) / LANE_H));
        const laneEnds: number[] = [];
        const items = this._items.filter((l: any) => l.fullBand).sort((a, b) => a.start - b.start || b.end - a.end);
        for (const l of items) {
            let lane = laneEnds.findIndex((end) => end <= l.start + 1e-6);
            if (lane < 0) lane = Math.min(laneEnds.length, maxLanes - 1);
            laneEnds[lane] = Math.max(laneEnds[lane] ?? 0, l.end);
            this._lanes.set(l.id, lane);
        }
    }

    _toGeometry(label: SpectrogramLabel | any, canvasWidth: number, canvasHeight: number) {
        const c = this.player?._state?.coords;
        const duration = c?.duration || Math.max(0.001, this.player?.duration || this.player?._state?.audioBuffer?.duration || 0.001);

        const x1 = c ? clamp(c.timeToPixelX(label.start), 0, canvasWidth) : clamp((label.start / duration) * canvasWidth, 0, canvasWidth);
        const x2 = c ? clamp(c.timeToPixelX(label.end), 0, canvasWidth) : clamp((label.end / duration) * canvasWidth, 0, canvasWidth);
        const lane = this._lanes.get(label.id);
        if (lane != null) {
            return {
                left: Math.min(x1, x2),
                top: LANE_GAP + lane * LANE_H,
                width: Math.max(1, Math.abs(x2 - x1)),
                height: LANE_H - LANE_GAP,
            };
        }
        // Not clipped to the visible frequency view: a label reaching past the
        // view edge must not show a border there (the canvas wrapper clips it).
        // Bounded to one view height beyond each edge to keep elements small.
        const yHigh = c ? clamp(c.frequencyToPixelY(label.freqMax ?? 0), -canvasHeight, 2 * canvasHeight) : 0;
        const yLow = c ? clamp(c.frequencyToPixelY(label.freqMin ?? 0), -canvasHeight, 2 * canvasHeight) : canvasHeight;

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

    // ── Snap to call ─────────────────────────────────────────────────

    /**
     * Box the call at (time, freq): the detector's box under the click if there is one,
     * else region growing on the signal (widens the analysed span while the call reaches its edge).
     */
    _runSnap(time: number, freq: number) {
        this._snapAt = { time, freq };
        let det: { box: SnapBox | null; weaker: boolean } | null = null;
        try { det = this.snapBoxSource?.(time, freq, this._snapBoxConf) ?? null; } catch { det = null; }
        if (det?.box) {
            const result: SnapResult = { ok: true, box: det.box, peakDb: 0, thresholdDb: 0, touchesEdge: false };
            this._snap = { time, freq, result, source: 'detector', tune: 'conf', detector: true };
            this._renderSnapPreview();
            return;
        }
        let result: SnapResult | null = null;
        for (let half = 1.5; half <= 12; half *= 2) {
            const patch: SnapPatch | null = this.player?.computeSnapPatch?.(time, half) ?? null;
            if (!patch) break;
            result = snapToCall(patch, time, freq, this._snapSensitivity, bandMedians(patch));
            if (!result.ok || !result.touchesEdge) break;
        }
        // A detector box exists below the current confidence: the wheel lowers that first
        this._snap = result ? { time, freq, result, source: 'signal', tune: det?.weaker ? 'conf' : 'sensitivity', detector: !!det } : null;
        this._renderSnapPreview();
    }

    /** Snap again at the last point (e.g. once the detector's rows for it arrived). */
    refreshSnap() {
        // From the clicked point, also when the signal gave no preview (aw-dsp not ready yet)
        if (!this.snapMode || !this._snapAt) return;
        this._runSnap(this._snapAt.time, this._snapAt.freq);
    }

    _renderSnapPreview() {
        if (!this._snap || !this.overlay) {
            // No preview (yet): keep the clicked point for refreshSnap
            const at = this._snapAt;
            this._clearSnap();
            this._snapAt = this.overlay ? at : null;
            return;
        }
        if (!this._snapEl) {
            this._snapEl = document.createElement('div');
            this.overlay.appendChild(this._snapEl);
        }
        const el = this._snapEl;
        const width = parseFloat(this.overlay.style.width) || 1;
        const height = parseFloat(this.overlay.style.height) || 1;
        const { result, time, freq, source, tune, detector } = this._snap;
        const pct = Math.round(this._snapSensitivity * 100);
        const conf = this._snapBoxConf.toFixed(2);
        if (result.ok) {
            const g = this._toGeometry(this._normalize({ ...result.box, label: '' }), width, height);
            const fresh = !el.classList.contains('snap-box');
            el.className = 'snap-box' + (fresh ? ' snap-box--in' : '') + (source === 'detector' ? ' snap-box--detector' : '');
            Object.assign(el.style, { left: `${g.left}px`, top: `${g.top}px`, width: `${g.width}px`, height: `${g.height}px` });
            // Viewfinder corners + a compact chip: where the box comes from, what the wheel tunes, key hints
            const bars = Array.from({ length: 5 }, (_, i) =>
                `<i class="snap-meter-bar${i < Math.round(this._snapSensitivity * 5) ? ' on' : ''}"></i>`).join('');
            const meter = `<span class="snap-meter" aria-label="Sensitivity ${pct} %">${bars}</span><span class="snap-pct">${pct}%</span>`;
            let body: string, title: string;
            if (source === 'detector') {
                body = `<span class="snap-src">BirdBox</span><span class="snap-pct">≥ ${conf}</span>`;
                title = `Call box from BirdBox, confidence at least ${conf} — Shift + mouse wheel to change. Click or Enter adds the label.`;
            } else if (tune === 'conf') {
                body = `<span class="snap-src">Signal</span><span class="snap-pct">BirdBox ≥ ${conf}: none</span>`;
                title = `No BirdBox box here at confidence ${conf}, so the box follows the signal — Shift + mouse wheel lowers the confidence. Click or Enter adds the label.`;
            } else {
                body = (detector ? '<span class="snap-src">Signal</span>' : '') + meter;
                title = `${detector ? 'No BirdBox box here, so the box follows the signal. ' : ''}Sensitivity ${pct} % — Shift + mouse wheel to change. Click or Enter adds the label.`;
            }
            el.innerHTML = '<i class="snap-corner tl"></i><i class="snap-corner tr"></i><i class="snap-corner bl"></i><i class="snap-corner br"></i>'
                + `<span class="snap-chip" title="${title}">${body}`
                + '<span class="snap-sep"></span><kbd>⇧ scroll</kbd><kbd>↵</kbd></span>';
            const chip = el.querySelector('.snap-chip') as HTMLElement;
            // Above the box; below it at the top edge; inside when it spans the full height
            const roomBelow = g.top + g.height < height - 26;
            chip.classList.toggle('below', g.top < 26 && roomBelow);
            chip.classList.toggle('inside', g.top < 26 && !roomBelow);
        } else {
            const g = this._toGeometry(this._normalize({ start: time, end: time, freqMin: freq, freqMax: freq, label: '' }), width, height);
            el.className = 'snap-miss';
            Object.assign(el.style, { left: `${g.left}px`, top: `${g.top}px`, width: '', height: '' });
            const text = tune === 'conf'
                ? `No call here · BirdBox ≥ ${conf}: none — ⇧ scroll to lower`
                : 'reason' in result && result.reason === 'noise'
                    ? 'No call here — try a brighter trace'
                    : `Merges with background · ${pct}% — ⇧ scroll to lower`;
            el.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>';
            el.append(text);
        }
    }

    _clearSnap() {
        this._snap = null;
        this._snapAt = null;
        if (this._snapEl?.parentNode) this._snapEl.parentNode.removeChild(this._snapEl);
        this._snapEl = null;
    }

    _snapContains(clientX: number, clientY: number) {
        const r = this._snap?.result;
        if (!r?.ok) return false;
        const t = this._clientXToTime(clientX), f = this._clientYToFreq(clientY);
        return t >= r.box.start && t <= r.box.end && f >= r.box.freqMin && f <= r.box.freqMax;
    }

    _commitSnap(forcePicker = false) {
        const r = this._snap?.result;
        if (!r?.ok) return;
        const region = this._normalize({ ...r.box, label: `Label ${this._counter++}` });
        this._clearSnap();
        this._openNewLabelPicker(region, { forcePicker });
    }

    exitSnapMode() {
        if (!this.snapMode) return;
        this.snapMode = false;
        this._clearSnap();
        this.dispatchEvent(new CustomEvent('snapmodechange', { detail: { active: false } }));
    }

    exitZoomBoxMode() {
        if (!this.zoomBoxMode) return;
        this.zoomBoxMode = false;
        this._clearZoomBox();
        this.dispatchEvent(new CustomEvent('zoomboxmodechange', { detail: { active: false } }));
    }

    _clearZoomBox() {
        this._zoomBox = null;
        if (this._zoomBoxEl?.parentNode) this._zoomBoxEl.parentNode.removeChild(this._zoomBoxEl);
        this._zoomBoxEl = null;
    }

    _updateZoomBox() {
        const box = this._zoomBox;
        if (!box || !this.overlay) return;
        if (!this._zoomBoxEl) {
            this._zoomBoxEl = document.createElement('div');
            this._zoomBoxEl.className = 'spectrogram-label-draft zoom-box';
            this.overlay.appendChild(this._zoomBoxEl);
        }
        const width = parseFloat(this.overlay.style.width) || 1;
        const height = parseFloat(this.overlay.style.height) || 1;
        const g = this._toGeometry(this._normalize({
            start: box.startTime,
            end: box.endTime,
            freqMin: Math.min(box.startFreq, box.endFreq),
            freqMax: Math.max(box.startFreq, box.endFreq),
            label: '',
        }), width, height);
        Object.assign(this._zoomBoxEl.style, { left: `${g.left}px`, top: `${g.top}px`, width: `${g.width}px`, height: `${g.height}px` });
    }

    _bindDrawingInteractions(wrapper: any) {
        const onPointerDown = (e: PointerEvent) => {
            if (this.zoomBoxMode && (e.button === 0 || e.button === 2)) {
                if (!this.player?._state?.audioBuffer) return;
                this.player?._state?._blockSeekClicks?.(400);
                if (e.button === 2) {
                    this._suppressContextMenuUntil = performance.now() + 400;
                    this.dispatchEvent(new CustomEvent('zoomboxback'));
                } else {
                    const t = this._clientXToTime(e.clientX);
                    const f = this._clientYToFreq(e.clientY);
                    this._zoomBox = { startTime: t, startFreq: f, endTime: t, endFreq: f, x0: e.clientX, y0: e.clientY };
                    this._updateZoomBox();
                }
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            if (this.snapMode && e.button === 0) {
                // Own labels keep their clicks; detections (locked: BirdBox / BirdNET boxes shown
                // on the spectrogram) let the snap through, except on their ✓ / ✕ buttons
                const overLabel = (e.target as Element)?.closest?.('.spectrogram-label-region') as HTMLElement | null;
                if (overLabel) {
                    if (!this._lockedIds.has(overLabel.dataset.id || '') || (e.target as Element)?.closest?.('button')) return;
                    this._suppressClickUntil = performance.now() + 400;
                }
                if (!this.player?._state?.audioBuffer) return;
                this.player?._state?._blockSeekClicks?.(400);
                if (this._snapContains(e.clientX, e.clientY)) this._commitSnap(e.altKey);
                else this._runSnap(this._clientXToTime(e.clientX), this._clientYToFreq(e.clientY));
                e.preventDefault();
                e.stopPropagation();
                return;
            }
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
            if ((!e.shiftKey && !this.drawMode) || e.button !== 0 || (this.player as any)?._readOnly) return;
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
                // Virtual pointer: Shift = fine mode (1/4 speed, pointer lock so it never hits the screen edge)
                this._editPointerMove(e);
                const ed = this._editing as any;
                if (ed) this._updateEditLoupe(ed.vx, ed.vy, { readout: this._editReadout() });
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            if (this._zoomBox) {
                this._zoomBox.endTime = this._clientXToTime(e.clientX);
                this._zoomBox.endFreq = this._clientYToFreq(e.clientY);
                this._updateZoomBox();
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            if (this._drawing) {
                this._drawing.endTime = this._clientXToTime(e.clientX);
                this._drawing.endFreq = this._clientYToFreq(e.clientY);
                this._updateDraft();
                const d = this._drawing;
                this._updateEditLoupe(e.clientX, e.clientY, {
                    el: this._draftEl, mode: 'draw', fine: false,
                    readout: this._fmtRange(Math.min(d.startTime, d.endTime), Math.max(d.startTime, d.endTime),
                        Math.min(d.startFreq, d.endFreq), Math.max(d.startFreq, d.endFreq)),
                });
                e.preventDefault();
                e.stopPropagation();
            }
        };

        const onPointerUp = (e: PointerEvent) => {
            if (this._zoomBox) {
                const box = this._zoomBox;
                this._clearZoomBox();
                // A plain click (tiny drag) does nothing
                if (Math.abs(e.clientX - box.x0) >= 6 && Math.abs(e.clientY - box.y0) >= 6) {
                    this.dispatchEvent(new CustomEvent('zoomboxselect', { detail: {
                        start: Math.min(box.startTime, box.endTime),
                        end: Math.max(box.startTime, box.endTime),
                        freqMin: Math.min(box.startFreq, box.endFreq),
                        freqMax: Math.max(box.startFreq, box.endFreq),
                    } }));
                }
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            if (this._editing) {
                this._finishEditInteraction();
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            if (this._drawing) {
                this._hideLoupeCanvas();
                const region = this._finalizeDraft();
                this._clearDraft();
                if (region) {
                    this._openNewLabelPicker(region, { forcePicker: e.altKey });
                }
                e.preventDefault();
                e.stopPropagation();
            }
        };

        // Prevent browser context-menu in stamp mode (and briefly after exiting via right-click)
        const onContextMenu = (e: Event) => {
            if (this.stampMode || this.zoomBoxMode || this._suppressContextMenuUntil > performance.now()) {
                e.preventDefault(); e.stopPropagation();
            }
        };

        // Keyboard: X/Y = axis lock (stamp + grab), Escape = exit stamp
        const onKeyDown = (e: KeyboardEvent) => {
            // Don't intercept when user is typing in an input
            const tag = ((e.target as HTMLElement)?.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || (e.target as any)?.isContentEditable) return;

            // Escape while dragging/resizing a label: back to where it started (grab has its own handler)
            if (e.key === 'Escape' && this._editing && !this._grabbing) {
                e.preventDefault();
                e.stopPropagation();
                this._cancelEditInteraction();
                return;
            }

            if (this.snapMode && (e.key === 'Escape' || e.key === 'Enter')) {
                e.preventDefault();
                if (e.key === 'Enter') this._commitSnap(e.altKey);
                else if (this._snap) this._clearSnap();
                else this.exitSnapMode();
                return;
            }

            if (this.zoomBoxMode && e.key === 'Escape') {
                e.preventDefault();
                if (this._zoomBox) this._clearZoomBox();
                else this.exitZoomBoxMode();
                return;
            }

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

            // Shift during a drag: fine mode (keydown counts as user activation for pointer lock)
            if (e.key === 'Shift' && this._editing && !(this._editing as any).pending && !this._fineLockRequested) {
                this._beginFineMode();
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

        this._interactionRoot = wrapper;
        // Leaving pointer lock puts the real cursor back where it was locked:
        // resync so the label does not jump to it.
        const onLockChange = () => {
            if (document.pointerLockElement === wrapper) return;
            const ed = this._editing as any;
            if (ed) ed.resync = true;
            this._fineLockRequested = false;
            this._updateFineCursor(null, 0);
        };
        document.addEventListener('pointerlockchange', onLockChange);
        this._domCleanups.push(() => document.removeEventListener('pointerlockchange', onLockChange));
        wrapper.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('pointermove', onPointerMove, true);
        document.addEventListener('pointerup', onPointerUp, true);
        document.addEventListener('pointercancel', onPointerUp, true);
        wrapper.addEventListener('contextmenu', onContextMenu, true);
        document.addEventListener('keydown', onKeyDown, true);

        // Shift+wheel tunes the snap (detector confidence or signal sensitivity) while a preview is shown
        const onWheel = (e: WheelEvent) => {
            if (!this.snapMode || !this._snap || !e.shiftKey) return;
            e.preventDefault();
            e.stopPropagation();
            const up = (e.deltaY || e.deltaX) < 0;
            // Up = more sensitive: a lower detector confidence, or a higher signal sensitivity
            if (this._snap.tune === 'conf') {
                this._snapBoxConf = Math.min(0.95, Math.max(0.05, Math.round((this._snapBoxConf + (up ? -0.05 : 0.05)) * 100) / 100));
            } else {
                this._snapSensitivity = Math.min(0.99, Math.max(0.01, this._snapSensitivity + (up ? 0.02 : -0.02)));
            }
            this._runSnap(this._snap.time, this._snap.freq);
        };
        wrapper.addEventListener('wheel', onWheel, { capture: true, passive: false });
        this._domCleanups.push(() => wrapper.removeEventListener('wheel', onWheel, true));

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

    /**
     * Name a freshly drawn / snapped region. With a species in the label template the
     * label is added at once (species + template tags); otherwise, or with
     * `forcePicker` (Alt held), the dialog opens, pre-filled from the template.
     */
    _openNewLabelPicker(region: any, { forcePicker = false }: { forcePicker?: boolean } = {}) {
        const tpl = this.player?.getSpeciesBarSelection?.();
        if (tpl?.name && !forcePicker) {
            region.label = tpl.name;
            region.color = tpl.color || colorForName(tpl.name);
            region.scientificName = tpl.scientificName || '';
            region.tags = { ...(tpl.tags || {}) };
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
        // Pre-fill: the template wins; what it leaves open comes from the focused/last label
        // (skip XC metadata)
        const ref = this._getReferenceLabelForDefaults();
        const isXcRef = ref?.origin === 'xeno-canto';
        const tplTags = tpl && Object.keys(tpl.tags || {}).length ? tpl.tags : null;
        const initialValue = tpl?.name || ref?.label || '';
        const initialColor = (tpl?.name ? tpl.color : ref?.color) || _autoAssignColor(this._items);
        const refName = initialValue.trim().toLowerCase();
        openLabelNameEditor({
            layer: this,
            player: this.player,
            initialValue,
            initialColor,
            initialTags: tplTags || (tpl?.name || isXcRef ? null : (ref?.tags || null)),
            initialScientificName: tpl?.name ? (tpl.scientificName || '') : (ref?.scientificName || ''),
            existingLabels,
            title: 'New Label',
            // "Keep for next labels" makes this label the template
            offerTemplate: typeof this.player?.setSpeciesBar === 'function',
            onSubmit: ({ name, color, scientificName = '', tags = {}, changed = {}, keepAsTemplate = false }: any) => {
                // If user typed a different name but didn't manually change color,
                // auto-assign a deterministic color for the new name.
                const nameChanged = name.trim().toLowerCase() !== refName;
                region.label = name;
                region.color = (nameChanged && !changed.color) ? colorForName(name) : color;
                region.scientificName = String(scientificName || '').trim();
                region.tags = tags;
                this.add(region);
                if (keepAsTemplate) {
                    this.player?.setSpeciesBar?.(region.label, { color: region.color, scientificName: region.scientificName, tags: { ...tags } });
                }
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
        // A time-only resize keeps the band as stored: _normalize clamps it to the display maximum
        if (editing.mode === 'resize-l' || editing.mode === 'resize-r') {
            next.freqMin = src.freqMin; next.freqMax = src.freqMax;
            editing.keepBand = this._storedBands.get(src.id) || { freqMin: src.freqMin, freqMax: src.freqMax };
        } else editing.keepBand = null;

        // Preserve band thickness on pure move (in pixel space, not Hz)
        if (editing.mode === 'move') {
            const timeSpan = Math.max(0.01, src.end - src.start);
            next.end = next.start + timeSpan;

            // Keep the original pixel height: shift freqMax from freqMin's
            // new pixel position by the original pixel span.
            const origPixelSpan = Math.abs(srcMinPy - srcMaxPy);
            const newMinPy = c ? c.frequencyToPixelY(next.freqMin ?? 0) : height;
            const newMaxPy = newMinPy - origPixelSpan;  // top = lower Y
            next.freqMax = c ? c.pixelYToFrequency(newMaxPy) : (next.freqMax ?? 0);

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

    // ── Edit loupe: magnified view next to the cursor while moving/resizing ──

    _editLoupeEnabled(): boolean {
        return this._loupeMode() !== 'off';
    }

    /** Loupe setting: 'pointer' (next to the cursor while editing), 'window' (movable panel) or 'off'. */
    _loupeMode(): 'pointer' | 'window' | 'off' {
        const sel = this._settingEl('loupeModeSelect') as HTMLSelectElement | null;
        if (!sel) return 'pointer';
        if (!sel.dataset.awBound) {
            sel.dataset.awBound = '1';
            try { const v = localStorage.getItem('aw-loupe-mode'); if (v) sel.value = v; } catch { /* storage blocked */ }
            sel.addEventListener('change', () => {
                try { localStorage.setItem('aw-loupe-mode', sel.value); } catch { /* storage blocked */ }
            });
        }
        const v = sel.value;
        return v === 'window' || v === 'off' ? v : 'pointer';
    }

    /**
     * Settings control by data-aw. Hosts may move the settings sections out of
     * the player root (labeling app: Display sidebar), so prefer the DOM refs
     * cached at startup and only fall back to a root query.
     */
    _settingEl(dataAw: string): HTMLElement | null {
        return (this.player?._state?.d?.[dataAw] as HTMLElement | null | undefined)
            ?? (this.player?.root?.querySelector?.(`[data-aw="${dataAw}"]`) as HTMLElement | null)
            ?? null;
    }

    /** Settings checkbox, default on, choice remembered in localStorage. */
    _loupeOption(dataAw: string, storageKey: string, fallback = true): boolean {
        const box = this._settingEl(dataAw) as HTMLInputElement | null;
        if (!box) return fallback;
        if (!box.dataset.awBound) {
            box.dataset.awBound = '1';
            try {
                const v = localStorage.getItem(storageKey);
                if (v === '0') box.checked = false;
                else if (v === '1') box.checked = true;
            } catch { /* storage blocked */ }
            box.addEventListener('change', () => {
                try { localStorage.setItem(storageKey, box.checked ? '1' : '0'); } catch { /* storage blocked */ }
            });
        }
        return box.checked;
    }

    /**
     * Detail mode: render the loupe area from its own fine linear-dB STFT
     * (same analysis as Snap: Hann ~11.6 ms, 75 % overlap) instead of
     * magnifying the display pixels. Frequency rows follow the display's
     * y mapping, so boxes line up. Returns false to fall back to the display image.
     */
    _drawLoupeDetail(ctx: CanvasRenderingContext2D, W: number, H: number,
                     cx: number, cy: number, halfW: number, halfH: number): boolean {
        const audio = this.player?._state?.audioBuffer as AudioBuffer | undefined;
        if (!audio || !this.player?.computeSnapPatch) return false;
        const tA = this._clientXToTime(cx - halfW), tB = this._clientXToTime(cx + halfW);
        // Keep it cheap: no detail for very wide spans (long horizontal edges)
        if (!(tB > tA) || tB - tA > 8) return false;

        let c = this._loupePatch as any;
        if (!c || c.audio !== audio || tA < c.tLo || tB > c.tHi) {
            const patch = this.player.computeSnapPatch((tA + tB) / 2, Math.max(0.5, tB - tA));
            if (!patch) return false;
            c = this._loupePatch = {
                audio, patch,
                tLo: patch.atStart ? -Infinity : patch.t0,
                tHi: patch.atEnd ? Infinity : patch.t0 + (patch.frames - 1) * patch.dt,
            };
        }
        const pt = c.patch;

        // Column -> frame range, row -> bin range (max-pool when zoomed out)
        const fA = new Int32Array(W), fB = new Int32Array(W);
        for (let x = 0; x < W; x++) {
            const t0 = tA + (x / W) * (tB - tA), t1 = tA + ((x + 1) / W) * (tB - tA);
            const a = Math.round((t0 - pt.t0) / pt.dt), b = Math.round((t1 - pt.t0) / pt.dt);
            fA[x] = a; fB[x] = Math.max(a, b - 1);
        }
        const bA = new Int32Array(H), bB = new Int32Array(H);
        const yTop = cy - halfH, ySpan = 2 * halfH;
        for (let y = 0; y < H; y++) {
            const fHi = this._clientYToFreq(yTop + (y / H) * ySpan);
            const fLo = this._clientYToFreq(yTop + ((y + 1) / H) * ySpan);
            const a = Math.round((Math.min(fLo, fHi) - pt.f0) / pt.df), b = Math.round((Math.max(fLo, fHi) - pt.f0) / pt.df);
            bA[y] = a; bB[y] = Math.max(a, b - 1);
        }
        const val = new Float32Array(W * H).fill(-Infinity);
        let hi = -Infinity;
        for (let y = 0; y < H; y++) {
            const b0 = Math.max(0, bA[y]), b1 = Math.min(pt.bins - 1, bB[y]);
            if (b1 < b0) continue;
            for (let x = 0; x < W; x++) {
                const f0 = Math.max(0, fA[x]), f1 = Math.min(pt.frames - 1, fB[x]);
                let m = -Infinity;
                for (let f = f0; f <= f1; f++) {
                    const row = f * pt.bins;
                    for (let k = b0; k <= b1; k++) { const v = pt.values[row + k]; if (v > m) m = v; }
                }
                val[y * W + x] = m;
                if (m > hi) hi = m;
            }
        }
        if (!Number.isFinite(hi)) return false;
        const RANGE = 70;
        const lo = hi - RANGE;

        const scheme = (this._settingEl('colorSchemeSelect') as HTMLSelectElement | null)?.value || 'grayscale';
        if (this._loupeLutScheme !== scheme) {
            const lut = new Uint8ClampedArray(256 * 3);
            for (let i = 0; i < 256; i++) {
                const col = getSpectrogramColor(i / 255, scheme);
                lut[i * 3] = col.r; lut[i * 3 + 1] = col.g; lut[i * 3 + 2] = col.b;
            }
            this._loupeLut = lut;
            this._loupeLutScheme = scheme;
        }
        const lut = this._loupeLut as Uint8ClampedArray;
        let off = this._loupeOff as HTMLCanvasElement | null;
        if (!off || off.width !== W || off.height !== H) {
            off = document.createElement('canvas');
            off.width = W; off.height = H;
            this._loupeOff = off;
        }
        const octx = off.getContext('2d');
        if (!octx) return false;
        const img = octx.createImageData(W, H);
        const d = img.data;
        for (let i = 0; i < W * H; i++) {
            const v = val[i];
            const o = i * 4;
            if (v === -Infinity) { d[o] = d[o + 1] = d[o + 2] = 0; d[o + 3] = 255; continue; }
            const li = Math.max(0, Math.min(255, Math.round(((v - lo) / RANGE) * 255))) * 3;
            d[o] = lut[li]; d[o + 1] = lut[li + 1]; d[o + 2] = lut[li + 2]; d[o + 3] = 255;
        }
        octx.putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(off, 0, 0, W, H);
        return true;
    }

    /**
     * Loupe next to the pointer. Defaults to the current edit interaction;
     * `opts` lets other interactions (drawing a new box) reuse it.
     *  - move: whole box, uniformly fitted; hidden when the box is too large to gain anything
     *  - edge: magnified across the edge, full edge length along it (non-uniform)
     *  - corner / draw: magnified around the pointer
     */
    _updateEditLoupe(clientX: number, clientY: number, opts: { el?: HTMLElement | null; mode?: string; readout?: string; fine?: boolean } = {}) {
        const editing = this._editing as any;
        const el = opts.el !== undefined ? opts.el : (editing?.element as HTMLElement | null);
        const mode = opts.mode ?? editing?.mode;
        if (!mode || (editing && !opts.mode && editing.pending) || !this._editLoupeEnabled()) { this._hideEditLoupe(); return; }
        const src = this.player?._state?.d?.spectrogramCanvas as HTMLCanvasElement | null;
        if (!src || !src.width || !src.height) return;
        const W = 260, H = 180, ZOOM = 4, PAD = 24, MARGIN = 40;
        const b = el?.getBoundingClientRect();

        let zx = ZOOM, zy = ZOOM, cx = clientX, cy = clientY;
        if (b && mode === 'move') {
            cx = b.left + b.width / 2;
            cy = b.top + b.height / 2;
            const z = Math.min(ZOOM, (W - MARGIN) / Math.max(1, b.width), (H - MARGIN) / Math.max(1, b.height));
            // A large box barely gets magnified: the loupe would only cover the view
            if (z < 1.5) { this._hideLoupeCanvas(); return; }
            zx = zy = z;
        } else if (b && (mode === 'resize-l' || mode === 'resize-r')) {
            cx = mode === 'resize-l' ? b.left : b.right;
            cy = b.top + b.height / 2;
            zy = Math.max(0.15, Math.min(ZOOM, (H - MARGIN) / Math.max(1, b.height)));
        } else if (b && (mode === 'resize-t' || mode === 'resize-b')) {
            cx = b.left + b.width / 2;
            cy = mode === 'resize-t' ? b.top : b.bottom;
            zx = Math.max(0.15, Math.min(ZOOM, (W - MARGIN) / Math.max(1, b.width)));
        }
        // Corner: centre on the box corner itself, not on the pointer (the grab
        // point on the handle is a few px off the corner and that offset stays)
        if (b && /^resize-[tb][lr]$/.test(mode)) {
            cx = mode.endsWith('l') ? b.left : b.right;
            cy = mode.includes('-t') ? b.top : b.bottom;
        }

        if (this._loupeMode() === 'window') {
            this._hideLoupeCanvas();
            const w = this._loupeWin;
            if (w) this._paintLoupe(w.cv, parseFloat(w.cv.style.width), parseFloat(w.cv.style.height), cx, cy, zx, zy, el, mode, opts);
            return;
        }
        let cv = this._editLoupeEl as HTMLCanvasElement | null;
        if (!cv) {
            cv = document.createElement('canvas');
            cv.className = 'spectrogram-edit-loupe';
            const dpr = window.devicePixelRatio || 1;
            cv.width = Math.round(W * dpr);
            cv.height = Math.round(H * dpr);
            cv.style.width = `${W}px`;
            cv.style.height = `${H}px`;
            document.body.appendChild(cv);
            this._editLoupeEl = cv;
        }
        // Place top-right of the pointer, flip when it would leave the window
        let left = clientX + PAD, top = clientY - H - PAD;
        if (left + W > window.innerWidth - 4) left = clientX - W - PAD;
        if (top < 4) top = clientY + PAD;
        cv.style.left = `${Math.max(4, left)}px`;
        cv.style.top = `${Math.max(4, Math.min(window.innerHeight - H - 4, top))}px`;

        this._paintLoupe(cv, W, H, cx, cy, zx, zy, el, mode, opts);
    }

    // ── Loupe window: movable panel magnifying around the pointer ─────
    _loupeWin: { el: HTMLElement; cv: HTMLCanvasElement; zoomEl: HTMLElement; zoom: number } | null = null;
    _loupeWinRaf = 0;

    _bindLoupeWindow(root: HTMLElement) {
        const sel = this._settingEl('loupeModeSelect') as HTMLSelectElement | null;
        const sync = () => this._setLoupeWindow(this._loupeMode() === 'window');
        sel?.addEventListener('change', sync);
        sync();
        root.addEventListener('pointermove', (e: PointerEvent) => {
            // While editing, the edit loupe paints the window
            if (!this._loupeWin || this._loupeWinRaf || this._editing) return;
            const { clientX, clientY } = e;
            this._loupeWinRaf = requestAnimationFrame(() => {
                this._loupeWinRaf = 0;
                this._paintLoupeWindow(clientX, clientY);
            });
        });
    }

    _setLoupeWindow(on: boolean) {
        if (!on) { this._loupeWin?.el.remove(); this._loupeWin = null; return; }
        if (this._loupeWin) return;
        const W = 320, H = 220;
        const el = document.createElement('div');
        el.className = 'loupe-window';
        el.innerHTML = '<div class="loupe-window-bar" title="Drag to move"><span class="loupe-window-title">Loupe</span>'
            + '<button type="button" data-z="-1" title="Less zoom">−</button><span class="loupe-window-zoom"></span>'
            + '<button type="button" data-z="1" title="More zoom">+</button>'
            + '<button type="button" class="loupe-window-close" title="Close (back to loupe at pointer)">×</button></div>';
        const cv = document.createElement('canvas');
        const dpr = window.devicePixelRatio || 1;
        cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
        cv.style.width = `${W}px`; cv.style.height = `${H}px`;
        el.appendChild(cv);
        let pos = { x: window.innerWidth - W - 40, y: 120 };
        try { const p = JSON.parse(localStorage.getItem('aw-loupe-window-pos') || 'null'); if (p) pos = p; } catch { /* ignore */ }
        let zoom = 4;
        try { zoom = Number(localStorage.getItem('aw-loupe-window-zoom')) || 4; } catch { /* ignore */ }
        const place = (x: number, y: number) => {
            pos = { x: Math.max(0, Math.min(window.innerWidth - 80, x)), y: Math.max(0, Math.min(window.innerHeight - 40, y)) };
            el.style.left = `${pos.x}px`; el.style.top = `${pos.y}px`;
        };
        place(pos.x, pos.y);
        document.body.appendChild(el);
        const zoomEl = el.querySelector('.loupe-window-zoom') as HTMLElement;
        this._loupeWin = { el, cv, zoomEl, zoom };
        zoomEl.textContent = `${zoom}×`;
        // Drag by the title bar
        const bar = el.querySelector('.loupe-window-bar') as HTMLElement;
        bar.addEventListener('pointerdown', (e: PointerEvent) => {
            if ((e.target as Element).closest('button')) return;
            e.preventDefault();
            const ox = e.clientX - pos.x, oy = e.clientY - pos.y;
            bar.setPointerCapture(e.pointerId);
            const move = (m: PointerEvent) => place(m.clientX - ox, m.clientY - oy);
            const up = () => {
                bar.removeEventListener('pointermove', move);
                try { localStorage.setItem('aw-loupe-window-pos', JSON.stringify(pos)); } catch { /* ignore */ }
            };
            bar.addEventListener('pointermove', move);
            bar.addEventListener('pointerup', up, { once: true });
        });
        el.addEventListener('click', (e) => {
            const btn = (e.target as Element).closest('button') as HTMLButtonElement | null;
            if (!btn || !this._loupeWin) return;
            if (btn.classList.contains('loupe-window-close')) {
                // Closing the window switches back to the loupe at the pointer
                const sel = this._settingEl('loupeModeSelect') as HTMLSelectElement | null;
                if (sel) { sel.value = 'pointer'; sel.dispatchEvent(new Event('change')); } else this._setLoupeWindow(false);
                return;
            }
            const steps = [2, 3, 4, 6, 8, 12];
            const i = Math.max(0, steps.indexOf(this._loupeWin.zoom));
            this._loupeWin.zoom = steps[Math.max(0, Math.min(steps.length - 1, i + Number(btn.dataset.z)))];
            this._loupeWin.zoomEl.textContent = `${this._loupeWin.zoom}×`;
            try { localStorage.setItem('aw-loupe-window-zoom', String(this._loupeWin.zoom)); } catch { /* ignore */ }
        });
    }

    _paintLoupeWindow(clientX: number, clientY: number) {
        const w = this._loupeWin;
        const src = this.player?._state?.d?.spectrogramCanvas as HTMLCanvasElement | null;
        if (!w || !src) return;
        const r = src.getBoundingClientRect();
        // Only while the pointer is over the spectrogram; keep the last view otherwise
        if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return;
        const W = parseFloat(w.cv.style.width), H = parseFloat(w.cv.style.height);
        const t = this._clientXToTime(clientX), f = this._clientYToFreq(clientY);
        this._paintLoupe(w.cv, W, H, clientX, clientY, w.zoom, w.zoom, null, 'pointer',
            { readout: `${t.toFixed(3)} s · ${Math.round(f)} Hz` });
    }

    /** Draw the magnified spectrogram around (cx, cy) into a loupe canvas. */
    _paintLoupe(cv: HTMLCanvasElement, W: number, H: number, cx: number, cy: number, zx: number, zy: number,
                el: HTMLElement | null | undefined, mode: string, opts: { readout?: string; fine?: boolean } = {}) {
        const src = this.player?._state?.d?.spectrogramCanvas as HTMLCanvasElement | null;
        if (!src || !src.width || !src.height) return;
        const b = el?.getBoundingClientRect();
        const ctx = cv.getContext('2d');
        if (!ctx) return;
        const r = src.getBoundingClientRect();
        const sx = src.width / Math.max(1, r.width), sy = src.height / Math.max(1, r.height);
        const halfW = W / zx / 2, halfH = H / zy / 2; // in CSS px around the centre
        ctx.setTransform(cv.width / W, 0, 0, cv.height / H, 0, 0);
        ctx.imageSmoothingEnabled = zx < 1 || zy < 1;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        const detail = this._loupeOption('loupeDetailCheck', 'aw-loupe-detail', false)
            && this._drawLoupeDetail(ctx, W, H, cx, cy, halfW, halfH);
        if (!detail) {
            try {
                ctx.drawImage(src,
                    (cx - halfW - r.left) * sx, (cy - halfH - r.top) * sy, 2 * halfW * sx, 2 * halfH * sy,
                    0, 0, W, H);
            } catch { /* canvas not ready */ }
        }
        const mx = (x: number) => (x - (cx - halfW)) * zx;
        const my = (y: number) => (y - (cy - halfH)) * zy;
        // Neighbouring labels (thin, grey) for alignment
        if (this.overlay) {
            ctx.font = '10px system-ui, sans-serif';
            ctx.textBaseline = 'top';
            ctx.setLineDash([4, 3]);
            ctx.lineWidth = 1;
            for (const n of this.overlay.querySelectorAll('.spectrogram-label-region')) {
                if (n === el) continue;
                const nb = (n as HTMLElement).getBoundingClientRect();
                const x0 = mx(nb.left), y0 = my(nb.top), w = nb.width * zx, h = nb.height * zy;
                if (x0 > W || y0 > H || x0 + w < 0 || y0 + h < 0) continue;
                ctx.strokeStyle = 'rgba(203, 213, 225, 0.75)';
                ctx.strokeRect(x0, y0, w, h);
                const name = (n.querySelector('.spectrogram-label-name')?.textContent || '').trim();
                if (name) {
                    ctx.fillStyle = 'rgba(226, 232, 240, 0.85)';
                    ctx.fillText(name, Math.max(2, x0 + 2), Math.max(2, y0 + 2), Math.max(20, w - 4));
                }
            }
            ctx.setLineDash([]);
        }
        if (b) {
            ctx.strokeStyle = 'rgba(255, 220, 80, 0.95)';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(mx(b.left), my(b.top), b.width * zx, b.height * zy);
        }
        if (mode !== 'move') {
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H);
            ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2);
            ctx.stroke();
            ctx.setLineDash([]);
        }
        ctx.font = '600 11px system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        if (opts.readout) {
            const tw = ctx.measureText(opts.readout).width;
            ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
            ctx.fillRect(0, H - 20, Math.min(W, tw + 12), 20);
            ctx.fillStyle = '#f8fafc';
            ctx.fillText(opts.readout, 6, H - 10);
        }
        if (opts.fine ?? this._fineActive) {
            ctx.fillStyle = 'rgba(56, 189, 248, 0.9)';
            ctx.fillRect(W - 42, 4, 38, 18);
            ctx.fillStyle = '#0f172a';
            ctx.fillText('FINE', W - 37, 13);
        }
    }

    _fmtRange(t0: number, t1: number, f0: number, f1: number) {
        return `${t0.toFixed(3)}–${t1.toFixed(3)} s · ${Math.round(f0)}–${Math.round(f1)} Hz`;
    }

    /** Value(s) being changed by the current edit, for the loupe readout. */
    _editReadout(): string {
        const ed = this._editing as any;
        const l = ed && this._items.find((i: any) => i.id === ed.id) as any;
        if (!l) return '';
        const start = `Start ${l.start.toFixed(3)} s`, end = `End ${l.end.toFixed(3)} s`;
        const fmax = `fMax ${Math.round(l.freqMax ?? 0)} Hz`, fmin = `fMin ${Math.round(l.freqMin ?? 0)} Hz`;
        switch (ed.mode) {
            case 'resize-l': return start;
            case 'resize-r': return end;
            case 'resize-t': return fmax;
            case 'resize-b': return fmin;
            case 'resize-tl': return `${start} · ${fmax}`;
            case 'resize-tr': return `${end} · ${fmax}`;
            case 'resize-bl': return `${start} · ${fmin}`;
            case 'resize-br': return `${end} · ${fmin}`;
            default: return this._fmtRange(l.start, l.end, l.freqMin ?? 0, l.freqMax ?? 0);
        }
    }

    _hideLoupeCanvas() {
        if (this._editLoupeEl?.parentNode) this._editLoupeEl.parentNode.removeChild(this._editLoupeEl);
        this._editLoupeEl = null;
    }

    /** End of an interaction: loupe away, leave fine mode / pointer lock. */
    _hideEditLoupe() {
        this._hideLoupeCanvas();
        this._endFineMode();
    }

    // -- Fine mode (Shift): 1/4 speed, Blender-style endless drag via Pointer Lock --

    /** Advance the virtual pointer for this move event (movementX/Y while locked, else client delta). */
    _editPointerMove(e: PointerEvent) {
        const ed = this._editing as any;
        if (!ed) return;
        if (ed.vx == null) { ed.vx = ed.startX; ed.vy = ed.startY; ed.lastX = ed.startX; ed.lastY = ed.startY; }
        const locked = !!this._interactionRoot && document.pointerLockElement === this._interactionRoot;
        let dx: number, dy: number;
        if (locked) { dx = e.movementX || 0; dy = e.movementY || 0; }
        else if (ed.resync) { dx = 0; dy = 0; ed.resync = false; }
        else { dx = e.clientX - ed.lastX; dy = e.clientY - ed.lastY; }
        if (!locked) { ed.lastX = e.clientX; ed.lastY = e.clientY; }

        const fine = e.shiftKey && !ed.pending;
        if (fine && !locked && !this._fineLockRequested) this._beginFineMode();
        else if (!fine && locked) this._endFineMode();
        this._fineActive = fine;

        const k = fine ? 0.25 : 1;
        ed.vx += dx * k;
        ed.vy += dy * k;
        this._updateEditInteraction(ed.vx, ed.vy);
        this._updateFineCursor(locked ? ed.vx : null, ed.vy);
    }

    _beginFineMode() {
        const root = this._interactionRoot as HTMLElement | null;
        if (!root?.requestPointerLock) return;
        this._fineLockRequested = true;
        try {
            const p: any = root.requestPointerLock();
            p?.catch?.(() => { /* denied: fine mode still works, just without wrap */ });
        } catch { /* unsupported */ }
    }

    _endFineMode() {
        this._fineLockRequested = false;
        this._fineActive = false;
        this._updateFineCursor(null, 0);
        if (this._interactionRoot && document.pointerLockElement === this._interactionRoot) {
            try { document.exitPointerLock(); } catch { /* ignore */ }
        }
    }

    /** While the real pointer is locked (hidden), draw a stand-in crosshair at the virtual position. */
    _updateFineCursor(x: number | null, y: number) {
        if (x == null) {
            if (this._fineCursorEl?.parentNode) this._fineCursorEl.parentNode.removeChild(this._fineCursorEl);
            this._fineCursorEl = null;
            return;
        }
        if (!this._fineCursorEl) {
            this._fineCursorEl = document.createElement('div');
            this._fineCursorEl.className = 'spectrogram-fine-cursor';
            document.body.appendChild(this._fineCursorEl);
        }
        this._fineCursorEl.style.left = `${x}px`;
        this._fineCursorEl.style.top = `${y}px`;
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

        // Movement, Shift fine mode and the loupe come from the shared pointermove handler
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
            this._cancelEditInteraction();   // back to the snapshot, other layer included
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
            document.removeEventListener('pointerdown', confirm, true);
            document.removeEventListener('keydown', onKey, true);
        };

        document.addEventListener('pointerdown', confirm, true);
        document.addEventListener('keydown', onKey, true);
    }

    _renameSpectrogramLabelPrompt(id: any) {
        const label = this._items.find((l: any) => l.id === id);
        if (!label || label.readonly || this._lockedIds.has(id) || (this.player as any)?._readOnly) return;
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
        const { canvasY } = c.clientToCanvas(0, clientY, rect, 0);
        return canvasY;
    }

    _clientYToFreq(clientY: number) {
        const state = this.player?._state;
        const c = state?.coords;
        const wrapper = state?.d?.canvasWrapper;
        if (!wrapper || !c) return 0;
        const rect = wrapper.getBoundingClientRect();
        const { freq } = c.clientToTimeFreq(0, clientY, rect, 0);
        return freq;
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
            ...(Number.isFinite(Number(label?.confidence)) ? { confidence: Number(label.confidence) } : {}),
            ...(label?.fullBand === true ? { fullBand: true } : {}),
            label: meta.label,
            color: meta.color || colorForName(meta.label),
            scientificName: meta.scientificName,
            commonName: meta.commonName,
            origin: meta.origin,
            author: meta.author,
            tags: meta.tags,
            readonly: label?.readonly === true,
            // A similar-call suggestion under review (similar-review.ts): highlighted
            ...((label?.similar ? label.similar.active === true : label?.reviewing === true) ? { reviewing: true } : {}),
            aiSuggested: label?.aiSuggested ?? null,
            recordingId: label?.recordingId ?? null,
            createdAt: label?.createdAt || new Date().toISOString(),
            ...(label?.updatedAt ? { updatedAt: label.updatedAt } : {}),
        };
    }
}
