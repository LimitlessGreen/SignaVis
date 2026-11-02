/**
 * Label grid — Raven-like selection table below the overview ("Table" tab).
 *
 * Shows every label of every source (own, BirdNET, XC / imports) in one flat, sortable,
 * filterable table with spreadsheet-style inline editing. Rows are virtualised (fixed row
 * height), so thousands of BirdNET detections stay cheap.
 *
 *   Keyboard: arrows move the cell cursor · Enter/F2 or typing edits · Enter/Tab commit and
 *   move on · Esc cancels · Delete removes the selected (editable) labels · in a number cell
 *   ↑/↓ step the value (Shift = ×10) and commit right away, so the box moves live.
 *   Mouse: click selects row + cell · Ctrl/Shift click extends the selection · double click edits.
 *   An edit while several rows are selected applies to all editable selected rows.
 *
 * The grid never owns label data: it renders what `render(labels)` passes and reports edits
 * through `onChange(id, updates)` (same path as the properties panel).
 * plans/label-table-view-plan.md
 */

import { TAG_PRESETS } from './label-table.ts';
import { ANNOTA_FIELDS, cycleYN, formatAnnotaValue, isoDay, toYN, type AnnotaField } from '../../domain/annotaFields.ts';
import { showContextMenu } from '../components/context-menu/context-menu.ts';
import { LABEL_EXPORT_FORMATS, type LabelExportColumn, type LabelExportFormat } from '../../infrastructure/export/labelTableFormats.ts';
import { createEditableSelect } from '../components/editable-select/editable-select.ts';
import { OWN_SOURCE_ID } from '../../app/label-sources.ts';

type Lbl = any;
type SourceKey = 'own' | 'bn' | 'xc' | 'imp';
type EditKind = 'species' | 'time' | 'dur' | 'freq' | 'tag' | 'text' | 'yn' | 'date' | null;

interface Column {
  key: string;
  title: string;
  width: number;
  align?: 'right';
  edit: EditKind;
  tip?: string;
  text: (l: Lbl, g: LabelGrid) => string;
  sort: (l: Lbl, g: LabelGrid) => number | string;
  /** Raw columns for CSV export (default: the cell text under the column title). */
  csv?: (g: LabelGrid) => LabelExportColumn[];
  /** Never hidden (needed to read the table). */
  fixed?: boolean;
  /** Hidden until switched on in the column menu. */
  hiddenByDefault?: boolean;
  /** Where a 'text' / 'yn' / 'date' edit is stored: tags[tagKey], or the label field `author`. */
  tagKey?: string;
}

export interface LabelGridOptions {
  host: HTMLElement;
  /** Toolbar slot in the tab strip (filters, counter, follow). */
  tools?: HTMLElement | null;
  resolveName: (lbl: Lbl) => { display: string; scientific: string };
  isLocked: (lbl: Lbl) => boolean;
  layerName?: (lbl: Lbl) => string;
  getViewRange?: () => { start: number; end: number } | null;
  getDuration?: () => number;
  getMaxFreq?: () => number;
  tagStore?: any;
  onChange: (id: string, updates: Record<string, any>) => void;
  /** Row click. interaction: 'click' (single) or 'multi' (Ctrl/Shift extended the selection). */
  onFocus: (id: string) => void;
  onHover?: (id: string | null) => void;
  onMultiSelectionChange?: (ids: string[]) => void;
  onDelete?: (ids: string[]) => void;
  /** Called after an edit was refused (e.g. locked label) with a short reason. */
  onNotice?: (msg: string) => void;
  /** Space outside a checkbox cell (the player hotkeys are off while the table has focus). */
  onTogglePlay?: () => void;
  /** Export the given rows; columns = the visible table columns as raw CSV columns. */
  onExport?: (format: LabelExportFormat, labels: Lbl[], columns: LabelExportColumn[]) => void;
}

const ROW_H = 20;
const OVERSCAN = 8;
const STORE_KEY = 'signavis.labelgrid.v1';

const SOURCE_DEFS: { key: SourceKey; badge: string; title: string }[] = [
  { key: 'own', badge: 'Own', title: 'My labels' },
  { key: 'bn', badge: 'BN', title: 'BirdNET detections' },
  { key: 'xc', badge: 'XC', title: 'Xeno-canto annotations' },
  { key: 'imp', badge: 'Imp', title: 'Other imported sets' },
];

function sourceOf(l: Lbl): SourceKey {
  if (!l.setId || l.setId === OWN_SOURCE_ID) {
    if (l.origin === 'BirdNET') return 'bn';
    return 'own';
  }
  if (l.origin === 'BirdNET') return 'bn';
  if (l.origin === 'xeno-canto') return 'xc';
  return 'imp';
}

const num = (v: any) => (v == null || v === '' || !Number.isFinite(Number(v)) ? NaN : Number(v));
const fmtTime = (v: any) => (Number.isFinite(num(v)) ? num(v).toFixed(3) : '');
const fmtKHz = (v: any) => (Number.isFinite(num(v)) ? (num(v) / 1000).toFixed(2) : '');
const round = (v: any, d: number) => (Number.isFinite(num(v)) ? Math.round(num(v) * 10 ** d) / 10 ** d : '');
const tagPreset = (key: string) => TAG_PRESETS.find((p) => p.key === key)?.options || [];

function tagCol(key: string, title: string, width: number): Column {
  return {
    key: `tag:${key}`, title, width, edit: 'tag',
    text: (l) => String(l.tags?.[key] ?? ''),
    sort: (l) => String(l.tags?.[key] ?? '').toLowerCase(),
  };
}

function annotaCol(f: AnnotaField): Column {
  const width = f.kind === 'yn' ? 64 : f.kind === 'date' ? 92 : f.key === 'remarks' ? 200 : 100;
  return {
    key: `annota:${f.key}`, title: f.short, width, edit: f.kind, tagKey: f.key,
    tip: f.hint, hiddenByDefault: !f.visibleByDefault,
    text: (l) => formatAnnotaValue(f, l.tags?.[f.key]),
    sort: (l) => formatAnnotaValue(f, l.tags?.[f.key]).toLowerCase(),
    csv: () => [{ title: f.label, value: (l) => (f.kind === 'yn' ? toYN(l.tags?.[f.key]) : String(l.tags?.[f.key] ?? '')) }],
  };
}

