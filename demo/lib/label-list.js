/**
 * Hierarchical label list for sidebar display.
 *
 * Labels are grouped in up to three levels:
 *   1. Origin (manual / BirdNET / xeno-canto)
 *   2. Annotation Set (XC labels from an annotation set get a collapsible set header)
 *   3. Species/label name (collapsible, inline-editable, shows all instances)
 *      └─ Instance cards (time · freq · tag pills · actions)
 *
 * Usage:
 *   import { LabelList } from './lib/label-list.js';
 *   const list = new LabelList({ container, emptyEl, resolveName, onSync, ... });
 *   list.render(labels);
 */

import { TAG_PRESETS } from './label-table.js';
import { showContextMenu } from './context-menu.js';

const BIRD_IMG_BASE = 'https://birdnet.cornell.edu/api2/bird/';
const BIRD_IMG_FALLBACK = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Crect width='40' height='40' fill='%23252525'/%3E%3Cpath d='M20 9c-4 0-7 3-8 6l-4-2c-1-1-2 0-1 1l3 5c-1 1-2 3-2 5 0 6 5 10 12 10s12-4 12-10c0-2-1-3-1-4l3-5c1-1-1-2-2-1l-4 3c-1-4-4-8-8-8z' fill='%23444'/%3E%3C/svg%3E`;

const PRESET_KEYS = new Set(TAG_PRESETS.map((p) => p.key));
// Tags that belong to the set header — never shown as per-instance badges
const SET_TAG_KEYS = new Set(['setName', 'setLicense', 'setCreator']);

function fmt(sec) {
  const s = Number(sec);
  return s >= 60
    ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}.${String(Math.round((s % 1) * 10)).padStart(1, '0')}`
    : s.toFixed(2) + 's';
}

