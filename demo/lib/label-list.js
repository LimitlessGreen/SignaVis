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
import { createEditableSelect } from './editable-select.js';

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
  'CC0': '#6366f1', 'CC-BY-4.0': '#10b981', 'CC-BY-NC-4.0': '#f59e0b',
  'CC-BY-SA-4.0': '#3b82f6', 'CC-BY-NC-SA-4.0': '#ef4444',
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
    this._onConvertSetToManual = opts.onConvertSetToManual || null;
    /** @type {((anchor: HTMLElement, cb: function) => {el:HTMLElement,input:HTMLInputElement,destroy:function})|null} */
    this._speciesSearchFactory = opts.speciesSearchFactory || null;
    this._cardMap = new Map();
    this._esInstances = [];
    this._selectedId = null;
    /** @type {Set<string>} */
    this._multiSelectedIds = new Set();
    this._labels = [];
    /** @type {Set<string>} group keys that are expanded */
    this._expandedGroups = new Set();
    /** @type {Set<string>} annotation set keys that are expanded */
    this._expandedSets = new Set();
    /** @type {Set<string>} label ids whose detail section is open */
    this._detailOpenIds = new Set();
    /** @type {HTMLElement|null} */
    this._bulkToolbar = null;
  }

  set onRemove(fn) { this._onRemove = fn; }
  set onBulkEdit(fn) { this._onBulkEdit = fn; }
  set onMultiSelectionChange(fn) { this._onMultiSelectionChange = fn; }
  /** Provide or update the species search factory after construction. */
  setSpeciesSearchFactory(fn) { this._speciesSearchFactory = fn || null; }
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
    for (const es of this._esInstances) es.destroy();
    this._esInstances = [];
    this._container.innerHTML = '';
    this._cardMap = new Map();
    if (this._badgeEl) this._badgeEl.textContent = String(labels.length);
    this._emptyEl.style.display = labels.length ? 'none' : '';

    const ORIGIN_ORDER = { manual: 0, BirdNET: 1, 'xeno-canto': 2 };
    const setsRegistry = this._getSets ? this._getSets() : new Map();

    // 2-level: setKey → {setInfo, origin, nameMap}
    // Labels with no set are grouped into a virtual '' key (rendered without a set header)
    /** @type {Map<string, {setInfo: any, origin: string, nameMap: Map<string, any[]>}>} */
    const setGroups = new Map();

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
        const setSection = this._buildSetSection(setInfo, setKey, totalInSet, () => {
          const frag = document.createDocumentFragment();
          for (const name of names) {
            const instances = nameMap.get(name).slice().sort((a, b) => a.start - b.start);
            frag.appendChild(this._buildGroup(instances));
          }
          return frag;
        });
        this._container.appendChild(setSection);
      } else {
        for (const name of names) {
          const instances = nameMap.get(name).slice().sort((a, b) => a.start - b.start);
          this._container.appendChild(this._buildGroup(instances));
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
      if (setBody && setBody.hidden) {
        setBody.hidden = false;
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
    if (this._onBulkEdit) {
      const btn = document.createElement('button');
      btn.className = 'tb-btn';
      btn.textContent = 'Rename selected';
      btn.addEventListener('click', () => this._onBulkEdit([...this._multiSelectedIds]));
      this._bulkToolbar.appendChild(btn);
    }
    const clrBtn = document.createElement('button');
    clrBtn.className = 'tb-btn';
    clrBtn.textContent = 'Deselect all';
    clrBtn.addEventListener('click', () => this.clearMultiSelection());
    this._bulkToolbar.appendChild(clrBtn);
  }

  // ── Annotation set section ──────────────────────────────────────────

  _buildSetSection(setInfo, setKey, totalCount, buildBody) {
    const section = document.createElement('div');
    section.className = 'label-set-section';

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
    chevron.textContent = '▸';
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
      if (!this._onRenameSet) return;
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
    if (this._onRenameSet) {
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
    if (this._onDeleteSet) {
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

    // Drag-over: accept label cards dropped onto this set header
    if (this._onAssignSet) {
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
    body.hidden = !expanded;
    section.classList.toggle('expanded', expanded);

    // Build group content lazily on first expand
    let built = false;
    const ensureBuilt = () => {
      if (built) return;
      built = true;
      body.appendChild(buildBody());
    };
    if (expanded) ensureBuilt();

    hdr.addEventListener('click', () => {
      const wasExpanded = !body.hidden;
      body.hidden = wasExpanded;
      section.classList.toggle('expanded', !wasExpanded);
      if (!wasExpanded) {
        ensureBuilt();
        this._expandedSets.add(setKey);
      } else {
        this._expandedSets.delete(setKey);
      }
    });

    section.appendChild(body);
    return section;
  }

  // ── Species group builder ───────────────────────────────────────────

  _buildGroup(instances) {
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
    chevron.textContent = '▸';
    row.appendChild(chevron);

    if (representative.color) {
      const dot = document.createElement('span');
      dot.className = 'color-dot';
      dot.style.background = representative.color;
      row.appendChild(dot);
    }

    const nameEl = document.createElement('span');
    nameEl.className = 'label-group-name';
    nameEl.textContent = display;
    nameEl.title = 'Click to inline-edit name';
    nameEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this._startGroupInlineEdit(nameEl, instances, display);
    });
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
      const inst = this._buildInstance(lbl);
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

  _buildInstance(lbl) {
    const inst = document.createElement('div');
    inst.className = 'label-instance';
    inst.dataset.labelId = lbl.id;
    // Color left border via CSS variable
    if (lbl.color) inst.style.setProperty('--lbl-color', lbl.color);

    // ── Drag to set ──
    if (this._onAssignSet) {
      inst.draggable = true;
      inst.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/label-id', lbl.id);
        e.dataTransfer.effectAllowed = 'move';
        inst.classList.add('dragging');
      });
      inst.addEventListener('dragend', () => inst.classList.remove('dragging'));
    }

    inst.addEventListener('click', (e) => {
      if (e.target.closest('.act-btn') || e.target.closest('select') || e.target.closest('input') || e.target.closest('.esel')) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (this._multiSelectedIds.size === 0 && this._selectedId && this._selectedId !== lbl.id) {
          this._multiSelectedIds.add(this._selectedId);
        }
        if (this._multiSelectedIds.has(lbl.id)) this._multiSelectedIds.delete(lbl.id);
        else this._multiSelectedIds.add(lbl.id);
        this._updateMultiVisual();
        this._updateBulkToolbar();
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

    // ── Header row ──
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

    // Actions (hidden until hover)
    const actions = document.createElement('div');
    actions.className = 'label-instance-actions';

    const speciesBtn = document.createElement('button');
    speciesBtn.className = 'act-btn species-edit-btn';
    // Use inline SVG for consistent styling with other action icons
    speciesBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41 11 3 3 11l8 8 9.59-5.59z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>';
    speciesBtn.title = 'Change species for this label';
    speciesBtn.addEventListener('click', (e) => { e.stopPropagation(); this._onEdit?.(lbl.id); });
    actions.appendChild(speciesBtn);

    const editToggle = document.createElement('button');
    editToggle.className = 'act-btn edit-toggle';
    editToggle.title = 'Edit tags';
    editToggle.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
    actions.appendChild(editToggle);

    const delBtn = document.createElement('button');
    delBtn.className = 'act-btn danger';
    delBtn.textContent = '×';
    delBtn.title = 'Remove';
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); this._onRemove?.(lbl); });
    actions.appendChild(delBtn);

    header.appendChild(actions);
    inst.appendChild(header);

    // ── Tag pills row (always visible) ──
    const tagsEl = this._buildTagPills(lbl);
    inst.appendChild(tagsEl);

    // ── Expandable detail ──
    const detail = this._buildDetail(lbl);
    const isOpen = this._detailOpenIds.has(lbl.id);
    detail.style.display = isOpen ? '' : 'none';
    tagsEl.style.display = isOpen ? 'none' : '';
    inst.classList.toggle('expanded', isOpen);
    inst.appendChild(detail);

    const toggleDetail = () => {
      const open = detail.style.display !== 'none';
      detail.style.display = open ? 'none' : '';
      tagsEl.style.display = open ? '' : 'none';
      inst.classList.toggle('expanded', !open);
      if (open) this._detailOpenIds.delete(lbl.id);
      else this._detailOpenIds.add(lbl.id);
    };

    editToggle.addEventListener('click', (e) => { e.stopPropagation(); toggleDetail(); });
    inst.addEventListener('dblclick', (e) => {
      if (e.target.closest('.act-btn') || e.target.closest('input') || e.target.closest('select') || e.target.closest('.esel')) return;
      e.stopPropagation();
      toggleDetail();
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

    if (lbl.confidence != null) {
      const p = document.createElement('span');
      p.className = 'lbl-pill lbl-pill--conf';
      p.textContent = Math.round(Number(lbl.confidence) * 100) + '%';
      el.appendChild(p);
    }

    return el;
  }

  // ── Expandable detail section ───────────────────────────────────────

  _buildDetail(lbl) {
    const detail = document.createElement('div');
    detail.className = 'label-card-detail';
    const store = this._tagStore;

    for (const preset of TAG_PRESETS) {
      const row = document.createElement('div');
      row.className = 'detail-row';
      const label = document.createElement('label');
      label.className = 'detail-label';
      label.textContent = preset.key;
      row.appendChild(label);

      const items = store
        ? store.getMerged(preset.key, preset.options)
        : preset.options.map((v) => ({ value: v, custom: false }));
      const es = createEditableSelect({
        placeholder: '–',
        value: lbl.tags?.[preset.key] || '',
        items,
        onChange: (val) => {
          if (!lbl.tags) lbl.tags = {};
          if (val) lbl.tags[preset.key] = val;
          else delete lbl.tags[preset.key];
          this._onSync();
        },
        onAdd: store ? (val) => store.add(preset.key, val) : undefined,
        onRemove: store ? (val) => store.remove(preset.key, val) : undefined,
        onRename: store ? (old, nw) => store.rename(preset.key, old, nw) : undefined,
      });
      es.el.addEventListener('click', (e) => e.stopPropagation());
      this._esInstances.push(es);
      row.appendChild(es.el);
      detail.appendChild(row);
    }

    // Annotator (read-only if from XC)
    if (lbl.author) {
      const row = document.createElement('div');
      row.className = 'detail-row detail-row--meta';
      const lbl2 = document.createElement('span');
      lbl2.className = 'detail-label';
      lbl2.textContent = 'annotator';
      const val = document.createElement('span');
      val.className = 'detail-value-muted';
      val.textContent = lbl.author;
      row.appendChild(lbl2);
      row.appendChild(val);
      detail.appendChild(row);
    }

    const customTags = document.createElement('div');
    customTags.className = 'detail-custom-tags';
    this._renderCustomTags(customTags, lbl);
    detail.appendChild(customTags);

    const addRow = document.createElement('div');
    addRow.className = 'detail-row';
    const addBtn = document.createElement('button');
    addBtn.className = 'tag-add-btn';
    addBtn.textContent = '+ Tag';
    addBtn.addEventListener('click', (e) => { e.stopPropagation(); this._showCustomTagPopover(customTags, lbl, addBtn); });
    addRow.appendChild(addBtn);
    detail.appendChild(addRow);

    return detail;
  }

  _renderCustomTags(container, lbl) {
    container.innerHTML = '';
    const tags = lbl.tags || {};
    const custom = Object.entries(tags).filter(([k]) => !PRESET_KEYS.has(k) && !SET_TAG_KEYS.has(k));
    for (const [k, v] of custom) {
      const badge = document.createElement('span');
      badge.className = 'label-tag-badge';
      const keySpan = document.createElement('span');
      keySpan.className = 'tag-key';
      keySpan.textContent = k;
      badge.appendChild(keySpan);
      badge.appendChild(document.createTextNode(': ' + v + ' '));
      const del = document.createElement('button');
      del.className = 'label-tag-badge-del';
      del.textContent = '×';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        delete lbl.tags[k];
        this._renderCustomTags(container, lbl);
        this._onSync();
      });
      badge.appendChild(del);
      container.appendChild(badge);
    }
  }

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

  // ── Custom tag popover ──────────────────────────────────────────────

  _showCustomTagPopover(customTagsContainer, lbl, anchorBtn) {
    document.querySelector('.tag-popover')?.remove();
    const pop = document.createElement('div');
    pop.className = 'tag-popover';
    pop.addEventListener('click', (e) => e.stopPropagation());

    const rect = anchorBtn.getBoundingClientRect();
    pop.style.left = rect.left + 'px';
    pop.style.top = (rect.bottom + 4) + 'px';
    requestAnimationFrame(() => {
      const pr = pop.getBoundingClientRect();
      if (pr.right > window.innerWidth - 8) pop.style.left = Math.max(8, window.innerWidth - pr.width - 8) + 'px';
      if (pr.bottom > window.innerHeight - 8) pop.style.top = Math.max(8, rect.top - pr.height - 4) + 'px';
    });

    const row = document.createElement('div');
    row.className = 'tag-pop-row';
    const keyInput = document.createElement('input');
    keyInput.placeholder = 'key';
    keyInput.style.width = '60px';
    const valInput = document.createElement('input');
    valInput.placeholder = 'value';
    valInput.style.flex = '1';
    const okBtn = document.createElement('button');
    okBtn.className = 'tag-add-btn';
    okBtn.textContent = '✓';

    const commitCustom = () => {
      const k = keyInput.value.trim();
      const v = valInput.value.trim();
      if (k && v) {
        if (!lbl.tags) lbl.tags = {};
        lbl.tags[k] = v;
        pop.remove();
        this._renderCustomTags(customTagsContainer, lbl);
        this._onSync();
      }
    };
    okBtn.addEventListener('click', (e) => { e.stopPropagation(); commitCustom(); });
    valInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commitCustom(); }
    });
    keyInput.addEventListener('keydown', (e) => e.stopPropagation());
    row.appendChild(keyInput);
    row.appendChild(valInput);
    row.appendChild(okBtn);
    pop.appendChild(row);

    const closeHandler = (e) => {
      if (!pop.contains(e.target) && e.target !== anchorBtn) {
        pop.remove();
        document.removeEventListener('pointerdown', closeHandler, true);
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', closeHandler, true), 0);
    document.body.appendChild(pop);
    keyInput.focus();
  }
}