const COLUMNS: Column[] = [
  { key: 'src', title: 'Src', width: 38, edit: null, tip: 'Source',
    csv: () => [{ title: 'Source', value: (l) => SOURCE_DEFS.find((s) => s.key === sourceOf(l))!.title }],
    text: (l) => SOURCE_DEFS.find((s) => s.key === sourceOf(l))!.badge,
    sort: (l) => sourceOf(l) },
  { key: 'species', title: 'Species', width: 190, edit: 'species', fixed: true,
    csv: (g) => [
      { title: 'Species', value: (l) => g.opts.resolveName(l).display },
      { title: 'Scientific name', value: (l) => g.opts.resolveName(l).scientific },
    ],
    text: (l, g) => g.opts.resolveName(l).display,
    sort: (l, g) => g.opts.resolveName(l).display.toLowerCase() },
  { key: 'start', title: 'Start s', width: 66, align: 'right', edit: 'time', fixed: true,
    csv: () => [{ title: 'Start (s)', value: (l) => round(l.start, 6) }],
    text: (l) => fmtTime(l.start), sort: (l) => num(l.start) },
  { key: 'end', title: 'End s', width: 66, align: 'right', edit: 'time',
    csv: () => [{ title: 'End (s)', value: (l) => round(l.end, 6) }],
    text: (l) => fmtTime(l.end), sort: (l) => num(l.end) },
  { key: 'dur', title: 'Dur s', width: 58, align: 'right', edit: 'dur',
    csv: () => [{ title: 'Duration (s)', value: (l) => round(num(l.end) - num(l.start), 6) }],
    text: (l) => fmtTime(num(l.end) - num(l.start)), sort: (l) => num(l.end) - num(l.start) },
  { key: 'freqMin', title: 'f min kHz', width: 70, align: 'right', edit: 'freq',
    csv: () => [{ title: 'Low freq (Hz)', value: (l) => round(l.freqMin, 1) }],
    text: (l) => fmtKHz(l.freqMin), sort: (l) => num(l.freqMin) },
  { key: 'freqMax', title: 'f max kHz', width: 70, align: 'right', edit: 'freq',
    csv: () => [{ title: 'High freq (Hz)', value: (l) => round(l.freqMax, 1) }],
    text: (l) => fmtKHz(l.freqMax), sort: (l) => num(l.freqMax) },
  tagCol('soundType', 'Type', 96),
  tagCol('sex', 'Sex', 64),
  tagCol('lifeStage', 'Age', 72),
  { key: 'conf', title: 'Conf', width: 48, align: 'right', edit: null, tip: 'BirdNET confidence',
    csv: () => [{ title: 'Confidence', value: (l) => l.confidence }],
    text: (l) => (l.confidence != null && l.confidence !== '' ? `${Math.round(Number(l.confidence) * 100)}%` : ''),
    sort: (l) => num(l.confidence) },
  { key: 'author', title: 'Annotator', width: 110, edit: 'text', tip: 'Annotator of this label (empty = layer / profile)',
    text: (l) => String(l.author || ''), sort: (l) => String(l.author || '').toLowerCase(),
    csv: () => [{ title: 'Annotator', value: (l) => l.author || '' }] },
  ...ANNOTA_FIELDS.map(annotaCol),
  { key: 'snr', title: 'SNR dB', width: 58, align: 'right', edit: null, hiddenByDefault: true,
    tip: 'Signal-to-noise ratio of the box (computed)',
    text: (l) => (Number.isFinite(num(l.snr)) ? num(l.snr).toFixed(1) : ''), sort: (l) => num(l.snr),
    csv: () => [{ title: 'SNR (dB)', value: (l) => round(l.snr, 1) }] },
  { key: 'identified', title: 'Identified', width: 84, edit: null, hiddenByDefault: true,
    tip: 'Date identified (last change of the label)',
    text: (l) => isoDay(l.updatedAt || l.createdAt), sort: (l) => isoDay(l.updatedAt || l.createdAt),
    csv: () => [{ title: 'Date identified', value: (l) => isoDay(l.updatedAt || l.createdAt) }] },
  { key: 'layer', title: 'Set / layer', width: 90, edit: null,
    text: (l, g) => g.opts.layerName?.(l) || '', sort: (l, g) => (g.opts.layerName?.(l) || '').toLowerCase() },
];

function withTag(l: Lbl, key: string, v: string) {
  const tags = { ...(l.tags || {}) };
  if (v) tags[key] = v; else delete tags[key];
  return tags;
}

function loadPrefs(): any {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch { return {}; }
}
function savePrefs(p: any) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(p)); } catch { /* storage blocked */ }
}

export class LabelGrid {
  opts: LabelGridOptions;
  private labels: Lbl[] = [];
  private rows: Lbl[] = [];
  private byId = new Map<string, Lbl>();
  private prefs: { sortKey: string; sortDir: 1 | -1; sources: SourceKey[]; inView: boolean; follow: boolean; vis: Record<string, boolean>; widths: Record<string, number> };
  private query = '';
  private viewRange: { start: number; end: number } | null = null;

  private selectedId: string | null = null;
  private multi = new Set<string>();
  private anchorId: string | null = null;
  private hoverId: string | null = null;
  private playingId: string | null = null;
  private cursor: { id: string; col: number } | null = null;
  private editing: { id: string; col: number; el: HTMLElement; cleanup: () => void } | null = null;
  private speciesSearchFactory: ((anchor: HTMLElement, cb: (r: any) => void) => any) | null = null;

  private root: HTMLElement;
  private scroller: HTMLElement;
  private head: HTMLElement;
  private body: HTMLElement;
  private empty: HTMLElement;
  private toolsEl: HTMLElement | null = null;
  private counter: HTMLElement | null = null;
  private srcChips = new Map<SourceKey, HTMLButtonElement>();
  private inViewBtn: HTMLButtonElement | null = null;
  private followBtn: HTMLButtonElement | null = null;
  private renderQueued = false;
  private fullRepaint = false;
  private lastDown: { id: string; col: number; t: number } | null = null;
  private viewPoll = 0;