function fmtFreq(hz) {
  const n = Math.round(Number(hz));
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

/** Derive annotation set info from a label — supports both new (annotationSet field) and legacy (tags) format. */
function getAnnotationSet(lbl) {
  if (lbl.annotationSet) return lbl.annotationSet;
  if (lbl.tags?.setName || lbl.tags?.setLicense) {
    return {
      name: lbl.tags.setName || '',
      license: lbl.tags.setLicense || '',
      creator: lbl.tags.setCreator || '',
      uri: '',
      date: '',
    };
  }
  return null;
}

const LICENSE_COLORS = {
  'CC0': '#6366f1', 'CC-BY': '#10b981', 'CC-BY-NC': '#f59e0b',
  'CC-BY-SA': '#3b82f6', 'CC-BY-NC-SA': '#ef4444',
};
function licenseColor(lic) {
  for (const [k, v] of Object.entries(LICENSE_COLORS)) {
    if ((lic || '').startsWith(k)) return v;
  }
  return '#6b7280';
}

export class LabelList {
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
   * @param {(partial: object) => void} [opts.onCreateSet]       Create a new set
   * @param {(id: string, name: string) => void} [opts.onRenameSet]
   * @param {(id: string) => void}      [opts.onDeleteSet]
   * @param {(labelId: string, setId: string|null) => void} [opts.onAssignSet]
   * @param {(setId: string) => void}   [opts.onConvertSetToManual]
   * @param {(setId: string) => boolean} [opts.canDeleteSet]  Return false to hide the delete button for a specific set
   * @param {((anchor: HTMLElement, onSelect: function) => {el:HTMLElement,input:HTMLInputElement,destroy:function})|null} [opts.speciesSearchFactory]
   */
  constructor(opts) {
    this._container = opts.container;
    this._emptyEl = opts.emptyEl;
    this._badgeEl = opts.badgeEl || null;
    this._resolveName = opts.resolveName;
    this._onSync = opts.onSync;
    this._onSeek = opts.onSeek;
    this._onEdit = opts.onEdit;
    this._onBulkEdit = opts.onBulkEdit || null;
    this._onFocus = opts.onFocus;
    this._onHover = opts.onHover;
    this._onMultiSelectionChange = opts.onMultiSelectionChange || null;
    this._onRemove = null;
    this._tagStore = opts.tagStore || null;
    /** If true, ensure only one label group is expanded at once (accordion) */
    this._accordion = !!opts.accordion;
    // Set management callbacks
    this._getSets = opts.getSets || null;
    this._onCreateSet = opts.onCreateSet || null;
    this._onRenameSet = opts.onRenameSet || null;
    this._onDeleteSet = opts.onDeleteSet || null;
    this._onAssignSet = opts.onAssignSet || null;
    this._onAssignSpecies = opts.onAssignSpecies || null;
    this._onConvertSetToManual = opts.onConvertSetToManual || null;
    this._onToggleLockSet = opts.onToggleLockSet || null;
    this._canDeleteSet = opts.canDeleteSet || null;
    /** @type {((anchor: HTMLElement, cb: function) => {el:HTMLElement,input:HTMLInputElement,destroy:function})|null} */
    this._speciesSearchFactory = opts.speciesSearchFactory || null;
    this._onOpenRefCalls = opts.onOpenRefCalls || null;
    this._cardMap = new Map();
    this._selectedId = null;
    /** @type {Set<string>} */
    this._multiSelectedIds = new Set();
    this._labels = [];
    /** @type {Set<string>} group keys that are expanded */
    this._expandedGroups = new Set();
    /** @type {Set<string>} annotation set keys that are expanded */
    this._expandedSets = new Set();
    /** @type {HTMLElement|null} */
    this._bulkToolbar = null;
    /** @type {Set<string>} ids that must not be edited */
    this._lockedIds = new Set();
  }

  set onRemove(fn) { this._onRemove = fn; }
  set onBulkEdit(fn) { this._onBulkEdit = fn; }
  set onMultiSelectionChange(fn) { this._onMultiSelectionChange = fn; }
  /** Provide or update the species search factory after construction. */
  setSpeciesSearchFactory(fn) { this._speciesSearchFactory = fn || null; }

  /** Mark label ids as locked so they are excluded from bulk-edit actions. */
  setLockedIds(ids = []) { this._lockedIds = new Set(ids); }
  get selectedId() { return this._selectedId; }
  get multiSelectedIds() { return this._multiSelectedIds; }

  /** Update only tag-badges of a specific label instance (no full re-render). */
  updateBadges(labelId, lbl) {
    const inst = this._cardMap.get(labelId);
    if (!inst) return;
    const oldBadges = inst.querySelector('.label-instance-tags');
    if (oldBadges) {
      const newBadges = this._buildTagPills(lbl);
      oldBadges.replaceWith(newBadges);
    }
  }

  /** Full re-render. */
  render(labels) {
    this._labels = labels;
    const idSet = new Set(labels.map((l) => l.id));
    for (const id of this._multiSelectedIds) {
      if (!idSet.has(id)) this._multiSelectedIds.delete(id);
    }
    this._container.innerHTML = '';
    this._cardMap = new Map();
    if (this._badgeEl) this._badgeEl.textContent = String(labels.length);
    const hasSets = this._getSets ? this._getSets().size > 0 : false;
    this._emptyEl.style.display = (labels.length || hasSets) ? 'none' : '';

    const ORIGIN_ORDER = { manual: 0, BirdNET: 1, 'xeno-canto': 2 };
    const setsRegistry = this._getSets ? this._getSets() : new Map();

    // 2-level: setKey → {setInfo, origin, nameMap}
    // Labels with no set are grouped into a virtual '' key (rendered without a set header)
    /** @type {Map<string, {setInfo: any, origin: string, nameMap: Map<string, any[]>}>} */
    const setGroups = new Map();

    // Pre-seed empty sets so they appear even with no labels
    for (const [setId, setInfo] of setsRegistry) {
      const origin = setInfo.origin || 'manual';
      if (!setGroups.has(setId)) setGroups.set(setId, { setInfo, origin, nameMap: new Map() });
    }

    for (const lbl of labels) {
      const origin = lbl.origin || 'manual';
      let setInfo = null;
      let setKey = '';
      if (lbl.setId && setsRegistry.has(lbl.setId)) {
        setInfo = setsRegistry.get(lbl.setId);
        setKey = lbl.setId;
      } else {
        const as = getAnnotationSet(lbl);
        if (as) { setInfo = as; setKey = as?.uri || as?.name || ''; }
      }
      if (!setGroups.has(setKey)) setGroups.set(setKey, { setInfo, origin, nameMap: new Map() });
      const { nameMap } = setGroups.get(setKey);
      const nameKey = lbl.label || '(unlabeled)';
      if (!nameMap.has(nameKey)) nameMap.set(nameKey, []);
      nameMap.get(nameKey).push(lbl);
    }

    // Sort set entries: '' (unassigned) first, then by origin order, then by name
    const sortedKeys = [...setGroups.keys()].sort((a, b) => {
      if (a === '' && b !== '') return -1;
      if (b === '' && a !== '') return 1;
      const ga = setGroups.get(a), gb = setGroups.get(b);
      const oa = ORIGIN_ORDER[ga.origin] ?? 99, ob = ORIGIN_ORDER[gb.origin] ?? 99;
      if (oa !== ob) return oa - ob;
      return (ga.setInfo?.name || a).localeCompare(gb.setInfo?.name || b);
    });

    for (const setKey of sortedKeys) {
      const { setInfo, nameMap } = setGroups.get(setKey);
      const names = [...nameMap.keys()].sort((a, b) => a.localeCompare(b));
      const totalInSet = names.reduce((n, k) => n + nameMap.get(k).length, 0);

      if (setKey) {
        // Hide XC-imported sets that have no labels in the current recording
        if (totalInSet === 0 && setInfo?.origin === 'xeno-canto') continue;
        const locked = !!(setInfo?.locked || setInfo?.origin === 'xeno-canto');
        const setSection = this._buildSetSection(setInfo, setKey, totalInSet, () => {
          const frag = document.createDocumentFragment();
          for (const name of names) {
            const instances = nameMap.get(name).slice().sort((a, b) => a.start - b.start);
            frag.appendChild(this._buildGroup(instances, locked));
          }
          return frag;
        }, locked);
        this._container.appendChild(setSection);
      } else {
        for (const name of names) {
          const instances = nameMap.get(name).slice().sort((a, b) => a.start - b.start);
          this._container.appendChild(this._buildGroup(instances, false));
        }
      }
    }

    if (this._selectedId) this.highlightRow(this._selectedId);
    this._updateMultiVisual();
    this._updateBulkToolbar();
  }

  highlightRow(labelId) {
    this._selectedId = labelId || null;
    for (const c of this._container.querySelectorAll('.label-instance.selected')) {
      c.classList.remove('selected');
    }
    if (labelId && this._multiSelectedIds.size === 0) {
      const inst = this._cardMap.get(labelId);
      if (inst) {
        this._autoExpand(inst);
        inst.classList.add('selected');
        inst.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }

  highlightHover(labelId) {
    for (const c of this._container.querySelectorAll('.label-instance.highlighted')) {
      c.classList.remove('highlighted');
    }
    if (labelId) {
      const inst = this._cardMap.get(labelId);
      if (inst) {
        this._autoExpand(inst);
        inst.classList.add('highlighted');
        inst.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }

  clearMultiSelection() {
    this._multiSelectedIds.clear();
    this._updateMultiVisual();
    this._updateBulkToolbar();
  }

  // ── Helpers for animated expand/collapse ──────────────────────────
  _setGroupOpenState(group, open, animate = false) {
    if (!group) return;
    const list = group.querySelector('.label-group-instances');
    if (!list) return;
    if (!animate) {
      // immediate (no transition)
      list.style.transition = 'none';
      list.style.overflow = 'hidden';
      if (open) {
        list.style.display = '';
        // keep expanded state stable by using explicit 'none' so CSS doesn't revert to max-height:0
        list.style.maxHeight = 'none';
        list.style.opacity = '1';
        group.classList.add('expanded');
        const key = group.dataset.groupKey; if (key) this._expandedGroups.add(key);
      } else {
        list.style.maxHeight = '0px';
        list.style.opacity = '0';
        group.classList.remove('expanded');
        const key = group.dataset.groupKey; if (key) this._expandedGroups.delete(key);
      }
      // clear the manual transition after a tick so future toggles use CSS transitions
      requestAnimationFrame(() => { list.style.transition = ''; });
      return;
    }
    if (open) this._expandGroupElement(group);
    else this._collapseGroupElement(group);
  }

  _expandGroupElement(group) {
    const list = group.querySelector('.label-group-instances');
    if (!list) return;
    // prepare
    list.style.overflow = 'hidden';
    // ensure it's visible to measure
    list.style.display = '';
    // measure
    const height = list.scrollHeight;
    // start from 0
    list.style.maxHeight = '0px';
    list.style.opacity = '0';
    // trigger transition to measured height
    requestAnimationFrame(() => {
      list.style.transition = 'max-height 220ms cubic-bezier(.2,.8,.2,1), opacity 160ms ease';
      list.style.maxHeight = height + 'px';
      list.style.opacity = '1';
    });
    const onEnd = (e) => {
      if (e.target !== list) return;
      if (e.propertyName === 'max-height') {
        // keep the element open by setting maxHeight to 'none' so CSS doesn't collapse it
        list.style.maxHeight = 'none';
        list.style.transition = '';
        list.removeEventListener('transitionend', onEnd);
      }
    };
    list.addEventListener('transitionend', onEnd);
    group.classList.add('expanded');
    const key = group.dataset.groupKey; if (key) this._expandedGroups.add(key);
  }

  _collapseGroupElement(group) {
    const list = group.querySelector('.label-group-instances');
    if (!list) return;
    // measure current height
    const height = list.scrollHeight || list.offsetHeight || 0;
    list.style.overflow = 'hidden';
    // Ensure current height set as start point for transition
    list.style.maxHeight = height + 'px';
    list.style.opacity = '1';
    requestAnimationFrame(() => {
      list.style.transition = 'max-height 180ms cubic-bezier(.2,.8,.2,1), opacity 120ms ease';
      list.style.maxHeight = '0px';
      list.style.opacity = '0';
    });
    const onEnd = (e) => {
      if (e.target !== list) return;
      if (e.propertyName === 'max-height') {
        list.style.transition = '';
        // keep maxHeight at 0 to remain collapsed
        list.style.maxHeight = '0px';
        group.classList.remove('expanded');
        list.removeEventListener('transitionend', onEnd);
      }
    };
    list.addEventListener('transitionend', onEnd);
    const key = group.dataset.groupKey; if (key) this._expandedGroups.delete(key);
  }

  _autoExpand(inst) {
    const group = inst.closest('.label-group');
    if (group && !group.classList.contains('expanded')) {
      // Ensure parent set body is visible so measurements work
      const setBody = inst.closest('.label-set-body');
      if (setBody && setBody.style.maxHeight === '0px') {
        setBody.style.maxHeight = 'none';
        setBody.style.opacity = '1';
        setBody.style.overflow = 'visible';
        const sec = setBody.closest('.label-set-section');
        if (sec) sec.classList.add('expanded');
      }
      // If accordion enabled, close other expanded groups first — but
      // suppress this behavior when there is an active multi-selection
      // (user marked labels across groups) so their selections don't
      // force-collapse unrelated groups.
      if (this._accordion) {
        if (this._multiSelectedIds.size === 0) {
          const others = this._container.querySelectorAll('.label-group.expanded');
          for (const og of others) {
            if (og === group) continue;
            this._collapseGroupElement(og);
          }
          this._expandedGroups.clear();
        } else {
          // keep existing expanded groups when multiple labels are selected
        }
      }
      this._setGroupOpenState(group, true, true);
    }
    // Note: setBody visibility handled above
  }

  _updateMultiVisual() {
    const anySelected = this._multiSelectedIds.size > 0;
    for (const [id, el] of this._cardMap) {
      const multiSelected = this._multiSelectedIds.has(id);
      el.classList.toggle('multi-selected', multiSelected);
      el.classList.toggle('multi-active', anySelected);
      if (anySelected) {
        el.classList.remove('selected');
      } else if (id === this._selectedId) {
        el.classList.add('selected');
      }
      const cb = /** @type {HTMLInputElement|null} */ (el.querySelector('.label-instance-cb'));
      if (cb) cb.checked = multiSelected;
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
      const bar = document.createElement('div');
      bar.className = 'label-multi-toolbar';
      const scroll = this._container.closest('.label-list-scroll');
      const parent = scroll ? scroll.parentElement : this._container.parentElement;
      if (scroll) parent.insertBefore(bar, scroll);
      else parent.insertBefore(bar, this._container);
      this._bulkToolbar = bar;
    }
    this._bulkToolbar.innerHTML = '';
    const info = document.createElement('span');
    info.className = 'label-multi-info';
    info.textContent = `${count} selected`;
    this._bulkToolbar.appendChild(info);
    const editableIds = [...this._multiSelectedIds].filter(id => !this._lockedIds.has(id));
    if (this._onBulkEdit && editableIds.length > 0) {
      const btn = document.createElement('button');
      btn.className = 'tb-btn';
      btn.textContent = editableIds.length < count
        ? `Rename ${editableIds.length} editable`
        : 'Rename selected';
      btn.addEventListener('click', () => this._onBulkEdit(editableIds));
      this._bulkToolbar.appendChild(btn);
    }
    const clrBtn = document.createElement('button');
    clrBtn.className = 'tb-btn';
    clrBtn.textContent = 'Deselect all';
    clrBtn.addEventListener('click', () => this.clearMultiSelection());
    this._bulkToolbar.appendChild(clrBtn);
  }

  // ── Annotation set section ──────────────────────────────────────────

  _buildSetSection(setInfo, setKey, totalCount, buildBody, locked = false) {
    const section = document.createElement('div');
    section.className = 'label-set-section';
    if (locked) section.classList.add('label-set-section--locked');

    const isExpanded = this._expandedSets.has(setKey) !== false;  // expanded by default
    if (!this._expandedSets.has(setKey + '__init')) {
      this._expandedSets.add(setKey);
      this._expandedSets.add(setKey + '__init');
    }
    const expanded = this._expandedSets.has(setKey);

    // ── Set header ──
    const hdr = document.createElement('div');
    hdr.className = 'label-set-header';

    const chevron = document.createElement('span');
    chevron.className = 'label-set-chevron';
    chevron.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
    hdr.appendChild(chevron);

    const nameWrap = document.createElement('div');
    nameWrap.className = 'label-set-name-wrap';

    // Name row: origin badge + name + optional link
    const origin = setInfo?.origin || 'manual';
    const nameRow = document.createElement('div');
    nameRow.className = 'label-set-name-row';

    const originBadge = document.createElement('span');
    originBadge.className = `label-set-origin-badge label-set-origin--${origin.replace(/[^a-z]/gi, '-').toLowerCase()}`;
    originBadge.textContent = origin === 'xeno-canto' ? 'XC' : origin === 'BirdNET' ? 'BN' : 'manual';
    originBadge.title = origin;
    nameRow.appendChild(originBadge);

    const nameEl = document.createElement('span');
    nameEl.className = 'label-set-name';
    nameEl.textContent = setInfo?.name || 'Annotation set';
    nameEl.title = 'Click to inline-edit name';
    nameRow.appendChild(nameEl);

    // Allow clicking the set name to inline-edit the set name (behaves like group-level edit)
    nameEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this._onRenameSet || locked) return;
      if (nameEl.querySelector('input')) return;
      const oldName = setInfo?.name || '';
      const inp = document.createElement('input');
      inp.className = 'inline-name-input';
      inp.value = oldName;
      inp.style.cssText = 'max-width:120px;font-size:11px;';
      nameEl.textContent = '';
      nameEl.appendChild(inp);
      inp.focus(); inp.select();
      const commit = () => {
        const val = inp.value.trim();
        if (val && val !== oldName) this._onRenameSet(setKey, val);
        nameEl.textContent = val || oldName;
      };
      inp.addEventListener('blur', commit);
      inp.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        if (ev.key === 'Escape') { ev.preventDefault(); nameEl.textContent = oldName; }
      });
      inp.addEventListener('click', (ev) => ev.stopPropagation());
    });

    if (setInfo?.uri) {
      const link = document.createElement('a');
      link.href = setInfo.uri;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'label-set-link';
      link.title = 'Open on Xeno-canto';
      link.textContent = '↗';
      nameRow.appendChild(link);
    }
    nameWrap.appendChild(nameRow);

    const meta = document.createElement('div');
    meta.className = 'label-set-meta';
    if (setInfo?.creator) {
      const cr = document.createElement('span');
      cr.className = 'label-set-creator';
      cr.textContent = setInfo.creator;
      meta.appendChild(cr);
    }
    if (setInfo?.license) {
      const lic = document.createElement('span');
      lic.className = 'label-set-license';
      lic.textContent = setInfo.license;
      lic.style.background = licenseColor(setInfo.license) + '22';
      lic.style.color = licenseColor(setInfo.license);
      meta.appendChild(lic);
    }
    nameWrap.appendChild(meta);
    hdr.appendChild(nameWrap);

    const count = document.createElement('span');
    count.className = 'label-set-count';
    count.textContent = String(totalCount);
    hdr.appendChild(count);

    // ── Set action buttons (hover-visible) ──
    const setActions = document.createElement('div');
    setActions.className = 'label-set-actions';

    if (this._onConvertSetToManual && setInfo?.origin === 'xeno-canto') {
      const convBtn = document.createElement('button');
      convBtn.className = 'act-btn label-set-action-btn';
      convBtn.title = 'Convert to manual set';
      convBtn.textContent = '⇄';
      convBtn.addEventListener('click', (e) => { e.stopPropagation(); this._onConvertSetToManual(setKey); });
      setActions.appendChild(convBtn);
    }
    if (this._onToggleLockSet) {
      const lockBtn = document.createElement('button');
      lockBtn.className = 'act-btn label-set-action-btn label-set-lock-btn';
      lockBtn.title = locked ? 'Unlock set (allow editing)' : 'Lock set (prevent editing)';
      lockBtn.innerHTML = locked
        ? '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="3" y="7" width="10" height="8" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></svg>'
        : '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="3" y="7" width="10" height="8" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0"/></svg>';
      if (locked) lockBtn.classList.add('label-set-lock-btn--locked');
      lockBtn.addEventListener('click', (e) => { e.stopPropagation(); this._onToggleLockSet(setKey, !locked); });
      setActions.appendChild(lockBtn);
    }
    if (this._onRenameSet && !locked) {
      const renBtn = document.createElement('button');
      renBtn.className = 'act-btn label-set-action-btn';
      renBtn.title = 'Rename set';
      renBtn.textContent = '✎';
      renBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const nameSpan = hdr.querySelector('.label-set-name');
        if (!nameSpan || nameSpan.querySelector('input')) return;
        const oldName = setInfo?.name || '';
        const inp = document.createElement('input');
        inp.className = 'inline-name-input';
        inp.value = oldName;
        inp.style.cssText = 'max-width:120px;font-size:11px;';
        nameSpan.textContent = '';
        nameSpan.appendChild(inp);
        inp.focus(); inp.select();
        const commit = () => {
          const val = inp.value.trim();
          if (val && val !== oldName) this._onRenameSet(setKey, val);
          nameSpan.textContent = val || oldName;
        };
        inp.addEventListener('blur', commit);
        inp.addEventListener('keydown', (ev) => {
          ev.stopPropagation();
          if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
          if (ev.key === 'Escape') { ev.preventDefault(); nameSpan.textContent = oldName; }
        });
        inp.addEventListener('click', (ev) => ev.stopPropagation());
      });
      setActions.appendChild(renBtn);
    }
    const _deletable = this._onDeleteSet && (this._canDeleteSet ? this._canDeleteSet(setKey) : true);
    if (_deletable) {
      const delBtn = document.createElement('button');
      delBtn.className = 'act-btn label-set-action-btn danger';
      delBtn.title = 'Delete set (labels remain without a set)';
      delBtn.textContent = '×';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Delete set "${setInfo?.name || setKey}"? Labels will remain without a set.`)) {
          this._onDeleteSet(setKey);
        }
      });
      setActions.appendChild(delBtn);
    }
    if (setActions.children.length) hdr.appendChild(setActions);

    // Drag-over: accept label cards dropped onto this set header (not for locked sets)
    if (this._onAssignSet && !locked) {
      hdr.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; hdr.classList.add('drag-over'); });
      hdr.addEventListener('dragleave', (e) => { if (!hdr.contains(e.relatedTarget)) hdr.classList.remove('drag-over'); });
      hdr.addEventListener('drop', (e) => {
        e.preventDefault();
        hdr.classList.remove('drag-over');
        const labelId = e.dataTransfer.getData('text/label-id');
        if (labelId) this._onAssignSet(labelId, setKey);
      });
    }

    section.appendChild(hdr);

    // ── Collapsible body ──
    const body = document.createElement('div');
    body.className = 'label-set-body';
    section.classList.toggle('expanded', expanded);

    // Build group content lazily on first expand
    let built = false;
    const ensureBuilt = () => {
      if (built) return;
      built = true;
      body.appendChild(buildBody());
    };

    // Set initial state without animation
    if (expanded) {
      ensureBuilt();
      body.style.maxHeight = 'none';
      body.style.opacity = '1';
      body.style.overflow = 'visible';
    } else {
      body.style.maxHeight = '0px';
      body.style.opacity = '0';
      body.style.overflow = 'hidden';
    }

    const expandSet = () => {
      ensureBuilt();
      body.style.overflow = 'hidden';
      body.style.display = '';
      const height = body.scrollHeight;
      body.style.maxHeight = '0px';
      body.style.opacity = '0';
      requestAnimationFrame(() => {
        body.style.transition = 'max-height 260ms cubic-bezier(.2,.8,.2,1), opacity 180ms ease';
        body.style.maxHeight = height + 'px';
        body.style.opacity = '1';
      });
      const onEnd = (e) => {
        if (e.target !== body || e.propertyName !== 'max-height') return;
        body.style.maxHeight = 'none';
        body.style.overflow = 'visible';
        body.style.transition = '';
        body.removeEventListener('transitionend', onEnd);
      };
      body.addEventListener('transitionend', onEnd);
      section.classList.add('expanded');
      this._expandedSets.add(setKey);
    };

    const collapseSet = () => {
      const height = body.scrollHeight || body.offsetHeight || 0;
      body.style.overflow = 'hidden';
      body.style.maxHeight = height + 'px';
      body.style.opacity = '1';
      requestAnimationFrame(() => {
        body.style.transition = 'max-height 200ms cubic-bezier(.2,.8,.2,1), opacity 140ms ease';
        body.style.maxHeight = '0px';
        body.style.opacity = '0';
      });
      const onEnd = (e) => {
        if (e.target !== body || e.propertyName !== 'max-height') return;
        body.style.transition = '';
        body.removeEventListener('transitionend', onEnd);
      };
      body.addEventListener('transitionend', onEnd);
      section.classList.remove('expanded');
      this._expandedSets.delete(setKey);
    };

    hdr.addEventListener('click', () => {
      if (section.classList.contains('expanded')) collapseSet();
      else expandSet();
    });

    section.appendChild(body);
    return section;
  }

  // ── Species group builder ───────────────────────────────────────────

  _buildGroup(instances, locked = false) {
    const representative = instances[0];
    const { display, scientific } = this._resolveName(representative);
    const origin = representative.origin || 'manual';
    const groupKey = `${origin}::${representative.label || '(unlabeled)'}`;

    const group = document.createElement('div');
    group.className = 'label-group';
    // expose group key so we can find/close groups later (used by accordion behaviour)
    group.dataset.groupKey = groupKey;

    const row = document.createElement('div');
    row.className = 'label-group-row';

    const chevron = document.createElement('span');
    chevron.className = 'label-group-chevron';
    chevron.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
    row.appendChild(chevron);

    // Bird thumbnail — shown once per species group, not per instance
    const sciName = representative.scientificName || scientific || null;
    if (sciName) {
      const imgWrap = document.createElement('div');
      imgWrap.className = 'lbl-group-img-wrap';
      const img = document.createElement('img');
      img.className = 'lbl-group-img';
      const imgSrc = `${BIRD_IMG_BASE}${encodeURIComponent(sciName)}.webp`;
      img.src = imgSrc;
      img.alt = sciName;
      img.loading = 'lazy';
      let imgFailed = false;
      img.addEventListener('error', () => { imgFailed = true; img.src = BIRD_IMG_FALLBACK; }, { once: true });
      imgWrap.appendChild(img);

      // Hover popover — larger preview
      const popover = document.createElement('div');
      popover.className = 'lbl-img-popover';
      const popImg = document.createElement('img');
      popImg.src = imgSrc;
      popImg.alt = sciName;
      popImg.addEventListener('error', () => { popImg.src = BIRD_IMG_FALLBACK; }, { once: true });
      const popCaption = document.createElement('span');
      popCaption.className = 'lbl-img-popover-caption';
      popCaption.textContent = sciName;
      popover.appendChild(popImg);
      popover.appendChild(popCaption);
      imgWrap.appendChild(popover);

      row.appendChild(imgWrap);
    } else if (representative.color) {
      const dot = document.createElement('span');
      dot.className = 'color-dot';
      dot.style.background = representative.color;
      row.appendChild(dot);
    }

    const nameEl = document.createElement('span');
    nameEl.className = 'label-group-name';
    nameEl.textContent = display;
    if (!locked) {
      nameEl.title = 'Click to inline-edit name';
      nameEl.addEventListener('click', (e) => {
        e.stopPropagation();
        this._startGroupInlineEdit(nameEl, instances, display);
      });
    }
    row.appendChild(nameEl);

    if (instances.length > 1) {
      const cnt = document.createElement('span');
      cnt.className = 'label-group-count';
      cnt.textContent = String(instances.length);
      row.appendChild(cnt);
    }

    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    row.appendChild(spacer);

    if (!locked) {
      const editBtn = document.createElement('button');
      editBtn.className = 'act-btn';
      editBtn.textContent = '✎';
      editBtn.title = instances.length > 1
        ? `Edit species for all ${instances.length} instances`
        : 'Edit species';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (instances.length > 1 && this._onBulkEdit) {
          this._onBulkEdit(instances.map((l) => l.id));
        } else {
          this._onEdit?.(representative.id);
        }
      });
      row.appendChild(editBtn);
    }

    // Drop a label instance onto a group row → rename to this species (not for locked sets)
    if (this._onAssignSpecies && !locked) {
      row.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes('text/label-id')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        row.classList.add('drag-over');
      });
      row.addEventListener('dragleave', (e) => {
        if (!row.contains(e.relatedTarget)) row.classList.remove('drag-over');
      });
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drag-over');
        const labelId = e.dataTransfer.getData('text/label-id');
        if (labelId) this._onAssignSpecies(labelId, representative);
      });
    }

    group.appendChild(row);

    if (scientific && scientific !== display) {
      const sciEl = document.createElement('div');
      sciEl.className = 'label-group-sci';
      sciEl.textContent = scientific;
      group.appendChild(sciEl);
    }

    const instanceList = document.createElement('div');
    instanceList.className = 'label-group-instances';

    for (const lbl of instances) {
      const inst = this._buildInstance(lbl, locked);
      instanceList.appendChild(inst);
      this._cardMap.set(lbl.id, inst);
    }

    const single = instances.length === 1;
    const shouldExpand = this._expandedGroups.has(groupKey) || single;
    group.appendChild(instanceList);
    // set initial open state (no animation)
    this._setGroupOpenState(group, shouldExpand, false);

    row.addEventListener('click', () => {
      const currentlyOpen = group.classList.contains('expanded');
      if (!currentlyOpen) {
        if (this._accordion) {
          const others = this._container.querySelectorAll('.label-group.expanded');
          for (const og of others) {
            if (og === group) continue;
            this._collapseGroupElement(og);
          }
          this._expandedGroups.clear();
        }
      }
      this._setGroupOpenState(group, !currentlyOpen, true);
    });

    return group;
  }

  // ── Instance builder ────────────────────────────────────────────────

  _buildInstance(lbl, locked = false) {
    const inst = document.createElement('div');
    inst.className = 'label-instance';
    if (locked) inst.classList.add('label-instance--locked');
    inst.dataset.labelId = lbl.id;
    if (lbl.color) inst.style.setProperty('--lbl-color', lbl.color);

    // ── Drag to set ──
    if (this._onAssignSet && !locked) {
      inst.draggable = true;
      inst.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/label-id', lbl.id);
        e.dataTransfer.effectAllowed = 'move';
        inst.classList.add('dragging');
      });
      inst.addEventListener('dragend', () => inst.classList.remove('dragging'));
    }

    // ── Content wrapper ──
    const content = document.createElement('div');
    content.className = 'lbl-content';

    inst.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const items = locked
        ? [{ label: 'Locked — unlock set to edit', disabled: true }]
        : [
            {
              label: 'Rename',
              icon: '<svg viewBox="0 0 16 16"><path d="M11.5 2.5l2 2L5 13H3v-2L11.5 2.5z"/></svg>',
              action: () => this._onEdit?.(lbl.id),
            },
            { separator: true },
            {
              label: 'Delete',
              icon: '<svg viewBox="0 0 16 16"><polyline points="3,4 13,4"/><path d="M6,4V2h4v2M5,4v9a1,1,0,0,0,1,1h4a1,1,0,0,0,1-1V4"/></svg>',
              action: () => this._onRemove?.(lbl),
              danger: true,
            },
          ];
      showContextMenu({ x: e.clientX, y: e.clientY, items });
    });

    inst.addEventListener('click', (e) => {
      if (e.target.closest('.act-btn') || e.target.closest('select') || e.target.closest('input') || e.target.closest('.esel')) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (!this._lockedIds.has(lbl.id)) {
          if (this._multiSelectedIds.size === 0 && this._selectedId && this._selectedId !== lbl.id) {
            this._multiSelectedIds.add(this._selectedId);
          }
          if (this._multiSelectedIds.has(lbl.id)) this._multiSelectedIds.delete(lbl.id);
          else this._multiSelectedIds.add(lbl.id);
          this._updateMultiVisual();
          this._updateBulkToolbar();
        }
        return;
      }
      if (this._multiSelectedIds.size > 0) {
        this._multiSelectedIds.clear();
        this._updateMultiVisual();
        this._updateBulkToolbar();
      }
      this._onSeek?.(lbl);
      this.highlightRow(lbl.id);
      this._onFocus?.(lbl.id, 'list');
    });
    inst.addEventListener('pointerenter', () => this._onHover?.(lbl.id, true));
    inst.addEventListener('pointerleave', () => this._onHover?.(lbl.id, false));

    // ── Header row (inside content wrapper) ──
    const header = document.createElement('div');
    header.className = 'label-instance-header';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'label-instance-cb';
    cb.title = 'Ctrl+click or check to multi-select';
    cb.checked = this._multiSelectedIds.has(lbl.id);
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      if (cb.checked) {
        if (this._multiSelectedIds.size === 0 && this._selectedId && this._selectedId !== lbl.id) {
          this._multiSelectedIds.add(this._selectedId);
        }
        this._multiSelectedIds.add(lbl.id);
      } else {
        this._multiSelectedIds.delete(lbl.id);
      }
      this._updateMultiVisual();
      this._updateBulkToolbar();
    });
    cb.addEventListener('click', (e) => e.stopPropagation());
    header.appendChild(cb);

    // Time + freq meta
    const meta = document.createElement('div');
    meta.className = 'label-instance-meta';
    const timeEl = document.createElement('span');
    timeEl.className = 'lbl-time';
    timeEl.textContent = `${fmt(lbl.start)} – ${fmt(lbl.end)}`;
    const freqEl = document.createElement('span');
    freqEl.className = 'lbl-freq';
    freqEl.textContent = `${fmtFreq(lbl.freqMin)} – ${fmtFreq(lbl.freqMax)} Hz`;
    meta.appendChild(timeEl);
    meta.appendChild(freqEl);
    header.appendChild(meta);

    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    header.appendChild(spacer);

    // Actions (hidden until hover; suppressed when set is locked)
    const actions = document.createElement('div');
    actions.className = 'label-instance-actions';

    if (!locked) {
      const speciesBtn = document.createElement('button');
      speciesBtn.className = 'act-btn species-edit-btn';
      speciesBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41 11 3 3 11l8 8 9.59-5.59z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>';
      speciesBtn.title = 'Change species for this label';
      speciesBtn.addEventListener('click', (e) => { e.stopPropagation(); this._onEdit?.(lbl.id); });
      actions.appendChild(speciesBtn);

      const propsBtn = document.createElement('button');
      propsBtn.className = 'act-btn props-btn';
      propsBtn.title = 'Edit in Properties tab';
      propsBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
      propsBtn.addEventListener('click', (e) => { e.stopPropagation(); this._onEdit?.(lbl.id); });
      actions.appendChild(propsBtn);

      if (this._onOpenRefCalls) {
        const refBtn = document.createElement('button');
        refBtn.className = 'act-btn';
        refBtn.title = 'Reference Calls';
        refBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
        refBtn.addEventListener('click', (e) => { e.stopPropagation(); this._onOpenRefCalls(lbl); });
        actions.appendChild(refBtn);
      }

      const delBtn = document.createElement('button');
      delBtn.className = 'act-btn danger';
      delBtn.textContent = '×';
      delBtn.title = 'Remove';
      delBtn.addEventListener('click', (e) => { e.stopPropagation(); this._onRemove?.(lbl); });
      actions.appendChild(delBtn);
    }

    header.appendChild(actions);
    content.appendChild(header);

    // ── Confidence bar (when available — replaces confidence pill) ──
    if (lbl.confidence != null) {
      const confPct = Math.min(100, Math.round(Number(lbl.confidence) * 100));
      const confRow = document.createElement('div');
      confRow.className = 'lbl-conf-row';
      confRow.innerHTML = `
        <div class="lbl-conf-bar-track" role="progressbar"
             aria-valuenow="${confPct}" aria-valuemin="0" aria-valuemax="100">
          <div class="lbl-conf-bar-fill" style="width:${confPct}%"></div>
        </div>
        <span class="lbl-conf-pct">${confPct}%</span>`;
      content.appendChild(confRow);
    }

    // ── Tag pills row (always visible) ──
    const tagsEl = this._buildTagPills(lbl);
    content.appendChild(tagsEl);

    inst.appendChild(content);

    inst.addEventListener('dblclick', (e) => {
      if (locked) return;
      if (e.target.closest('.act-btn') || e.target.closest('input') || e.target.closest('select') || e.target.closest('.esel')) return;
      e.stopPropagation();
      this._onEdit?.(lbl.id);
    });

    return inst;
  }

  // ── Tag pills (always-visible key tags) ────────────────────────────

  _buildTagPills(lbl) {
    const el = document.createElement('div');
    el.className = 'label-instance-tags';
    const tags = lbl.tags || {};

    const SEX_ICONS = { male: '♂', female: '♀' };
    const sex = tags.sex;
    if (sex) {
      const p = document.createElement('span');
      p.className = `lbl-pill lbl-pill--sex lbl-pill--sex-${sex.toLowerCase().replace(/\s+/g, '-')}`;
      p.textContent = (SEX_ICONS[sex.toLowerCase()] || '') + ' ' + sex;
      el.appendChild(p);
    }

    const lifeStage = tags.lifeStage;
    if (lifeStage) {
      const p = document.createElement('span');
      p.className = 'lbl-pill lbl-pill--stage';
      p.textContent = lifeStage;
      el.appendChild(p);
    }

    const soundType = tags.soundType;
    if (soundType) {
      const p = document.createElement('span');
      p.className = 'lbl-pill lbl-pill--sound';
      p.textContent = soundType;
      el.appendChild(p);
    }

    // Custom tags (not preset, not set-level)
    const custom = Object.entries(tags).filter(([k]) => !PRESET_KEYS.has(k) && !SET_TAG_KEYS.has(k)
      && k !== 'annotator' && k !== 'animalSeen' && k !== 'playbackUsed' && k !== 'remarks');
    for (const [k, v] of custom) {
      const p = document.createElement('span');
      p.className = 'lbl-pill lbl-pill--custom';
      p.textContent = `${k}: ${v}`;
      el.appendChild(p);
    }

    // confidence is shown as a bar in _buildInstance, not as a pill here

    return el;
  }

  // ── Expandable detail section ───────────────────────────────────────

  // ── Inline name editing (group-level) ──────────────────────────────

  _startGroupInlineEdit(nameEl, instances, displayName) {
    if (nameEl.querySelector('input') || nameEl.querySelector('.species-search-widget')) return;

    const applyName = ({ name, scientificName }) => {
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
      // Clicking away or pressing Escape restores display name
      const onBlur = () => {
        if (!nameEl.querySelector('.species-search-widget')) return;
        setTimeout(() => {
          if (nameEl.querySelector('.species-search-widget')) nameEl.textContent = displayName;
        }, 200);
      };
      widget.input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); nameEl.textContent = displayName; }
      });
      widget.input.addEventListener('blur', onBlur);
      widget.input.addEventListener('click', (e) => e.stopPropagation());
    } else {
      // Fallback: plain text input
      const input = document.createElement('input');
      input.className = 'inline-name-input';
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
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); nameEl.textContent = displayName; }
      });
      input.addEventListener('blur', commit);
      input.addEventListener('click', (e) => e.stopPropagation());
    }
  }

}
