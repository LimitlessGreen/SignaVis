/**
 * Label list for the sidebar — a three-level tree.
 *
 *   1. Source block: "My labels" (own source) first, then BirdNET, then XC / imported sets.
 *      Own labels may sit on several layers: a layer bar (active layer, visibility) shows once
 *      there is more than the default layer.
 *      Header: badge (ME / BN / XC) · name · "n · k species" · eye; adopt + ⋯ menu on hover;
 *      info line with creator · license · link for imported sets.
 *   2. Species row: bird image · common / scientific name · count.
 *   3. Label row (one line): ▶ · start · duration · tags or BirdNET confidence · actions on hover.
 *
 * Imported (non-own) sources are drawn dimmed. A second view ("time") lists all labels flat by start time.
 * plans/labels-tab-plan.md
 *
 * Usage:
 *   const list = new LabelList({ container, emptyEl, resolveName, onSync, ... });
 *   list.render(labels);
 */

import { TAG_PRESETS } from './label-table.ts';
import { showContextMenu } from '../components/context-menu/context-menu.ts';
import { OWN_SOURCE_ID, DEFAULT_LAYER_ID } from '../../app/label-sources.ts';

const BIRD_IMG_BASE = './data/species_images/';
const BIRD_IMG_FALLBACK = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Crect width='40' height='40' fill='%23252525'/%3E%3Cpath d='M20 9c-4 0-7 3-8 6l-4-2c-1-1-2 0-1 1l3 5c-1 1-2 3-2 5 0 6 5 10 12 10s12-4 12-10c0-2-1-3-1-4l3-5c1-1-1-2-2-1l-4 3c-1-4-4-8-8-8z' fill='%23444'/%3E%3C/svg%3E`;

const PRESET_KEYS = new Set(TAG_PRESETS.map((p) => p.key));
// Tags that belong to the set header — never shown per label
const SET_TAG_KEYS = new Set(['setName', 'setLicense', 'setCreator']);
const HIDDEN_TAG_KEYS = new Set(['annotator', 'animalSeen', 'playbackUsed', 'remarks']);
const VIEW_KEY = 'signavis.labels.view.v1';

export interface LayerOptions {
  get: () => { layers: { id: string; name: string }[]; active: string; hidden: Set<string> };
  onSetActive: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string) => void;
  onRemove: (id: string) => void;
  onMove: (labelIds: string[], layerId: string) => void;
  onToggleHidden: (id: string) => void;
}

const ICON = {
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
  eye: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8s2-4 6-4 6 4 6 4-2 4-6 4-6-4-6-4z"/><circle cx="8" cy="8" r="2"/></svg>',
  eyeOff: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8s2-4 6-4 6 4 6 4"/><path d="M2 2l12 12"/><circle cx="8" cy="8" r="2"/></svg>',
  adopt: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 8.5 6.5 12 13 4.5"/></svg>',
  more: '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  ref: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  del: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  play: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5 3.5v9l7-4.5z"/></svg>',
  stop: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4.5" y="4.5" width="7" height="7" rx="1"/></svg>',
};

function fmtTime(sec: any) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}
function fmtDur(sec: any) {
  const s = Math.max(0, Number(sec) || 0);
  return s >= 10 ? `${s.toFixed(0)}s` : `${s.toFixed(1)}s`;
}
function fmtFreq(hz: any) {
  const n = Math.round(Number(hz));
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

/** Derive annotation set info from a label — supports both new (annotationSet field) and legacy (tags) format. */
function getAnnotationSet(lbl: any) {
  if (lbl.annotationSet) return lbl.annotationSet;
  if (lbl.tags?.setName || lbl.tags?.setLicense) {
    return { name: lbl.tags.setName || '', license: lbl.tags.setLicense || '', creator: lbl.tags.setCreator || '', uri: '', date: '' };
  }
  return null;
}

function originBadge(origin: string) {
  if (origin === 'xeno-canto') return 'XC';
  if (origin === 'BirdNET') return 'BN';
  if (origin === 'manual') return 'ME';
  return 'IM';
}

function el(tag: string, cls = '', text = ''): any {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}
function iconBtn(cls: string, icon: string, title: string, onClick: (e: MouseEvent) => void) {
  const b = el('button', `act-btn lt-icon-btn ${cls}`);
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = icon;
  b.addEventListener('click', (e: MouseEvent) => { e.stopPropagation(); onClick(e); });
  return b;
}

export class LabelList {
    _accordion: any;
    _badgeEl: any;
    _bulkToolbar: any;
    _canDeleteSet: any;
    /** Layer callbacks of the own source (see LayerOptions). */
    _layers: LayerOptions | null;
    _cardMap: any;
    _container: any;
    _emptyEl: any;
    _expandedGroups: any;
    _collapsedSets: any;
    _getSets: any;
    _labels: any;
    _onAssignSet: any;
    _onAssignSpecies: any;
    _onConvertSetToManual: any;
    _onCreateSet: any;
    _onDeleteSet: any;
    _onEdit: any;
    _onFocus: any;
    _onHover: any;
    _onOpenRefCalls: any;
    _onRenameSet: any;
    _onSeek: any;
    _onSync: any;
    _onToggleLockSet: any;
    _onAdoptSet: any;
    _onAdoptLabel: any;
    _onPlaySegment: any;
    _onToggleSetVisibility: any;
    _onToggleSpeciesVisibility: any;
    _hiddenSetIds: any;
    _hiddenSpeciesKeys: any;
    _resolveName: any;
    _taxonomy: any;
    _tagStore: any;
    _lockedIds: any;
    _multiSelectedIds: any;
    _onBulkEdit: any;
    _onMultiSelectionChange: any;
    _onRemove: any;
    _selectedId: any;
    _speciesSearchFactory: any;
    _view: 'source' | 'time';
    _filter: string;
    _playingId: string | null;
  /**
   * @param {object} opts
   * @param {HTMLElement}  opts.container
   * @param {HTMLElement}  opts.emptyEl
   * @param {HTMLElement}  [opts.badgeEl]
   * @param {(lbl: any) => {display: string, scientific: string}} opts.resolveName
   * @param {() => void}   opts.onSync
   * @param {(lbl: any) => void}  [opts.onSeek]
   * @param {(id: string) => void} [opts.onEdit]
   * @param {(ids: string[]) => void} [opts.onBulkEdit]
   * @param {(id: string, source: string) => void} [opts.onFocus]
   * @param {(id: string, on: boolean) => void}     [opts.onHover]
   * @param {(ids: string[]) => void} [opts.onMultiSelectionChange]
   * @param {() => Map<string,object>}  [opts.getSets]           Returns state.labelSets
   * @param {(partial: object) => void} [opts.onCreateSet]
   * @param {(id: string, name: string) => void} [opts.onRenameSet]
   * @param {(id: string) => void}      [opts.onDeleteSet]
   * @param {(labelId: string, setId: string|null) => void} [opts.onAssignSet]
   * @param {(setId: string) => void}   [opts.onConvertSetToManual]
   * @param {(setId: string) => void}   [opts.onAdoptSet]   copy an imported set's labels into the own set
   * @param {(labelId: string) => void} [opts.onAdoptLabel] copy one imported label into the own set
   * @param {(lbl: any) => void}        [opts.onPlaySegment] play start–end of a label (toggle)
   * @param {(setId: string) => boolean} [opts.canDeleteSet]
   */
  constructor(opts: any) {
    this._container = opts.container;
    this._emptyEl = opts.emptyEl;
    this._badgeEl = opts.badgeEl || null;
    this._resolveName = opts.resolveName;
    this._taxonomy = opts.taxonomy || null;
    this._onSync = opts.onSync;
    this._onSeek = opts.onSeek;
    this._onEdit = opts.onEdit;
    this._onBulkEdit = opts.onBulkEdit || null;
    this._onFocus = opts.onFocus;
    this._onHover = opts.onHover;
    this._onMultiSelectionChange = opts.onMultiSelectionChange || null;
    this._onRemove = null;
    this._tagStore = opts.tagStore || null;
    this._accordion = !!opts.accordion;
    this._getSets = opts.getSets || null;
    this._onCreateSet = opts.onCreateSet || null;
    this._onRenameSet = opts.onRenameSet || null;
    this._onDeleteSet = opts.onDeleteSet || null;
    this._onAssignSet = opts.onAssignSet || null;
    this._onAssignSpecies = opts.onAssignSpecies || null;
    this._onConvertSetToManual = opts.onConvertSetToManual || null;
    this._onToggleLockSet = opts.onToggleLockSet || null;
    this._onAdoptSet = opts.onAdoptSet || null;
    this._onAdoptLabel = opts.onAdoptLabel || null;
    this._onPlaySegment = opts.onPlaySegment || null;
    this._canDeleteSet = opts.canDeleteSet || null;
    this._layers = opts.layers || null;
    this._speciesSearchFactory = opts.speciesSearchFactory || null;
    this._onOpenRefCalls = opts.onOpenRefCalls || null;
    this._cardMap = new Map();
    this._selectedId = null;
    this._multiSelectedIds = new Set();
    this._labels = [];
    /** group keys (`${setKey}::${label}`) that are expanded */
    this._expandedGroups = new Set();
    /** set keys the user collapsed (sets are open by default) */
    this._collapsedSets = new Set();
    this._bulkToolbar = null;
    this._lockedIds = new Set();
    this._hiddenSetIds = new Set();
    this._hiddenSpeciesKeys = new Set();
    this._onToggleSetVisibility = opts.onToggleSetVisibility || null;
    this._onToggleSpeciesVisibility = opts.onToggleSpeciesVisibility || null;
    this._view = 'source';
    try { if (localStorage.getItem(VIEW_KEY) === 'time') this._view = 'time'; } catch { /* ignore */ }
    this._filter = '';
    this._playingId = null;
    this._container.addEventListener('keydown', (e: KeyboardEvent) => this._onKey(e));
  }

  /** ↑/↓ moves the selection through the visible rows, Enter/Space plays the selected segment. */
  _onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t.closest('input, select, textarea, .lt-src-head, button')) return;
    const rows = [...this._container.querySelectorAll('.lt-row')].filter((r: any) => r.offsetParent !== null) as any[];
    if (!rows.length) return;
    const cur = rows.findIndex((r) => r.dataset.labelId === this._selectedId);
    const pick = (i: number) => {
      const row = rows[Math.max(0, Math.min(rows.length - 1, i))];
      const lbl = this._labels.find((l: any) => String(l.id) === row.dataset.labelId);
      if (!lbl) return;
      this._activate(lbl);
      row.focus({ preventScroll: true });
    };
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); pick(cur + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); pick(cur < 0 ? 0 : cur - 1); }
    else if ((e.key === 'Enter' || e.key === ' ') && cur >= 0 && this._onPlaySegment) {
      e.preventDefault(); e.stopPropagation();
      const lbl = this._labels.find((l: any) => String(l.id) === rows[cur].dataset.labelId);
      if (lbl) this._onPlaySegment(lbl);
    }
  }

  setHiddenSets(ids: any = []) { this._hiddenSetIds = new Set(ids); }
  setHiddenSpecies(keys: any = []) { this._hiddenSpeciesKeys = new Set(keys); }

  set onRemove(fn: any) { this._onRemove = fn; }
  set onBulkEdit(fn: any) { this._onBulkEdit = fn; }
  set onMultiSelectionChange(fn: any) { this._onMultiSelectionChange = fn; }
  setSpeciesSearchFactory(fn: any) { this._speciesSearchFactory = fn || null; }

  setLockedIds(ids = []) { this._lockedIds = new Set(ids); }
  get selectedId() { return this._selectedId; }
  get multiSelectedIds() { return this._multiSelectedIds; }
  get view() { return this._view; }

  /** 'source' (tree by set) or 'time' (flat, by start time). */
  setView(view: 'source' | 'time') {
    this._view = view === 'time' ? 'time' : 'source';
    try { localStorage.setItem(VIEW_KEY, this._view); } catch { /* ignore */ }
    this.render(this._labels);
  }

  /** Filter by species name, scientific name or tag text (case-insensitive). */
  setFilter(text: string) {
    this._filter = String(text || '').trim().toLowerCase();
    this.render(this._labels);
  }

  /** Mark the label whose segment is currently playing (null = none). */
  setPlaying(labelId: string | null) {
    if (this._playingId === labelId) return;
    const prev = this._playingId ? this._cardMap.get(this._playingId) : null;
    if (prev) this._setPlayVisual(prev, false);
    this._playingId = labelId;
    const cur = labelId ? this._cardMap.get(labelId) : null;
    if (cur) this._setPlayVisual(cur, true);
  }

  /** Progress 0..1 of the playing segment (thin bar under the row). */
  setPlayProgress(fraction: number) {
    const row = this._playingId ? this._cardMap.get(this._playingId) : null;
    const bar = row?.querySelector('.lt-prog');
    if (bar) bar.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  }

  _setPlayVisual(row: any, on: boolean) {
    row.classList.toggle('lt-row--playing', on);
    const btn = row.querySelector('.lt-play');
    if (btn) {
      btn.innerHTML = on ? ICON.stop : ICON.play;
      btn.title = on ? 'Stop' : 'Play this segment';
      btn.setAttribute('aria-label', btn.title);
    }
    const bar = row.querySelector('.lt-prog');
    if (bar && !on) bar.style.width = '0';
  }

  /** Update only the tag text of a label row (no full re-render). */
  updateBadges(labelId: any, lbl: any) {
    const row = this._cardMap.get(labelId);
    const old = row?.querySelector('.lt-tags');
    if (old) old.replaceWith(this._buildTagText(lbl, this._view === 'time'));
  }

  // ── Rendering ─────────────────────────────────────────────────────

  _matches(lbl: any) {
    if (!this._filter) return true;
    const { display, scientific } = this._resolveName(lbl);
    const hay = [display, scientific, lbl.label, lbl.scientificName,
      ...Object.values(lbl.tags || {}).filter((v) => typeof v === 'string')].join(' ').toLowerCase();
    return hay.includes(this._filter);
  }

  /** Full re-render. */
  render(labels: any) {
    this._labels = labels;
    const idSet = new Set(labels.map((l: any) => l.id));
    for (const id of this._multiSelectedIds) if (!idSet.has(id)) this._multiSelectedIds.delete(id);
    this._container.innerHTML = '';
    this._container.classList.toggle('lt-view-time', this._view === 'time');
    this._cardMap = new Map();
    if (this._badgeEl) this._badgeEl.textContent = String(labels.length);
    const hasSets = this._getSets ? this._getSets().size > 0 : false;
    this._emptyEl.style.display = (labels.length || hasSets) ? 'none' : '';

    const visible = labels.filter((l: any) => this._matches(l));
    if (this._view === 'time') this._renderTime(visible);
    else this._renderSources(visible, labels);

    if (this._filter && !visible.length && labels.length) {
      this._container.appendChild(el('div', 'lt-empty', `No labels match “${this._filter}”.`));
    }
    if (this._selectedId) this.highlightRow(this._selectedId, { scroll: false });
    if (this._playingId) {
      const row = this._cardMap.get(this._playingId);
      if (row) this._setPlayVisual(row, true);
    }
    this._updateMultiVisual();
    this._updateBulkToolbar();
  }

  _setKeyOf(lbl: any, setsRegistry: Map<string, any>) {
    if (lbl.setId && setsRegistry.has(lbl.setId)) return { key: lbl.setId, info: setsRegistry.get(lbl.setId) };
    const as = getAnnotationSet(lbl);
    if (as) return { key: as?.uri || as?.name || '', info: { ...as, origin: lbl.origin || 'xeno-canto' } };
    return { key: '', info: null };
  }

  _isLocked(setInfo: any) {
    return !!(setInfo?.locked || setInfo?.origin === 'xeno-canto');
  }

  _renderSources(visible: any[], all: any[]) {
    const ORIGIN_ORDER: Record<string, number> = { manual: 0, BirdNET: 1, 'xeno-canto': 2 };
    const setsRegistry: Map<string, any> = this._getSets ? this._getSets() : new Map();
    const groups = new Map<string, { setInfo: any, origin: string, labels: any[], total: number }>();

    for (const [setId, setInfo] of setsRegistry) {
      groups.set(setId, { setInfo, origin: setInfo.origin || 'manual', labels: [], total: 0 });
    }
    for (const lbl of all) {
      const { key, info } = this._setKeyOf(lbl, setsRegistry);
      if (!groups.has(key)) groups.set(key, { setInfo: info, origin: info?.origin || lbl.origin || 'manual', labels: [], total: 0 });
      groups.get(key)!.total++;
    }
    const visibleIds = new Set(visible.map((l) => l.id));
    for (const lbl of all) {
      if (!visibleIds.has(lbl.id)) continue;
      groups.get(this._setKeyOf(lbl, setsRegistry).key)!.labels.push(lbl);
    }

    const keys = [...groups.keys()].sort((a, b) => {
      const ga = groups.get(a)!, gb = groups.get(b)!;
      const oa = ORIGIN_ORDER[ga.origin] ?? 3, ob = ORIGIN_ORDER[gb.origin] ?? 3;
      if (oa !== ob) return oa - ob;
      if (a === '') return 1;
      if (b === '') return -1;
      return (ga.setInfo?.name || a).localeCompare(gb.setInfo?.name || b);
    });

    for (const key of keys) {
      const g = groups.get(key)!;
      if (key === '' && g.total === 0) continue;
      // Imported sets without labels in this recording are noise
      if (g.total === 0 && g.origin !== 'manual') continue;
      if (this._filter && g.labels.length === 0) continue;
      this._container.appendChild(this._buildSource(key, g));
    }
  }

  _renderTime(visible: any[]) {
    const setsRegistry: Map<string, any> = this._getSets ? this._getSets() : new Map();
    const list = el('div', 'lt-time-list');
    for (const lbl of visible.slice().sort((a, b) => a.start - b.start)) {
      const { key, info } = this._setKeyOf(lbl, setsRegistry);
      const origin = info?.origin || lbl.origin || 'manual';
      const row = this._buildRow(lbl, this._isLocked(info), { flat: true, origin, external: origin !== 'manual' });
      if (this._hiddenSetIds.has(key)) row.classList.add('lt-row--hidden');
      list.appendChild(row);
    }
    this._container.appendChild(list);
  }

  // ── Source block ──────────────────────────────────────────────────

  _buildSource(setKey: string, g: { setInfo: any, origin: string, labels: any[], total: number }) {
    const { setInfo, origin, labels } = g;
    const locked = setKey ? this._isLocked(setInfo) : false;
    const external = origin !== 'manual';
    const hidden = this._hiddenSetIds.has(setKey);
    const open = !this._collapsedSets.has(setKey);

    const section = el('section', 'lt-src');
    section.dataset.setKey = setKey;
    if (external) section.classList.add('lt-src--ext');
    if (hidden) section.classList.add('lt-src--hidden');
    if (open) section.classList.add('lt-open');

    // Group by species
    const bySpecies = new Map<string, any[]>();
    for (const lbl of labels) {
      const k = lbl.label || '(unlabeled)';
      if (!bySpecies.has(k)) bySpecies.set(k, []);
      bySpecies.get(k)!.push(lbl);
    }

    // ── Header ──
    const hdr = el('div', 'lt-src-head');
    hdr.tabIndex = 0;
    hdr.setAttribute('role', 'button');
    hdr.setAttribute('aria-expanded', String(open));
    const chev = el('span', 'lt-chev'); chev.innerHTML = ICON.chev; hdr.appendChild(chev);
    const badge = el('span', `lt-badge lt-badge--${originBadge(origin).toLowerCase()}`, originBadge(origin));
    const isOwn = setKey === OWN_SOURCE_ID;
    badge.title = isOwn ? 'Your own labels' : origin === 'manual' ? 'Own set' : origin;
    hdr.appendChild(badge);
    const name = el('span', 'lt-src-name', isOwn ? 'My labels' : (setInfo?.name || (setKey ? 'Annotation set' : 'Labels without set')));
    name.title = isOwn ? 'Your own labels — the XC set is built from them in the Upload tab' : (setInfo?.name || '');
    if (this._onRenameSet && setKey && !locked && !isOwn) {
      name.title = `${setInfo?.name || ''} — double-click to rename`;
      name.addEventListener('dblclick', (e: MouseEvent) => { e.stopPropagation(); this._startSetRename(name, setKey, setInfo); });
    }
    hdr.appendChild(name);

    const hover = el('span', 'lt-hover-acts');
    if (this._onAdoptSet && setKey && external && g.total > 0) {
      hover.appendChild(iconBtn('lt-adopt', ICON.adopt, 'Copy all labels into my labels', () => this._onAdoptSet(setKey)));
    }
    if (setKey) hover.appendChild(iconBtn('lt-more', ICON.more, 'More…', (e) => this._openSetMenu(e, setKey, setInfo, locked, external, g.total, name)));
    hdr.appendChild(hover);

    const n = labels.length, k = bySpecies.size;
    const meta = el('span', 'lt-src-meta', n ? `${n} · ${k} ${k === 1 ? 'species' : 'species'}` : '0');
    meta.title = `${n} label${n === 1 ? '' : 's'}, ${k} species`;
    hdr.appendChild(meta);

    if (this._onToggleSetVisibility && setKey) {
      const eye = iconBtn(`lt-eye${hidden ? ' lt-eye--off' : ''}`, hidden ? ICON.eyeOff : ICON.eye,
        hidden ? 'Show set on spectrogram' : 'Hide set on spectrogram',
        () => this._onToggleSetVisibility(setKey, !hidden));
      hdr.appendChild(eye);
    }

    const toggle = () => {
      const nowOpen = !section.classList.contains('lt-open');
      section.classList.toggle('lt-open', nowOpen);
      hdr.setAttribute('aria-expanded', String(nowOpen));
      if (nowOpen) this._collapsedSets.delete(setKey); else this._collapsedSets.add(setKey);
    };
    hdr.addEventListener('click', toggle);
    hdr.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.target !== hdr) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    hdr.addEventListener('contextmenu', (e: MouseEvent) => {
      if (!setKey) return;
      e.preventDefault();
      this._openSetMenu(e, setKey, setInfo, locked, external, g.total, name);
    });

    // Drop a label on the header → move it into this set
    if (this._onAssignSet && !locked) {
      hdr.addEventListener('dragover', (e: DragEvent) => {
        if (!e.dataTransfer!.types.includes('text/label-id')) return;
        e.preventDefault(); e.dataTransfer!.dropEffect = 'move'; hdr.classList.add('drag-over');
      });
      hdr.addEventListener('dragleave', (e: DragEvent) => { if (!hdr.contains(e.relatedTarget as Node | null)) hdr.classList.remove('drag-over'); });
      hdr.addEventListener('drop', (e: DragEvent) => {
        e.preventDefault(); hdr.classList.remove('drag-over');
        const labelId = e.dataTransfer!.getData('text/label-id');
        if (labelId) this._onAssignSet(labelId, setKey || null);
      });
    }
    section.appendChild(hdr);
    if (isOwn) { const bar = this._buildLayerBar(); if (bar) section.appendChild(bar); }

    // ── Info line (imported sets): creator · license · link ──
    const infoParts = [setInfo?.creator, setInfo?.license].filter(Boolean);
    if (external && (infoParts.length || setInfo?.uri)) {
      const info = el('div', 'lt-src-info');
      if (infoParts.length) info.appendChild(el('span', '', infoParts.join(' · ')));
      if (setInfo?.uri) {
        if (infoParts.length) info.appendChild(el('span', '', ' · '));
        const a = el('a', 'lt-src-link', origin === 'xeno-canto' ? 'xeno-canto ↗' : 'source ↗');
        a.href = setInfo.uri; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.addEventListener('click', (e: MouseEvent) => e.stopPropagation());
        info.appendChild(a);
      }
      section.appendChild(info);
    }

    // ── Body ──
    const body = el('div', 'lt-src-body');
    if (!labels.length) {
      body.appendChild(el('div', 'lt-empty', origin === 'manual'
        ? 'No labels yet. Drag on the spectrogram to draw one, or ✓ on an imported label.'
        : 'No labels.'));
    }
    const names = [...bySpecies.keys()].sort((a, b) => bySpecies.get(b)!.length - bySpecies.get(a)!.length || a.localeCompare(b));
    for (const nm of names) {
      const inst = bySpecies.get(nm)!.slice().sort((a: any, b: any) => a.start - b.start);
      body.appendChild(this._buildGroup(inst, locked, setKey, external));
    }
    section.appendChild(body);
    return section;
  }

  // ── Layers (own source) ───────────────────────────────────────────

  _layerInfo() {
    if (!this._layers) return null;
    const info = this._layers.get();
    return { layers: info.layers || [], active: info.active || DEFAULT_LAYER_ID, hidden: info.hidden || new Set<string>() };
  }

  _ownMenuItems(items: any[]) {
    const info = this._layerInfo();
    if (!info) { items.push({ label: 'No actions', disabled: true }); return; }
    items.push({ label: 'New layer…', action: () => this._layers!.onAdd() });
    for (const ly of info.layers) {
      if (ly.id === DEFAULT_LAYER_ID && info.layers.length === 1) continue;
      items.push({ label: `Rename layer “${ly.name}”…`, action: () => this._layers!.onRename(ly.id) });
    }
    const removable = info.layers.filter((x) => x.id !== DEFAULT_LAYER_ID);
    if (removable.length) items.push({ separator: true });
    for (const ly of removable) {
      items.push({ label: `Remove layer “${ly.name}” (labels move to “${info.layers[0].name}”)`, danger: true, action: () => this._layers!.onRemove(ly.id) });
    }
  }

  /** Chips: click = draw new labels on this layer; eye = show/hide on the spectrogram. Only with >1 layer. */
  _buildLayerBar() {
    const info = this._layerInfo();
    if (!info || info.layers.length < 2) return null;
    const bar = el('div', 'lt-layers');
    bar.appendChild(el('span', 'lt-layers-label', 'Layer'));
    for (const ly of info.layers) {
      const hidden = info.hidden.has(ly.id);
      const chip = el('span', 'lt-layer-chip' + (ly.id === info.active ? ' lt-layer-chip--active' : '') + (hidden ? ' lt-layer-chip--hidden' : ''));
      const b = el('button', 'lt-layer-name', ly.name);
      b.type = 'button';
      b.title = ly.id === info.active ? 'New labels go to this layer (double-click to rename)' : 'Draw new labels on this layer (double-click to rename)';
      b.addEventListener('click', (e: MouseEvent) => { e.stopPropagation(); this._layers!.onSetActive(ly.id); });
      b.addEventListener('dblclick', (e: MouseEvent) => { e.stopPropagation(); this._layers!.onRename(ly.id); });
      const eye = iconBtn(`lt-eye${hidden ? ' lt-eye--off' : ''}`, hidden ? ICON.eyeOff : ICON.eye,
        hidden ? 'Show layer on spectrogram' : 'Hide layer on spectrogram', () => this._layers!.onToggleHidden(ly.id));
      chip.append(b, eye);
      bar.appendChild(chip);
    }
    const add = el('button', 'lt-layer-add', '+');
    add.type = 'button';
    add.title = 'New layer';
    add.addEventListener('click', (e: MouseEvent) => { e.stopPropagation(); this._layers!.onAdd(); });
    bar.appendChild(add);
    return bar;
  }

  _openSetMenu(e: MouseEvent, setKey: string, setInfo: any, locked: boolean, external: boolean, total: number, nameEl: any) {
    const items: any[] = [];
    if (setKey === OWN_SOURCE_ID) {
      this._ownMenuItems(items);
      const t0 = (e.currentTarget || e.target) as HTMLElement;
      const r0 = e.type === 'contextmenu' ? null : t0?.getBoundingClientRect?.();
      showContextMenu({ x: r0 ? r0.left : e.clientX, y: r0 ? r0.bottom + 2 : e.clientY, items });
      return;
    }
    if (this._onRenameSet && !locked) items.push({ label: 'Rename set', action: () => this._startSetRename(nameEl, setKey, setInfo) });
    if (this._onAdoptSet && external && total > 0) items.push({ label: 'Copy all labels into my labels', action: () => this._onAdoptSet(setKey) });
    if (this._onConvertSetToManual && setInfo?.origin === 'xeno-canto') items.push({ label: 'Convert to manual set', action: () => this._onConvertSetToManual(setKey) });
    if (this._onToggleLockSet && setInfo?.origin !== 'xeno-canto') {
      items.push({ label: locked ? 'Unlock set (allow editing)' : 'Lock set (prevent editing)', action: () => this._onToggleLockSet(setKey, !locked) });
    }
    if (setInfo?.uri) items.push({ label: 'Open source page ↗', action: () => window.open(setInfo.uri, '_blank', 'noopener') });
    const deletable = this._onDeleteSet && (this._canDeleteSet ? this._canDeleteSet(setKey) : true);
    if (deletable) {
      if (items.length) items.push({ separator: true });
      items.push({
        label: 'Delete set…', danger: true,
        action: () => {
          const msg = total > 0
            ? `Delete set "${setInfo?.name || setKey}" and its ${total} label${total === 1 ? '' : 's'}? This cannot be undone.`
            : `Delete set "${setInfo?.name || setKey}"?`;
          if (confirm(msg)) this._onDeleteSet(setKey);
        },
      });
    }
    if (!items.length) items.push({ label: 'No actions', disabled: true });
    const t = (e.currentTarget || e.target) as HTMLElement;
    const r = e.type === 'contextmenu' ? null : t?.getBoundingClientRect?.();
    showContextMenu({ x: r ? r.left : e.clientX, y: r ? r.bottom + 2 : e.clientY, items });
  }

  _startSetRename(nameEl: any, setKey: string, setInfo: any) {
    if (!this._onRenameSet || nameEl.querySelector('input')) return;
    const oldName = setInfo?.name || '';
    const inp = el('input', 'inline-name-input');
    inp.value = oldName;
    nameEl.textContent = '';
    nameEl.appendChild(inp);
    inp.focus(); inp.select();
    let done = false;
    const commit = (save: boolean) => {
      if (done) return; done = true;
      const val = inp.value.trim();
      if (save && val && val !== oldName) this._onRenameSet(setKey, val);
      nameEl.textContent = (save && val) || oldName;
    };
    inp.addEventListener('blur', () => commit(true));
    inp.addEventListener('keydown', (ev: KeyboardEvent) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
      if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
    });
    inp.addEventListener('click', (ev: MouseEvent) => ev.stopPropagation());
  }

  // ── Species group ─────────────────────────────────────────────────

  _buildThumb(lbl: any, scientific: string) {
    const wrap = el('span', 'lt-thumb lbl-group-img-wrap');
    const sciName = lbl.scientificName || scientific || '';
    const record = sciName ? this._taxonomy?.resolve(sciName) : null;
    const attribution = record?.img_author ? `Image © ${record.img_author}${record.img_license ? ` (${record.img_license})` : ''}` : '';
    const src = sciName ? `${BIRD_IMG_BASE}${encodeURIComponent(sciName)}.webp` : BIRD_IMG_FALLBACK;
    const img = el('img', 'lbl-group-img');
    img.src = src; img.alt = ''; img.loading = 'lazy';
    img.addEventListener('error', () => { img.src = BIRD_IMG_FALLBACK; }, { once: true });
    wrap.appendChild(img);
    if (sciName) {
      const pop = el('div', 'lbl-img-popover');
      const pImg = el('img'); pImg.src = src; pImg.alt = sciName;
      pImg.addEventListener('error', () => { pImg.src = BIRD_IMG_FALLBACK; }, { once: true });
      pop.appendChild(pImg);
      pop.appendChild(el('span', 'lbl-img-popover-caption', attribution ? `${sciName}\n${attribution}` : sciName));
      wrap.appendChild(pop);
    }
    return wrap;
  }

  _buildGroup(instances: any[], locked: boolean, setKey: string, external: boolean) {
    const rep = instances[0];
    const { display, scientific } = this._resolveName(rep);
    const speciesName = rep.label || '(unlabeled)';
    const groupKey = `${setKey}::${speciesName}`;
    const hideKey = `${setKey}|${speciesName}`;
    const spHidden = this._hiddenSpeciesKeys.has(hideKey);

    const group = el('div', 'lt-grp');
    group.dataset.groupKey = groupKey;
    if (spHidden) group.classList.add('lt-grp--hidden');
    if (this._expandedGroups.has(groupKey) || this._filter) group.classList.add('lt-open');

    const row = el('div', 'lt-sp');
    row.tabIndex = -1;
    const chev = el('span', 'lt-chev'); chev.innerHTML = ICON.chev; row.appendChild(chev);
    row.appendChild(this._buildThumb(rep, scientific));
    const names = el('span', 'lt-names');
    const nameEl = el('span', 'lt-name', display);
    names.appendChild(nameEl);
    if (scientific && scientific !== display) names.appendChild(el('span', 'lt-sci', scientific));
    row.appendChild(names);

    const acts = el('span', 'lt-hover-acts');
    if (!locked) {
      acts.appendChild(iconBtn('', ICON.edit,
        instances.length > 1 ? `Change species for all ${instances.length} labels` : 'Change species',
        () => this._startGroupInlineEdit(nameEl, instances, display)));
    }
    if (this._onToggleSpeciesVisibility) {
      acts.appendChild(iconBtn(`lt-eye${spHidden ? ' lt-eye--off' : ''}`, spHidden ? ICON.eyeOff : ICON.eye,
        spHidden ? 'Show species on spectrogram' : 'Hide species on spectrogram',
        () => this._onToggleSpeciesVisibility(hideKey, !spHidden)));
    }
    row.appendChild(acts);
    row.appendChild(el('span', 'lt-count', String(instances.length)));

    if (!locked) {
      nameEl.title = 'Click to change the species of all these labels';
      nameEl.addEventListener('click', (e: MouseEvent) => {
        if (!group.classList.contains('lt-open')) return;   // first click just opens
        e.stopPropagation();
        this._startGroupInlineEdit(nameEl, instances, display);
      });
    }

    if (this._onAssignSpecies && !locked) {
      row.addEventListener('dragover', (e: DragEvent) => {
        if (!e.dataTransfer!.types.includes('text/label-id')) return;
        e.preventDefault(); e.dataTransfer!.dropEffect = 'move'; row.classList.add('drag-over');
      });
      row.addEventListener('dragleave', (e: DragEvent) => { if (!row.contains(e.relatedTarget as Node | null)) row.classList.remove('drag-over'); });
      row.addEventListener('drop', (e: DragEvent) => {
        e.preventDefault(); row.classList.remove('drag-over');
        const labelId = e.dataTransfer!.getData('text/label-id');
        if (labelId) this._onAssignSpecies(labelId, rep);
      });
    }

    row.addEventListener('click', () => this._setGroupOpen(group, !group.classList.contains('lt-open')));
    group.appendChild(row);

    const rows = el('div', 'lt-rows');
    for (const lbl of instances) rows.appendChild(this._buildRow(lbl, locked, { flat: false, origin: rep.origin, external }));
    group.appendChild(rows);
    return group;
  }

  _setGroupOpen(group: any, open: boolean) {
    if (open && this._accordion && this._multiSelectedIds.size === 0) {
      for (const og of this._container.querySelectorAll('.lt-grp.lt-open')) {
        if (og !== group) { og.classList.remove('lt-open'); this._expandedGroups.delete(og.dataset.groupKey); }
      }
    }
    group.classList.toggle('lt-open', open);
    if (open) this._expandedGroups.add(group.dataset.groupKey);
    else this._expandedGroups.delete(group.dataset.groupKey);
  }

  // ── Label row ─────────────────────────────────────────────────────

  _buildTagText(lbl: any, flat: boolean) {
    const span = el('span', 'lt-tags');
    if (flat) {
      const { display } = this._resolveName(lbl);
      span.appendChild(el('b', 'lt-tags-name', display));
    }
    const tags = lbl.tags || {};
    const parts: string[] = [];
    const sex = String(tags.sex || '').toLowerCase();
    if (sex === 'male') parts.push('♂');
    else if (sex === 'female') parts.push('♀');
    else if (tags.sex) parts.push(String(tags.sex));
    if (tags.lifeStage) parts.push(String(tags.lifeStage));
    if (tags.soundType) parts.push(String(tags.soundType));
    for (const [k, v] of Object.entries(tags)) {
      if (PRESET_KEYS.has(k) || SET_TAG_KEYS.has(k) || HIDDEN_TAG_KEYS.has(k)) continue;
      if (v === '' || v == null) continue;
      parts.push(`${k}: ${v}`);
    }
    if (parts.length) span.appendChild(document.createTextNode((flat ? ' ' : '') + parts.join(' · ')));
    return span;
  }

  _buildRow(lbl: any, locked: boolean, o: { flat: boolean, origin: string, external: boolean }) {
    const row = el('div', 'lt-row');
    if (locked) row.classList.add('lt-row--locked');
    if (o.external) row.classList.add('lt-row--ext');
    row.dataset.labelId = lbl.id;
    row.tabIndex = -1;
    const { display } = this._resolveName(lbl);
    row.title = `${display} · ${fmtTime(lbl.start)}–${fmtTime(lbl.end)} · ${fmtFreq(lbl.freqMin)}–${fmtFreq(lbl.freqMax)} Hz`
      + (lbl.tags?.remarks ? `\n${lbl.tags.remarks}` : '');

    if (this._onPlaySegment) {
      const play = el('button', 'lt-play');
      play.type = 'button';
      play.innerHTML = ICON.play;
      play.title = 'Play this segment';
      play.setAttribute('aria-label', play.title);
      play.addEventListener('click', (e: MouseEvent) => { e.stopPropagation(); this._onPlaySegment(lbl); });
      row.appendChild(play);
    } else {
      row.appendChild(el('span'));
    }
    if (o.flat) {
      const b = originBadge(o.origin);
      row.appendChild(el('span', `lt-mini lt-badge--${b.toLowerCase()}`, b));
    }
    row.appendChild(el('span', 'lt-start', fmtTime(lbl.start)));
    if (!o.flat) row.appendChild(el('span', 'lt-dur', fmtDur(lbl.end - lbl.start)));
    row.appendChild(this._buildTagText(lbl, o.flat));

    const layerInfo = this._layerInfo();
    const isOwnLabel = lbl.setId === OWN_SOURCE_ID;
    if (isOwnLabel && layerInfo && layerInfo.layers.length > 1) {
      const lid = lbl.layer || DEFAULT_LAYER_ID;
      const ln = layerInfo.layers.find((x) => x.id === lid)?.name || lid;
      row.appendChild(el('span', 'lt-layer', ln));
      if (layerInfo.hidden.has(lid)) row.classList.add('lt-row--hidden');
    }

    const right = el('span', 'lt-right');
    if (lbl.confidence != null) {
      const pct = Math.min(100, Math.round(Number(lbl.confidence) * 100));
      const c = el('span', `lt-conf${pct >= 60 ? ' lt-conf--hi' : ''}`, `${pct}%`);
      c.title = `Confidence ${pct} %`;
      right.appendChild(c);
    }
    const acts = el('span', 'lt-hover-acts');
    if (!locked) {
      acts.appendChild(iconBtn('species-edit-btn', ICON.edit, 'Change species / edit', () => this._onEdit?.(lbl.id)));
    } else if (this._onAdoptLabel) {
      acts.appendChild(iconBtn('lt-adopt', ICON.adopt, 'Copy into my labels', () => this._onAdoptLabel(lbl.id)));
    }
    if (this._onOpenRefCalls) acts.appendChild(iconBtn('', ICON.ref, 'Reference calls', () => this._onOpenRefCalls(lbl)));
    if (!locked) acts.appendChild(iconBtn('danger', ICON.del, 'Delete', () => this._onRemove?.(lbl)));
    right.appendChild(acts);
    row.appendChild(right);
    row.appendChild(el('span', 'lt-prog'));

    if (this._onAssignSet && !locked) {
      row.draggable = true;
      row.addEventListener('dragstart', (e: DragEvent) => {
        e.dataTransfer!.setData('text/label-id', lbl.id);
        e.dataTransfer!.effectAllowed = 'move';
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
    }

    row.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      const items: any[] = [];
      if (this._onPlaySegment) items.push({ label: 'Play segment', action: () => this._onPlaySegment(lbl) });
      if (locked) {
        if (this._onAdoptLabel) items.push({ label: 'Copy into my labels', action: () => this._onAdoptLabel(lbl.id) });
        items.push({ label: 'Read-only (imported set)', disabled: true });
      } else {
        items.push({ label: 'Rename', icon: '<svg viewBox="0 0 16 16"><path d="M11.5 2.5l2 2L5 13H3v-2L11.5 2.5z"/></svg>', action: () => this._onEdit?.(lbl.id) });
        if (isOwnLabel && layerInfo && layerInfo.layers.length > 1) {
          const ids = this._multiSelectedIds.has(lbl.id) ? [...this._multiSelectedIds].filter((id) => !this._lockedIds.has(id)) : [lbl.id];
          items.push({ separator: true });
          for (const ly of layerInfo.layers) {
            if (ly.id === (lbl.layer || DEFAULT_LAYER_ID) && ids.length === 1) continue;
            items.push({ label: `Move ${ids.length > 1 ? ids.length + ' labels ' : ''}to layer “${ly.name}”`, action: () => this._layers!.onMove(ids, ly.id) });
          }
        }
        items.push({ separator: true });
        items.push({ label: 'Delete', danger: true, icon: '<svg viewBox="0 0 16 16"><polyline points="3,4 13,4"/><path d="M6,4V2h4v2M5,4v9a1,1,0,0,0,1,1h4a1,1,0,0,0,1-1V4"/></svg>', action: () => this._onRemove?.(lbl) });
      }
      showContextMenu({ x: e.clientX, y: e.clientY, items });
    });

    row.addEventListener('click', (e: MouseEvent) => {
      if ((e.target as Element).closest('.act-btn, .lt-play, input, select, .esel')) return;
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        e.preventDefault();
        if (e.shiftKey) this._rangeSelect(lbl.id);
        else this._toggleMulti(lbl.id);
        return;
      }
      if (this._multiSelectedIds.size > 0) { this._multiSelectedIds.clear(); this._updateMultiVisual(); this._updateBulkToolbar(); }
      this._activate(lbl);
    });
    row.addEventListener('dblclick', (e: MouseEvent) => {
      if (locked || (e.target as Element).closest('.act-btn, .lt-play, input, select, .esel')) return;
      e.stopPropagation();
      this._onEdit?.(lbl.id);
    });
    row.addEventListener('pointerenter', () => this._onHover?.(lbl.id, true));
    row.addEventListener('pointerleave', () => this._onHover?.(lbl.id, false));

    this._cardMap.set(lbl.id, row);
    return row;
  }

  _activate(lbl: any) {
    this._onSeek?.(lbl);
    this.highlightRow(lbl.id);
    this._onFocus?.(lbl.id, 'list');
  }

  _toggleMulti(id: string) {
    if (this._lockedIds.has(id)) return;
    if (this._multiSelectedIds.size === 0 && this._selectedId && this._selectedId !== id && !this._lockedIds.has(this._selectedId)) {
      this._multiSelectedIds.add(this._selectedId);
    }
    if (this._multiSelectedIds.has(id)) this._multiSelectedIds.delete(id);
    else this._multiSelectedIds.add(id);
    this._updateMultiVisual();
    this._updateBulkToolbar();
  }

  /** Shift+click: select every visible, editable row between the anchor and this one. */
  _rangeSelect(id: string) {
    const order = [...this._container.querySelectorAll('.lt-row')].map((r: any) => r.dataset.labelId);
    const anchor = this._selectedId && order.includes(this._selectedId) ? this._selectedId : id;
    const [a, b] = [order.indexOf(anchor), order.indexOf(id)].sort((x, y) => x - y);
    for (const rid of order.slice(a, b + 1)) if (!this._lockedIds.has(rid)) this._multiSelectedIds.add(rid);
    this._updateMultiVisual();
    this._updateBulkToolbar();
  }

  // ── Selection / highlighting ──────────────────────────────────────

  _reveal(row: any) {
    const section = row.closest('.lt-src');
    if (section && !section.classList.contains('lt-open')) {
      section.classList.add('lt-open');
      this._collapsedSets.delete(section.dataset.setKey);
    }
    const group = row.closest('.lt-grp');
    if (group && !group.classList.contains('lt-open')) this._setGroupOpen(group, true);
  }

  highlightRow(labelId: any, opts: { scroll?: boolean } = {}) {
    this._selectedId = labelId || null;
    for (const c of this._container.querySelectorAll('.lt-row.selected')) c.classList.remove('selected');
    if (labelId && this._multiSelectedIds.size === 0) {
      const row = this._cardMap.get(labelId);
      if (row) {
        this._reveal(row);
        row.classList.add('selected');
        if (opts.scroll !== false) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }

  highlightHover(labelId: any) {
    for (const c of this._container.querySelectorAll('.lt-row.highlighted')) c.classList.remove('highlighted');
    if (labelId) {
      const row = this._cardMap.get(labelId);
      if (row) {
        this._reveal(row);
        row.classList.add('highlighted');
        row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }

  clearMultiSelection() {
    this._multiSelectedIds.clear();
    this._updateMultiVisual();
    this._updateBulkToolbar();
  }

  _updateMultiVisual() {
    const any = this._multiSelectedIds.size > 0;
    for (const [id, row] of this._cardMap) {
      row.classList.toggle('multi-selected', this._multiSelectedIds.has(id));
      row.classList.toggle('multi-active', any);
      if (any) row.classList.remove('selected');
      else if (id === this._selectedId) row.classList.add('selected');
    }
  }

  _updateBulkToolbar() {
    this._onMultiSelectionChange?.([...this._multiSelectedIds]);
    const count = this._multiSelectedIds.size;
    if (count < 2) {
      if (this._bulkToolbar) { this._bulkToolbar.remove(); this._bulkToolbar = null; }
      return;
    }
    if (!this._bulkToolbar) {
      const bar = el('div', 'label-multi-toolbar');
      const scroll = this._container.closest('.label-list-scroll');
      const parent = scroll ? scroll.parentElement : this._container.parentElement;
      parent.insertBefore(bar, scroll || this._container);
      this._bulkToolbar = bar;
    }
    this._bulkToolbar.innerHTML = '';
    this._bulkToolbar.appendChild(el('span', 'label-multi-info', `${count} selected`));
    const editableIds = [...this._multiSelectedIds].filter((id) => !this._lockedIds.has(id));
    if (this._onBulkEdit && editableIds.length > 0) {
      const btn = el('button', 'tb-btn', editableIds.length < count ? `Rename ${editableIds.length} editable` : 'Rename selected');
      btn.addEventListener('click', () => this._onBulkEdit(editableIds));
      this._bulkToolbar.appendChild(btn);
    }
    const clr = el('button', 'tb-btn', 'Deselect all');
    clr.addEventListener('click', () => this.clearMultiSelection());
    this._bulkToolbar.appendChild(clr);
  }

  // ── Inline name editing (group-level) ─────────────────────────────

  _startGroupInlineEdit(nameEl: any, instances: any, displayName: any) {
    if (nameEl.querySelector('input') || nameEl.querySelector('.species-search-widget')) return;

    const applyName = ({ name, scientificName }: any) => {
      const val = (name || '').trim();
      if (val) {
        for (const lbl of instances) {
          lbl.label = val;
          lbl.scientificName = scientificName || '';
          lbl.commonName = '';
        }
        this._onSync({ structural: true });
      } else {
        nameEl.textContent = displayName;
      }
    };

    if (this._speciesSearchFactory) {
      nameEl.textContent = '';
      const widget = this._speciesSearchFactory(nameEl, applyName);
      widget.input.value = instances[0].label || displayName;
      nameEl.appendChild(widget.el);
      widget.input.focus();
      widget.input.select();
      widget.input.addEventListener('keydown', (e: any) => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); nameEl.textContent = displayName; }
      });
      widget.input.addEventListener('blur', () => {
        setTimeout(() => {
          if (nameEl.querySelector('.species-search-widget')) nameEl.textContent = displayName;
        }, 200);
      });
      widget.input.addEventListener('click', (e: any) => e.stopPropagation());
    } else {
      const input = el('input', 'inline-name-input');
      input.value = instances[0].label || displayName;
      nameEl.textContent = '';
      nameEl.appendChild(input);
      input.focus();
      input.select();
      const commit = () => {
        const val = input.value.trim();
        if (val && val !== instances[0].label) applyName({ name: val, scientificName: '' });
        else nameEl.textContent = displayName;
      };
      input.addEventListener('keydown', (e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); nameEl.textContent = displayName; }
      });
      input.addEventListener('blur', commit);
      input.addEventListener('click', (e: MouseEvent) => e.stopPropagation());
    }
  }
}