  constructor(opts: LabelGridOptions) {
    this.opts = opts;
    const p = loadPrefs();
    this.prefs = {
      sortKey: COLUMNS.some((c) => c.key === p.sortKey) ? p.sortKey : 'start',
      sortDir: p.sortDir === -1 ? -1 : 1,
      sources: Array.isArray(p.sources) ? p.sources : SOURCE_DEFS.map((s) => s.key),
      inView: !!p.inView,
      follow: p.follow !== false,
      vis: p.vis && typeof p.vis === 'object' ? p.vis : {},
      widths: p.widths && typeof p.widths === 'object' ? p.widths : {},
    };

    this.root = document.createElement('div');
    this.root.className = 'lgrid';
    this.root.tabIndex = 0;
    this.root.dataset.awOwnKeys = '';   // player hotkeys (Delete, arrows, …) stay out while the table has focus

    this.scroller = document.createElement('div');
    this.scroller.className = 'lgrid-scroll';
    this.head = document.createElement('div');
    this.head.className = 'lgrid-head lgrid-row';
    this.body = document.createElement('div');
    this.body.className = 'lgrid-body';
    this.empty = document.createElement('div');
    this.empty.className = 'lgrid-empty';
    this.scroller.append(this.head, this.body);
    this.root.append(this.scroller, this.empty);
    opts.host.appendChild(this.root);

    this.applyColumns();
    if (opts.tools) this.buildTools(opts.tools);

    this.scroller.addEventListener('scroll', () => this.queueRender(true));
    new ResizeObserver(() => this.queueRender(true)).observe(this.scroller);
    this.body.addEventListener('mousedown', (e) => this.onBodyMouseDown(e));
    this.body.addEventListener('mouseover', (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>('.lgrid-row')?.dataset.id || null;
      if (id !== this.hoverId) { this.hoverId = id; this.opts.onHover?.(id); this.queueRender(); }
    });
    this.body.addEventListener('mouseleave', () => {
      if (this.hoverId) { this.hoverId = null; this.opts.onHover?.(null); this.queueRender(); }
    });
    this.root.addEventListener('keydown', (e) => this.onKey(e));
    this.root.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('.lgrid-head')) { e.preventDefault(); this.showColumnMenu(e.clientX, e.clientY); }
    });
    this.setInView(this.prefs.inView);
  }

  // ── Public API ───────────────────────────────────────────────────────

  setSpeciesSearchFactory(f: LabelGrid['speciesSearchFactory']) { this.speciesSearchFactory = f; }

  render(labels: Lbl[]) {
    this.labels = labels || [];
    this.byId = new Map(this.labels.map((l) => [l.id, l]));
    for (const id of [...this.multi]) if (!this.byId.has(id)) this.multi.delete(id);
    if (this.selectedId && !this.byId.has(this.selectedId)) this.selectedId = null;
    if (this.editing && !this.byId.has(this.editing.id)) this.cancelEdit();
    this.recompute();
  }

  /** Update one row in place (cheap path for edits that keep sort/filter results). */
  updateLabel(lbl: Lbl) {
    if (!lbl?.id || !this.byId.has(lbl.id)) return;
    const i = this.labels.findIndex((l) => l.id === lbl.id);
    if (i >= 0) this.labels[i] = lbl;
    this.byId.set(lbl.id, lbl);
    this.recompute();
  }

  highlightRow(id: string | null, scroll = true) {
    this.selectedId = id;
    if (id) {
      const col = this.cursor?.id === id ? this.cursor.col : (this.cursor?.col ?? 1);
      this.cursor = { id, col };
      if (scroll) this.scrollToId(id);
    }
    this.queueRender();
  }

  setMultiSelected(ids: string[]) {
    this.multi = new Set(ids);
    this.queueRender();
  }

  setHover(id: string | null) {
    if (this.hoverId === id) return;
    this.hoverId = id;
    this.queueRender();
  }

  /** Playhead position: marks the row under it and, with Follow on, keeps it in view. */
  setPlayhead(t: number) {
    let hit: string | null = null;
    for (const l of this.rows) {
      if (num(l.start) <= t && t <= num(l.end)) { hit = l.id; break; }
    }
    if (hit === this.playingId) return;
    this.playingId = hit;
    if (hit && this.prefs.follow && !this.editing) this.scrollToId(hit);
    this.queueRender();
  }

  focus() { this.root.focus({ preventScroll: true }); }

  get visibleCount() { return this.rows.length; }

  destroy() {
    clearInterval(this.viewPoll);
    this.cancelEdit();
    this.root.remove();
    this.toolsEl?.remove();
  }

  // ── Toolbar (tab strip, right side) ──────────────────────────────────

  private buildTools(slot: HTMLElement) {
    const t = document.createElement('div');
    t.className = 'lgrid-tools';
    const chips = document.createElement('div');
    chips.className = 'lgrid-chips';
    for (const s of SOURCE_DEFS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `lgrid-chip lgrid-src-${s.key}`;
      b.textContent = s.badge;
      b.title = `${s.title} — click to show/hide, double click to show only these`;
      b.addEventListener('click', () => this.toggleSource(s.key));
      b.addEventListener('dblclick', () => this.soloSource(s.key));
      chips.appendChild(b);
      this.srcChips.set(s.key, b);
    }
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'lgrid-search';
    search.placeholder = 'Filter…';
    search.title = 'Filter by species, tag or layer';
    search.addEventListener('input', () => { this.query = search.value.trim().toLowerCase(); this.recompute(); });
    search.addEventListener('keydown', (e) => { if (e.key === 'Escape') { search.value = ''; this.query = ''; this.recompute(); this.focus(); } });

    this.inViewBtn = this.toggleBtn('In view', 'Only labels in the visible part of the spectrogram', () => this.setInView(!this.prefs.inView));
    this.followBtn = this.toggleBtn('Follow', 'Scroll the table with the playhead', () => {
      this.prefs.follow = !this.prefs.follow;
      savePrefs(this.prefs);
      this.syncTools();
    });
    this.counter = document.createElement('span');
    this.counter.className = 'lgrid-count';

    const colsBtn = this.toggleBtn('Columns', 'Show / hide columns (also: right click on the header)', () => {
      const r = colsBtn.getBoundingClientRect();
      this.showColumnMenu(r.left, r.bottom + 2);
    });
    const exportBtn = this.toggleBtn('Export', 'Export the rows shown in the table', () => {
      const r = exportBtn.getBoundingClientRect();
      this.showExportMenu(r.left, r.bottom + 2);
    });
    if (!this.opts.onExport) exportBtn.hidden = true;
    t.append(chips, search, this.inViewBtn, this.counter, this.followBtn, colsBtn, exportBtn);
    slot.appendChild(t);
    this.toolsEl = t;
    this.syncTools();
  }

  private showExportMenu(x: number, y: number) {
    const sel = this.rows.filter((l) => this.multi.has(l.id));
    const scopes: { label: string; rows: Lbl[] }[] = [
      { label: this.rows.length === this.labels.length ? `all ${this.rows.length}` : `${this.rows.length} shown`, rows: this.rows },
    ];
    if (sel.length > 1) scopes.push({ label: `${sel.length} selected`, rows: sel });
    const items: any[] = [];
    scopes.forEach((sc, si) => {
      if (si > 0) items.push({ separator: true });
      for (const f of LABEL_EXPORT_FORMATS) {
        items.push({
          label: `${f.label} — ${sc.label}`,
          disabled: sc.rows.length === 0,
          action: () => this.opts.onExport?.(f.id, sc.rows, this.exportColumns()),
        });
      }
    });
    showContextMenu({ x, y, items });
  }

  private toggleBtn(text: string, title: string, onClick: () => void) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lgrid-toggle';
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  private syncTools() {
    const present = new Set(this.labels.map(sourceOf));
    for (const [k, b] of this.srcChips) {
      b.classList.toggle('on', this.prefs.sources.includes(k));
      b.hidden = !present.has(k);
    }
    this.inViewBtn?.classList.toggle('on', this.prefs.inView);
    this.followBtn?.classList.toggle('on', this.prefs.follow);
    if (this.counter) {
      this.counter.textContent = this.rows.length === this.labels.length
        ? `${this.labels.length}`
        : `${this.rows.length} / ${this.labels.length}`;
      this.counter.title = `${this.rows.length} of ${this.labels.length} labels shown`;
    }
  }

  private toggleSource(k: SourceKey) {
    const s = new Set(this.prefs.sources);
    if (s.has(k)) s.delete(k); else s.add(k);
    this.prefs.sources = [...s];
    savePrefs(this.prefs);
    this.recompute();
  }

  private soloSource(k: SourceKey) {
    const all = SOURCE_DEFS.map((s) => s.key);
    const only = this.prefs.sources.length === 1 && this.prefs.sources[0] === k;
    this.prefs.sources = only ? all : [k];
    savePrefs(this.prefs);
    this.recompute();
  }

  private setInView(on: boolean) {
    this.prefs.inView = on;
    savePrefs(this.prefs);
    clearInterval(this.viewPoll);
    this.viewRange = on ? (this.opts.getViewRange?.() ?? null) : null;
    if (on) {
      this.viewPoll = window.setInterval(() => {
        if (!this.root.isConnected || this.root.offsetParent === null) return;
        const r = this.opts.getViewRange?.() ?? null;
        const p = this.viewRange;
        if (!r && !p) return;
        if (r && p && Math.abs(r.start - p.start) < 1e-3 && Math.abs(r.end - p.end) < 1e-3) return;
        this.viewRange = r;
        this.recompute();
      }, 200);
    }
    this.recompute();
  }

  // ── Columns: visibility + widths ────────────────────────────────────

  /** Indices (into COLUMNS) of the visible columns. */
  private visCols: number[] = [];

  private colWidth(c: Column) { return Math.max(30, Math.round(this.prefs.widths[c.key] || c.width)); }

  private applyColumns() {
    this.visCols = COLUMNS.map((_, i) => i).filter((i) => this.isColVisible(COLUMNS[i]));
    this.syncColWidths();
    this.buildHead();
    this.syncHead();
    this.queueRender(true);
  }

  /** Source + species stay visible while the table scrolls sideways. */
  private pinCell(el: HTMLElement, ci: number) {
    if (ci > 1) return;
    el.classList.add('pin');
    if (ci === 1) el.classList.add('pin-last');
    el.style.left = ci === 0 ? '0' : 'var(--lgrid-pin1)';
  }

  private syncColWidths() {
    this.root.style.setProperty('--lgrid-pin1', `${this.colWidth(COLUMNS[0])}px`);
    const cols = this.visCols.map((i) => `${this.colWidth(COLUMNS[i])}px`).join(' ') + ' minmax(0,1fr)';
    this.root.style.setProperty('--lgrid-cols', cols);
  }

  private isColVisible(c: Column) {
    if (c.fixed) return true;
    const v = this.prefs.vis[c.key];
    return v === undefined ? !c.hiddenByDefault : v;
  }

  private toggleColumn(key: string) {
    const c = COLUMNS.find((x) => x.key === key);
    if (!c) return;
    this.prefs.vis[key] = !this.isColVisible(c);
    savePrefs(this.prefs);
    this.applyColumns();
    if (this.cursor && !this.visCols.includes(this.cursor.col)) this.cursor.col = this.visCols[1];
  }

  private showColumnMenu(x: number, y: number) {
    const check = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,8.5 6.5,12 13,4.5"/></svg>';
    showContextMenu({
      x, y,
      items: [
        ...COLUMNS.filter((c) => !c.fixed).map((c) => ({
          label: c.tip ? `${c.title} (${c.tip})` : c.title,
          icon: this.isColVisible(c) ? check : '',
          action: () => this.toggleColumn(c.key),
        })),
        { separator: true },
        { label: 'Reset columns', action: () => { this.prefs.vis = {}; this.prefs.widths = {}; savePrefs(this.prefs); this.applyColumns(); } },
      ],
    });
  }

  private startColResize(e: PointerEvent, c: Column, handle: HTMLElement) {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = this.colWidth(c);
    handle.setPointerCapture(e.pointerId);
    this.root.classList.add('col-resizing');
    const move = (ev: PointerEvent) => {
      this.prefs.widths[c.key] = Math.max(30, Math.min(600, w0 + ev.clientX - x0));
      this.syncColWidths();
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      this.root.classList.remove('col-resizing');
      savePrefs(this.prefs);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }

  /** Visible columns as raw export columns (CSV). */
  exportColumns(): LabelExportColumn[] {
    return this.visCols.flatMap((i) => {
      const c = COLUMNS[i];
      return c.csv ? c.csv(this) : [{ title: c.title, value: (l: Lbl) => c.text(l, this) }];
    });
  }

  // ── Header / sorting ────────────────────────────────────────────────

  private buildHead() {
    this.head.innerHTML = '';
    this.visCols.forEach((ci) => {
      const c = COLUMNS[ci];
      const h = document.createElement('div');
      h.className = `lgrid-cell lgrid-h${c.align ? ' r' : ''}`;
      h.dataset.key = c.key;
      this.pinCell(h, ci);
      h.title = c.tip ? `${c.tip} — click to sort` : 'Click to sort';
      h.textContent = c.title;
      const grip = document.createElement('span');
      grip.className = 'lgrid-col-grip';
      grip.title = 'Drag to resize - double click: default width';
      grip.addEventListener('pointerdown', (e) => this.startColResize(e, c, grip));
      grip.addEventListener('click', (e) => e.stopPropagation());
      grip.addEventListener('dblclick', (e) => { e.stopPropagation(); delete this.prefs.widths[c.key]; savePrefs(this.prefs); this.syncColWidths(); });
      h.appendChild(grip);
      h.addEventListener('click', () => {
        if (this.prefs.sortKey === c.key) this.prefs.sortDir = this.prefs.sortDir === 1 ? -1 : 1;
        else { this.prefs.sortKey = c.key; this.prefs.sortDir = 1; }
        savePrefs(this.prefs);
        this.recompute();
      });
      this.head.appendChild(h);
    });
    this.head.appendChild(Object.assign(document.createElement('div'), { className: 'lgrid-cell lgrid-h' }));
  }

  private syncHead() {
    for (const h of this.head.querySelectorAll<HTMLElement>('.lgrid-h[data-key]')) {
      const on = h.dataset.key === this.prefs.sortKey;
      h.classList.toggle('sorted', on);
      h.dataset.dir = on ? (this.prefs.sortDir === 1 ? '▲' : '▼') : '';
    }
  }

  // ── Filtering + sorting ─────────────────────────────────────────────

  private recompute() {
    const src = new Set(this.prefs.sources);
    const q = this.query;
    const vr = this.prefs.inView ? this.viewRange : null;
    const col = COLUMNS.find((c) => c.key === this.prefs.sortKey) || COLUMNS[2];
    const dir = this.prefs.sortDir;
    const rows = this.labels.filter((l) => {
      if (!src.has(sourceOf(l))) return false;
      if (vr && (num(l.end) < vr.start || num(l.start) > vr.end)) return false;
      if (q) {
        const n = this.opts.resolveName(l);
        const hay = [n.display, n.scientific, l.label, l.author || '', ...Object.values(l.tags || {}), this.opts.layerName?.(l) || '']
          .join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const keyed = rows.map((l) => ({ l, k: col.sort(l, this), s: num(l.start) }));
    keyed.sort((a, b) => {
      const ak = a.k, bk = b.k;
      const an = typeof ak === 'number' && Number.isNaN(ak), bn = typeof bk === 'number' && Number.isNaN(bk);
      if (an !== bn) return an ? 1 : -1;               // empty values last, in both directions
      let c = 0;
      if (!an) c = typeof ak === 'number' && typeof bk === 'number' ? ak - bk : String(ak).localeCompare(String(bk));
      return c !== 0 ? c * dir : a.s - b.s;
    });
    this.rows = keyed.map((x) => x.l);
    this.syncHead();
    this.syncTools();
    this.empty.textContent = this.labels.length === 0
      ? 'No labels yet — draw a box in the spectrogram or run BirdNET.'
      : 'No label matches the filter.';
    this.empty.hidden = this.rows.length > 0;
    this.queueRender(true);
  }

  // ── Virtualised body ────────────────────────────────────────────────

  /** full = rebuild visible rows (data/scroll changed); otherwise only refresh highlight classes. */
  private queueRender(full = false) {
    if (full) this.fullRepaint = true;
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      const f = this.fullRepaint;
      this.fullRepaint = false;
      if (f) this.paint(); else this.decorateAll();
    });
  }

  private decorateAll() {
    for (const r of this.body.querySelectorAll<HTMLElement>('.lgrid-row')) {
      const l = this.byId.get(r.dataset.id || '');
      if (l) this.decorateRow(r, l);
    }
  }

  private paint() {
    const total = this.rows.length;
    this.body.style.height = `${total * ROW_H}px`;
    const headH = this.head.offsetHeight || ROW_H;
    const top = Math.max(0, this.scroller.scrollTop - headH);
    const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const last = Math.min(total, Math.ceil((top + this.scroller.clientHeight) / ROW_H) + OVERSCAN);

    // While an editor is open, never move DOM nodes (detaching the focused input would blur
    // and commit it) — only refresh the highlight classes; the full repaint follows on close.
    if (this.editing) { this.fullRepaint = true; this.decorateAll(); return; }
    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) frag.appendChild(this.buildRow(this.rows[i], i));
    this.body.replaceChildren(frag);
  }

  private buildRow(l: Lbl, i: number) {
    const r = document.createElement('div');
    r.className = 'lgrid-row';
    r.dataset.id = l.id;
    r.style.top = `${i * ROW_H}px`;
    const locked = this.opts.isLocked(l);
    this.visCols.forEach((ci) => {
      const c = COLUMNS[ci];
      const cell = document.createElement('div');
      cell.className = `lgrid-cell${c.align ? ' r' : ''}${c.edit && !locked ? ' editable' : ''}`;
      cell.dataset.col = String(ci);
      this.pinCell(cell, ci);
      if (c.key === 'src') {
        const k = sourceOf(l);
        const dot = document.createElement('span');
        dot.className = 'lgrid-dot';
        dot.style.background = l.color || 'var(--color-text-secondary)';
        const b = document.createElement('span');
        b.className = `lgrid-badge lgrid-src-${k}`;
        b.textContent = c.text(l, this);
        cell.append(dot, b);
        cell.title = SOURCE_DEFS.find((s) => s.key === k)!.title + (locked ? ' (read-only)' : '');
      } else if (c.key === 'species') {
        const n = this.opts.resolveName(l);
        cell.textContent = n.display;
        cell.title = n.scientific ? `${n.display} — ${n.scientific}` : n.display;
      } else {
        cell.textContent = c.text(l, this);
        if (c.edit === 'yn') {
          const yn = toYN(l.tags?.[c.tagKey!]);
          const on = yn === 'y';
          cell.textContent = '';
          cell.classList.add('yn');
          const box = document.createElement('span');
          box.className = `lgrid-check${on ? ' on' : ''}${yn === '' ? ' unset' : ''}`;
          box.setAttribute('role', 'checkbox');
          box.setAttribute('aria-checked', yn === '' ? 'mixed' : String(on));
          cell.appendChild(box);
          cell.title = `${c.tip || ''} — ${yn === 'y' ? 'yes' : yn === 'n' ? 'no' : 'not specified'} · click / Space toggles · Backspace resets`;
        } else if (c.tagKey === 'remarks' && cell.textContent) {
          cell.title = cell.textContent;
        }
      }
      r.appendChild(cell);
    });
    r.appendChild(Object.assign(document.createElement('div'), { className: 'lgrid-cell' }));
    this.decorateRow(r, l);
    return r;
  }

  private decorateRow(r: HTMLElement, l: Lbl) {
    const id = l.id;
    r.classList.toggle('selected', id === this.selectedId);
    r.classList.toggle('multi', this.multi.has(id));
    r.classList.toggle('hover', id === this.hoverId);
    r.classList.toggle('playing', id === this.playingId);
    r.classList.toggle('foreign', sourceOf(l) !== 'own');
    r.classList.toggle('locked', this.opts.isLocked(l));
    for (const c of r.querySelectorAll<HTMLElement>('.lgrid-cell[data-col]')) {
      c.classList.toggle('cursor', !!this.cursor && this.cursor.id === id && String(this.cursor.col) === c.dataset.col);
    }
  }

  private scrollToId(id: string) {
    const i = this.rows.findIndex((l) => l.id === id);
    if (i < 0) return;
    const headH = this.head.offsetHeight || ROW_H;
    const y = i * ROW_H;
    const viewTop = this.scroller.scrollTop;
    const viewH = this.scroller.clientHeight - headH;
    if (y < viewTop) this.scroller.scrollTop = y;
    else if (y + ROW_H > viewTop + viewH) this.scroller.scrollTop = y + ROW_H - viewH;
  }

  // ── Selection ───────────────────────────────────────────────────────

  private hitCell(target: EventTarget | null) {
    const cell = (target as HTMLElement)?.closest?.<HTMLElement>('.lgrid-cell[data-col]');
    const row = cell?.closest<HTMLElement>('.lgrid-row');
    if (!cell || !row?.dataset.id) return null;
    return { id: row.dataset.id, col: Number(cell.dataset.col) };
  }

  private onBodyMouseDown(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('.lgrid-editor')) return;
    const hit = this.hitCell(e.target);
    if (!hit) return;
    if (this.editing) this.commitEdit();
    e.preventDefault();
    if ((e.target as HTMLElement).closest('.lgrid-check') && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      this.cursor = { id: hit.id, col: hit.col };
      this.focus();
      this.startEdit(hit.id, hit.col);
      return;
    }
    // Own double-click detection: rows may be rebuilt between the two clicks.
    const now = performance.now();
    const ld = this.lastDown;
    this.lastDown = { ...hit, t: now };
    if (ld && ld.id === hit.id && ld.col === hit.col && now - ld.t < 450 && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      this.lastDown = null;
      this.startEdit(hit.id, hit.col);
      return;
    }
    this.focus();
    this.cursor = { id: hit.id, col: hit.col };
    if (e.shiftKey && this.anchorId) {
      const a = this.rows.findIndex((l) => l.id === this.anchorId);
      const b = this.rows.findIndex((l) => l.id === hit.id);
      if (a >= 0 && b >= 0) {
        this.multi = new Set(this.rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((l) => l.id));
        this.opts.onMultiSelectionChange?.([...this.multi]);
      }
    } else if (e.ctrlKey || e.metaKey) {
      if (this.multi.size === 0 && this.selectedId && this.selectedId !== hit.id) this.multi.add(this.selectedId);
      if (this.multi.has(hit.id)) this.multi.delete(hit.id); else this.multi.add(hit.id);
      this.anchorId = hit.id;
      this.opts.onMultiSelectionChange?.([...this.multi]);
    } else {
      this.anchorId = hit.id;
      if (this.multi.size) { this.multi.clear(); this.opts.onMultiSelectionChange?.([]); }
      this.selectedId = hit.id;
      this.opts.onFocus(hit.id);
    }
    this.queueRender();
  }

  private moveCursor(dRow: number, dCol: number, extend = false) {
    if (!this.rows.length) return;
    let i = this.cursor ? this.rows.findIndex((l) => l.id === this.cursor!.id) : -1;
    let col = this.cursor?.col ?? 1;
    if (i < 0) i = 0;
    else i = Math.max(0, Math.min(this.rows.length - 1, i + dRow));
    let vi = this.visCols.indexOf(col);
    if (vi < 0) vi = 1;
    vi = Math.max(1, Math.min(this.visCols.length - 1, vi + dCol));
    col = this.visCols[vi];
    const id = this.rows[i].id;
    this.cursor = { id, col };
    if (dRow !== 0) {
      if (extend) {
        if (!this.anchorId) this.anchorId = this.selectedId || id;
        const a = this.rows.findIndex((l) => l.id === this.anchorId);
        this.multi = new Set(this.rows.slice(Math.min(a, i), Math.max(a, i) + 1).map((l) => l.id));
        this.opts.onMultiSelectionChange?.([...this.multi]);
      } else {
        this.anchorId = id;
        if (this.multi.size) { this.multi.clear(); this.opts.onMultiSelectionChange?.([]); }
        this.selectedId = id;
        this.opts.onFocus(id);
      }
    }
    this.scrollToId(id);
    this.queueRender();
  }

  private onKey(e: KeyboardEvent) {
    if (this.editing) return;                      // editors handle their own keys
    const k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); this.moveCursor(k === 'ArrowDown' ? 1 : -1, 0, e.shiftKey); return; }
    if (k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); this.moveCursor(0, k === 'ArrowRight' ? 1 : -1); return; }
    if (k === 'Tab') { e.preventDefault(); this.moveCursor(0, e.shiftKey ? -1 : 1); return; }
    if (k === 'PageDown' || k === 'PageUp') {
      e.preventDefault();
      const n = Math.max(1, Math.floor(this.scroller.clientHeight / ROW_H) - 1);
      this.moveCursor(k === 'PageDown' ? n : -n, 0);
      return;
    }
    if (k === 'Home' && e.ctrlKey) { e.preventDefault(); this.moveCursor(-this.rows.length, 0); return; }
    if (k === 'End' && e.ctrlKey) { e.preventDefault(); this.moveCursor(this.rows.length, 0); return; }
    if (k === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.multi = new Set(this.rows.map((l) => l.id));
      this.opts.onMultiSelectionChange?.([...this.multi]);
      this.queueRender();
      return;
    }
    if (k === 'Escape' && this.multi.size) {
      e.preventDefault();
      this.multi.clear();
      this.opts.onMultiSelectionChange?.([]);
      this.queueRender();
      return;
    }
    if (!this.cursor) return;
    if (k === 'Enter' || k === 'F2') { e.preventDefault(); e.stopPropagation(); this.startEdit(this.cursor.id, this.cursor.col); return; }
    // Delete / Backspace on an optional field resets it to "not specified";
    // Delete elsewhere (species, times, …) removes the label(s).
    if ((k === 'Delete' || k === 'Backspace') && this.isClearable(this.cursor.col)) {
      e.preventDefault();
      e.stopPropagation();
      this.clearCell(this.cursor.id, this.cursor.col);
      return;
    }
    if (k === 'Backspace') { e.preventDefault(); return; }
    if (k === 'Delete') {
      e.preventDefault();
      e.stopPropagation();
      const ids = this.targetIds(this.cursor.id).filter((id) => !this.opts.isLocked(this.byId.get(id)));
      if (ids.length) this.opts.onDelete?.(ids);
      else this.opts.onNotice?.('Read-only labels cannot be deleted — adopt them first.');
      return;
    }
    // Typing a printable character starts editing with that character.
    if (k === ' ' && COLUMNS[this.cursor.col]?.edit === 'yn') {
      e.preventDefault();
      e.stopPropagation();
      this.startEdit(this.cursor.id, this.cursor.col);
      return;
    }
    if (k === ' ') { e.preventDefault(); this.opts.onTogglePlay?.(); return; }
    if (k.length === 1 && k !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      this.startEdit(this.cursor.id, this.cursor.col, k);
    }
  }

  /** Backspace: reset optional fields (tags, Annota fields, annotator, frequency) to empty. */
  private isClearable(col: number) {
    return ['tag', 'text', 'yn', 'date', 'freq'].includes(String(COLUMNS[col]?.edit));
  }

  private clearCell(id: string, col: number) {
    const c = COLUMNS[col];
    const l = this.byId.get(id);
    if (!c || !l || !this.isClearable(col)) return;
    if (this.opts.isLocked(l)) { this.opts.onNotice?.('This label is read-only — adopt it to edit.'); return; }
    this.applyValue(id, c, '');
    this.queueRender(true);
  }

  /** Ids an edit applies to: the whole multi-selection if the edited row is part of it. */
  private targetIds(id: string) {
    return this.multi.size > 1 && this.multi.has(id) ? [...this.multi] : [id];
  }

  // ── Inline editing ──────────────────────────────────────────────────

  private cellEl(id: string, col: number) {
    return this.body.querySelector<HTMLElement>(`.lgrid-row[data-id="${CSS.escape(id)}"] .lgrid-cell[data-col="${col}"]`);
  }

  private startEdit(id: string, col: number, initial?: string) {
    const c = COLUMNS[col];
    const l = this.byId.get(id);
    if (!c || !l) return;
    if (!c.edit) return;
    if (this.opts.isLocked(l)) { this.opts.onNotice?.('This label is read-only — adopt it to edit.'); return; }
    if (this.editing) this.commitEdit();
    this.cursor = { id, col };
    this.scrollToId(id);
    this.paint();                                  // make sure the row exists in the DOM
    const cell = this.cellEl(id, col);
    if (!cell) return;
    cell.classList.add('editing');

    if (c.edit === 'species' && this.speciesSearchFactory) {
      this.editSpecies(id, col, cell, l, initial);
      return;
    }
    if (c.edit === 'tag') {
      this.editTag(id, col, cell, l, c, initial);
      return;
    }
    if (c.edit === 'yn') {
      cell.classList.remove('editing');
      const k = (initial || '').toLowerCase();
      const v = k === 'y' || k === 'j' || k === 'x' ? 'y' : k === 'n' ? 'n' : cycleYN(l.tags?.[c.tagKey!]);
      this.applyValue(id, c, v);
      this.queueRender(true);
      return;
    }
    this.editText(id, col, cell, l, c, initial);
  }

  private editText(id: string, col: number, cell: HTMLElement, l: Lbl, c: Column, initial?: string) {
    const input = document.createElement('input');
    input.className = 'lgrid-editor';
    input.spellcheck = false;
    input.autocomplete = 'off';
    const isNum = c.edit === 'time' || c.edit === 'dur' || c.edit === 'freq';
    input.value = initial ?? (c.tagKey ? String(l.tags?.[c.tagKey] ?? '') : c.text(l, this));
    if (isNum) input.inputMode = 'decimal';
    if (c.edit === 'date') {
      input.placeholder = 'YYYY-MM-DD';
    } else if (c.key === 'species') {
      input.placeholder = 'Label';
    }

    const original = input.value;
    let done = false;
    const finish = (commit: boolean, move?: { dRow: number; dCol: number }) => {
      if (done) return;
      done = true;
      cleanup();
      if (commit && input.value !== original) this.applyValue(id, c, input.value);
      this.editing = null;
      this.focus();
      if (move) this.moveCursor(move.dRow, move.dCol);
      else this.queueRender(true);
    };
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true, { dRow: e.shiftKey ? -1 : 1, dCol: 0 }); }
      else if (e.key === 'Tab') { e.preventDefault(); finish(true, { dRow: 0, dCol: e.shiftKey ? -1 : 1 }); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      else if (isNum && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        const base = c.edit === 'freq' ? 0.1 : 0.01;
        const step = (e.key === 'ArrowUp' ? 1 : -1) * base * (e.shiftKey ? 10 : 1) * (e.altKey ? 0.1 : 1);
        const v = Number(String(input.value).replace(',', '.'));
        if (!Number.isFinite(v)) return;
        const digits = c.edit === 'freq' ? 2 : 3;
        input.value = (v + step).toFixed(digits);
        this.applyValue(id, c, input.value);       // live: the box follows each step
        input.select();
      }
    };
    const onBlur = () => finish(true);
    input.addEventListener('keydown', onKey);
    input.addEventListener('blur', onBlur);
    const cleanup = () => {
      input.removeEventListener('blur', onBlur);
      cell.classList.remove('editing');
      input.remove();
      const fresh = this.byId.get(id);
      if (fresh && cell.isConnected) cell.textContent = c.text(fresh, this);
    };
    cell.textContent = '';
    cell.appendChild(input);
    this.editing = { id, col, el: input, cleanup: () => finish(false) };
    input.focus();
    if (initial == null) input.select();
  }

  /** Tag cells use the app's editable select (search, custom values, add/rename/remove). */
  private editTag(id: string, col: number, cell: HTMLElement, l: Lbl, c: Column, initial?: string) {
    const key = c.key.slice(4);
    const store = this.opts.tagStore;
    const original = String(l.tags?.[key] ?? '');
    let done = false;
    let es: ReturnType<typeof createEditableSelect> | null = null;
    const finish = (val: string | undefined) => {
      if (done) return;
      done = true;
      this.editing = null;
      queueMicrotask(() => {
        try { es?.destroy(); } catch { /* ignore */ }
        cell.classList.remove('editing');
        if (val !== undefined && val !== original) this.applyValue(id, c, val);
        const fresh = this.byId.get(id);
        if (fresh && cell.isConnected) cell.textContent = c.text(fresh, this);
        this.focus();
        this.queueRender(true);
      });
    };
    es = createEditableSelect({
      value: original,
      items: store ? store.getMerged(key, tagPreset(key)) : tagPreset(key).map((v) => ({ value: v, custom: false })),
      placeholder: '–',
      className: 'lgrid-esel',
      onChange: (v) => finish(v),
      onClose: () => finish(undefined),
      onAdd: store ? (v) => store.add(key, v) : undefined,
      onRemove: store ? (v) => store.remove(key, v) : undefined,
      onRename: store ? (o, n) => store.rename(key, o, n) : undefined,
    });
    cell.textContent = '';
    cell.appendChild(es.el);
    this.editing = { id, col, el: es.el, cleanup: () => finish(undefined) };
    es.open(initial);
  }

  private editSpecies(id: string, col: number, cell: HTMLElement, l: Lbl, initial?: string) {
    let done = false;
    let widget: any = null;
    const finish = (sel: { name: string; scientificName?: string } | null, move = false) => {
      if (done) return;
      done = true;
      clearTimeout(blurTimer);
      try { widget?.destroy?.(); } catch { /* ignore */ }
      cell.classList.remove('editing');
      this.editing = null;
      if (sel?.name) {
        for (const tid of this.editableTargets(id)) {
          this.opts.onChange(tid, { label: sel.name, scientificName: sel.scientificName || '', commonName: '' });
        }
      }
      const fresh = this.byId.get(id);
      if (fresh && cell.isConnected) cell.textContent = this.opts.resolveName(fresh).display;
      this.focus();
      if (move) this.moveCursor(1, 0); else this.queueRender(true);
    };
    let blurTimer = 0;
    widget = this.speciesSearchFactory!(cell, (r: any) => finish({ name: r?.name, scientificName: r?.scientificName }, true));
    const input: HTMLInputElement = widget.input;
    input.value = initial ?? this.opts.resolveName(l).display;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); return; }
      if (e.key === 'Tab') {
        e.preventDefault(); e.stopPropagation();
        finish(null); this.moveCursor(0, e.shiftKey ? -1 : 1);
        return;
      }
      e.stopPropagation();
    }, true);
    // Clicking a suggestion blurs the input first — give the widget time to report the pick.
    input.addEventListener('blur', () => { blurTimer = window.setTimeout(() => finish(null), 250); });
    input.addEventListener('focus', () => clearTimeout(blurTimer));
    cell.textContent = '';
    widget.el.classList.add('lgrid-editor', 'lgrid-species-editor');
    cell.appendChild(widget.el);
    this.editing = { id, col, el: widget.el, cleanup: () => finish(null) };
    input.focus();
    if (initial == null) input.select();
    else input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  private editableTargets(id: string) {
    return this.targetIds(id).filter((tid) => {
      const l = this.byId.get(tid);
      return l && !this.opts.isLocked(l);
    });
  }

  /** Parse an edited cell value and report it for every editable target row. */
  private applyValue(id: string, c: Column, raw: string) {
    const v = String(raw).trim();
    const n = Number(v.replace(',', '.'));
    const dur = this.opts.getDuration?.() || Infinity;
    const fmax = this.opts.getMaxFreq?.() || Infinity;
    let refused = 0;
    for (const tid of this.editableTargets(id)) {
      const l = this.byId.get(tid);
      const start = num(l.start), end = num(l.end);
      let up: Record<string, any> | null = null;
      switch (c.edit) {
        case 'species':
          if (v) up = { label: v, scientificName: '', commonName: '' };
          break;
        case 'time':
          if (!Number.isFinite(n)) break;
          if (c.key === 'start' && n >= 0 && n < end) up = { start: n };
          else if (c.key === 'end' && n > start && n <= dur) up = { end: n };
          break;
        case 'dur':
          if (Number.isFinite(n) && n > 0 && start + n <= dur) up = { end: start + n };
          break;
        case 'freq': {
          if (v === '') { up = { [c.key]: null }; break; }
          if (!Number.isFinite(n)) break;
          const hz = Math.round(n * 1000);
          const lo = num(l.freqMin), hi = num(l.freqMax);
          if (c.key === 'freqMin' && hz >= 0 && (!Number.isFinite(hi) || hz < hi)) up = { freqMin: hz };
          else if (c.key === 'freqMax' && hz <= fmax && (!Number.isFinite(lo) || hz > lo)) up = { freqMax: hz };
          break;
        }
        case 'text':
          if (c.key === 'author') up = { author: v };
          else if (c.tagKey) up = { tags: withTag(l, c.tagKey, v) };
          break;
        case 'yn':
          up = { tags: withTag(l, c.tagKey!, v === '' ? '' : toYN(v)) };
          break;
        case 'date': {
          if (v === '') { up = { tags: withTag(l, c.tagKey!, '') }; break; }
          const m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/) || v.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
          if (!m) break;
          const [y, mo, d] = m[1].length === 4 ? [m[1], m[2], m[3]] : [m[3], m[2], m[1]];
          const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
          if (!Number.isNaN(new Date(iso).getTime())) up = { tags: withTag(l, c.tagKey!, iso) };
          break;
        }
        case 'tag': {
          const key = c.key.slice(4);
          const tags = { ...(l.tags || {}) };
          if (v) tags[key] = v; else delete tags[key];
          up = { tags };
          if (v && this.opts.tagStore && !tagPreset(key).includes(v)) {
            const known = this.opts.tagStore.getMerged?.(key, tagPreset(key)) || [];
            if (!known.some((it: any) => it.value === v)) this.opts.tagStore.add?.(key, v);
          }
          break;
        }
      }
      if (up) this.opts.onChange(tid, up);
      else refused++;
    }
    if (refused) {
      const why = c.edit === 'time' || c.edit === 'dur' ? 'start must stay before end and inside the recording'
        : c.edit === 'freq' ? 'f min must stay below f max and below the Nyquist frequency'
        : c.edit === 'date' ? 'use YYYY-MM-DD or DD.MM.YYYY' : 'invalid value';
      this.opts.onNotice?.(`${refused} value${refused > 1 ? 's' : ''} not applied: ${why}.`);
    }
  }

  private commitEdit() {
    const ed = this.editing;
    if (!ed) return;
    // Text editors commit on blur; species editors cancel unless a pick was made.
    (ed.el as HTMLElement).blur?.();
    if (this.editing === ed) ed.cleanup();
  }

  private cancelEdit() {
    const ed = this.editing;
    if (!ed) return;
    ed.cleanup();
    this.editing = null;
  }
}
