/**
 * Label table renderer — builds and updates the <tbody> for a label table.
 *
 * Handles: colour dots, stacked name/sci cells, inline name editing,
 * preset tag dropdowns (sex, lifeStage, soundType), custom tag badges
 * with popover, info cell, action buttons.
 *
 * Usage:
 *   import { LabelTable } from './lib/label-table.js';
 *   const table = new LabelTable({
 *     tbody: document.getElementById('labelsList'),
 *     emptyEl: document.getElementById('labelsEmpty'),
 *     badgeEl: document.getElementById('labelCount'),
 *     resolveName: (lbl) => ({ display, scientific }),
 *     onSync: () => syncToPlayer(),
 *     onSeek: (lbl) => player.currentTime = lbl.start,
 *     onEdit: (id) => player.spectrogramLabels._renameSpectrogramLabelPrompt(id),
 *     onFocus: (id) => player._emit('labelfocus', { id, source: 'table' }),
 *     onHover: (id, on) => highlightSpectrogramLabel(id, on),
 *     tagStore: customTagStore,  // optional CustomTagStore instance
 *   });
 *   table.render(labels);
 */

import { createEditableSelect } from '../components/editable-select/editable-select.ts';

/** Preset tag columns shown as inline `<select>` dropdowns. */
export const TAG_PRESETS = [
  { key: 'sex', options: ['male', 'female', 'unknown'] },
  { key: 'lifeStage', options: ['adult', 'juvenile', 'immature', 'subadult'] },
  { key: 'soundType', options: ['song', 'call', 'alarm call', 'flight call', 'begging call', 'drumming', 'nocturnal flight call'] },
];

const PRESET_KEYS = new Set(TAG_PRESETS.map((p) => p.key));

function fmt(sec: any) {
  return Number(sec).toFixed(2) + 's';
}

export class LabelTable {
    // TypeScript property declarations (migrated from JS)
    _badgeEl: any;
    _bulkToolbar: any;
    _emptyEl: any;
    _labels: any;
    _onEdit: any;
    _onFocus: any;
    _onHover: any;
    _onSeek: any;
    _onSync: any;
    _resolveName: any;
    _tagStore: any;
    _tbody: any;
    closest: any;
    _multiSelectedIds: any;
    _onBulkEdit: any;
    _onRemove: any;
    _rowMap: any;
    _selectedId: any;
  /**
   * @param {object} opts
   * @param {HTMLTableSectionElement} opts.tbody
   * @param {HTMLElement}   opts.emptyEl         "No labels" placeholder
   * @param {HTMLElement}   [opts.badgeEl]       Element for label count text
   * @param {(lbl: any) => {display: string, scientific: string}} opts.resolveName
   * @param {() => void}   opts.onSync          Called after any data mutation
   * @param {(lbl: any) => void} [opts.onSeek]
   * @param {(id: string) => void} [opts.onEdit]
   * @param {(id: string, source: string) => void} [opts.onFocus]
   * @param {(id: string, on: boolean) => void} [opts.onHover]
   */
  constructor(opts: any) {
    this._tbody = opts.tbody;
    this._emptyEl = opts.emptyEl;
    this._badgeEl = opts.badgeEl || null;
    this._resolveName = opts.resolveName;
    this._onSync = opts.onSync;
    this._onSeek = opts.onSeek;
    this._onEdit = opts.onEdit;
    this._onFocus = opts.onFocus;
    this._onHover = opts.onHover;
    this._onBulkEdit = opts.onBulkEdit || null;
    this._tagStore = opts.tagStore || null;
    this._rowMap = new Map();
    this._selectedId = null;
    /** @type {Set<string>} ids selected via Ctrl+Click for bulk actions */
    this._multiSelectedIds = new Set();
    this._labels = [];
    /** @type {HTMLElement|null} */
    this._bulkToolbar = null;
  }

  get rowMap() { return this._rowMap; }
  get selectedId() { return this._selectedId; }
  get multiSelectedIds() { return this._multiSelectedIds; }
  set onBulkEdit(fn: any) { this._onBulkEdit = fn; }

  /**
   * Full re-render of the table body.
   * @param {Array} labels
   */
  render(labels: any) {
    this._labels = labels;
    // Remove stale multi-selected ids
    const idSet = new Set(labels.map((l: any) => l.id));
    for (const id of this._multiSelectedIds) {
      if (!idSet.has(id)) this._multiSelectedIds.delete(id);
    }
    this._tbody.innerHTML = '';
    this._rowMap = new Map();
    const sorted = labels.slice().sort((a: any, b: any) => a.start - b.start);
    if (this._badgeEl) this._badgeEl.textContent = String(sorted.length);
    this._emptyEl.style.display = sorted.length ? 'none' : '';

    for (const lbl of sorted) {
      const { display: displayName, scientific: sci } = this._resolveName(lbl);
      const tr = document.createElement('tr');
      tr.dataset.labelId = lbl.id;
      this._rowMap.set(lbl.id, tr);

      tr.addEventListener('click', (e) => {
        if ((e.target as Element).closest('.act-btn') || (e.target as Element).closest('.esel')) return;
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          if (this._multiSelectedIds.has(lbl.id)) {
            this._multiSelectedIds.delete(lbl.id);
          } else {
            this._multiSelectedIds.add(lbl.id);
          }
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
        this._onFocus?.(lbl.id, 'table');
      });
      tr.addEventListener('pointerenter', () => this._onHover?.(lbl.id, true));
      tr.addEventListener('pointerleave', () => this._onHover?.(lbl.id, false));

      // 1) Color dot
      const tdDot = document.createElement('td');
      if (lbl.color) {
        const dot = document.createElement('span');
        dot.className = 'color-dot';
        dot.style.background = lbl.color;
        tdDot.appendChild(dot);
      }
      tr.appendChild(tdDot);

      // 2) Label — name + scientific stacked
      const tdLabel = document.createElement('td');
      tdLabel.className = 'label-cell';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'label-name';
      nameSpan.textContent = displayName;
      nameSpan.title = 'Click to edit';
      nameSpan.addEventListener('click', (e) => {
        e.stopPropagation();
        this._startInlineNameEdit(nameSpan, lbl, displayName);
      });
      tdLabel.appendChild(nameSpan);
      if (sci) {
        const sciSpan = document.createElement('span');
        sciSpan.className = 'label-sci';
        sciSpan.textContent = sci;
        tdLabel.appendChild(sciSpan);
      }
      tr.appendChild(tdLabel);

      // 3) Range — time + freq stacked
      const tdRange = document.createElement('td');
      tdRange.className = 'range-cell';
      const timeSpan = document.createElement('span');
      timeSpan.textContent = `${fmt(lbl.start)} – ${fmt(lbl.end)}`;
      tdRange.appendChild(timeSpan);
      const freqSpan = document.createElement('span');
      freqSpan.className = 'range-freq';
      freqSpan.textContent = `${Math.round(lbl.freqMin)}–${Math.round(lbl.freqMax)} Hz`;
      tdRange.appendChild(freqSpan);
      tr.appendChild(tdRange);

      // 4-6) Preset tag columns
      for (const preset of TAG_PRESETS) {
        const tdTag = document.createElement('td');
        tdTag.className = 'tag-select-cell';
        const store = this._tagStore;
        const items = store
          ? store.getMerged(preset.key, preset.options)
          : preset.options.map((v) => ({ value: v, custom: false }));
        const es = createEditableSelect({
          placeholder: '—',
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
          onRename: store ? (oldV, newV) => store.rename(preset.key, oldV, newV) : undefined,
        });
        es.el.addEventListener('click', (e) => e.stopPropagation());
        tdTag.appendChild(es.el);
        tr.appendChild(tdTag);
      }

      // 7) Custom tags
      const tdTags = document.createElement('td');
      tdTags.className = 'tags-cell';
      this._renderCustomTags(tdTags, lbl);
      tr.appendChild(tdTags);

      // 8) Info
      const tdInfo = document.createElement('td');
      tdInfo.className = 'info-cell';
      if (lbl.confidence != null) {
        const conf = document.createElement('span');
        conf.className = 'conf-val';
        conf.textContent = Number(lbl.confidence).toFixed(2);
        tdInfo.appendChild(conf);
      }
      const source = [lbl.origin, lbl.author].filter(Boolean).join(' · ');
      if (source) {
        const src = document.createElement('span');
        src.textContent = source;
        src.title = source;
        tdInfo.appendChild(src);
      }
      tr.appendChild(tdInfo);

      // 9) Actions
      const tdActions = document.createElement('td');
      tdActions.className = 'actions-cell';
      const editBtn = document.createElement('button');
      editBtn.className = 'act-btn';
      editBtn.textContent = '✎';
      editBtn.title = 'Edit (taxonomy search)';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._onEdit?.(lbl.id);
      });
      tdActions.appendChild(editBtn);
      const delBtn = document.createElement('button');
      delBtn.className = 'act-btn danger';
      delBtn.textContent = '×';
      delBtn.title = 'Remove label';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._onRemove?.(lbl);
      });
      tdActions.appendChild(delBtn);
      tr.appendChild(tdActions);

      this._tbody.appendChild(tr);
    }

    if (this._selectedId) this.highlightRow(this._selectedId);
    this._updateMultiVisual();
    this._updateBulkToolbar();
  }

  /** Bind a remove handler (called with the label object). */
  set onRemove(fn: any) { this._onRemove = fn; }

  clearMultiSelection() {
    this._multiSelectedIds.clear();
    this._updateMultiVisual();
    this._updateBulkToolbar();
  }

  _updateMultiVisual() {
    for (const [id, row] of this._rowMap) {
      row.classList.toggle('multi-selected', this._multiSelectedIds.has(id));
    }
  }

  _updateBulkToolbar() {
    const count = this._multiSelectedIds.size;
    if (count < 2) {
      if (this._bulkToolbar) {
        this._bulkToolbar.remove();
        this._bulkToolbar = null;
      }
      return;
    }

    if (!this._bulkToolbar) {
      const bar = document.createElement('div');
      bar.className = 'label-multi-toolbar';
      const table = this._tbody.closest('table');
      const parent = table ? table.parentElement : this._tbody.parentElement;
      if (table) parent.insertBefore(bar, table);
      else parent.insertBefore(bar, this._tbody);
      this._bulkToolbar = bar;
    }

    this._bulkToolbar.innerHTML = '';
    const info = document.createElement('span');
    info.className = 'label-multi-info';
    info.textContent = `${count} selected`;
    this._bulkToolbar.appendChild(info);

    if (this._onBulkEdit) {
      const renameBtn = document.createElement('button');
      renameBtn.className = 'tb-btn';
      renameBtn.textContent = 'Rename selected';
      renameBtn.addEventListener('click', () => {
        this._onBulkEdit([...this._multiSelectedIds]);
      });
      this._bulkToolbar.appendChild(renameBtn);
    }

    const clearBtn = document.createElement('button');
    clearBtn.className = 'tb-btn';
    clearBtn.textContent = 'Deselect all';
    clearBtn.addEventListener('click', () => this.clearMultiSelection());
    this._bulkToolbar.appendChild(clearBtn);
  }

  highlightRow(labelId: any) {
    this._selectedId = labelId || null;
    for (const row of this._tbody.querySelectorAll('tr.selected')) row.classList.remove('selected');
    if (labelId) {
      const tr = this._rowMap.get(labelId);
      if (tr) {
        tr.classList.add('selected');
        tr.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }

  highlightHover(labelId: any) {
    for (const row of this._tbody.querySelectorAll('tr.highlighted')) row.classList.remove('highlighted');
    if (labelId) {
      const tr = this._rowMap.get(labelId);
      if (tr) {
        tr.classList.add('highlighted');
        tr.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }

  // ── Private helpers ─────────────────────────────────────────────

  _startInlineNameEdit(nameSpan: any, lbl: any, displayName: any) {
    if (nameSpan.querySelector('input')) return;
    const input = document.createElement('input');
    input.className = 'inline-name-input';
    input.value = lbl.label || displayName;
    nameSpan.textContent = '';
    nameSpan.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
      const val = input.value.trim();
      if (val && val !== lbl.label) {
        lbl.label = val;
        lbl.scientificName = '';
        lbl.commonName = '';
        this._onSync({ structural: true });
      } else {
        nameSpan.textContent = displayName;
      }
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); nameSpan.textContent = displayName; }
    });
    input.addEventListener('blur', commit);
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  _renderCustomTags(td: any, lbl: any) {
    td.innerHTML = '';
    const tags = lbl.tags || {};
    const customEntries = Object.entries(tags).filter(([k]) => !PRESET_KEYS.has(k));

    for (const [k, v] of customEntries) {
      const badge = document.createElement('span');
      // Keep visual parity with the modal's tag pills
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
        if (!lbl.tags) return;
        delete lbl.tags[k];
        this._renderCustomTags(td, lbl);
        this._onSync();
      });
      badge.appendChild(del);
      td.appendChild(badge);
    }

    const addBtn = document.createElement('button');
    addBtn.className = 'tag-add-btn';
    addBtn.textContent = '+';
    addBtn.title = 'Add custom tag';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._showCustomTagPopover(td, lbl, addBtn);
    });
    td.appendChild(addBtn);
  }

  _showCustomTagPopover(td: any, lbl: any, anchorBtn: any) {
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

    const customRow = document.createElement('div');
    customRow.className = 'tag-pop-row';
    const keyInput = document.createElement('input');
    keyInput.placeholder = 'key';
    keyInput.style.width = '60px';
    const valInput = document.createElement('input');
    valInput.placeholder = 'value';
    valInput.style.flex = '1';
    const addCustom = document.createElement('button');
    addCustom.className = 'tag-add-btn';
    addCustom.textContent = '✓';
    const commitCustom = () => {
      const k = keyInput.value.trim();
      const v = valInput.value.trim();
      if (k && v) {
        if (!lbl.tags) lbl.tags = {};
        lbl.tags[k] = v;
        pop.remove();
        this._renderCustomTags(td, lbl);
        this._onSync();
      }
    };
    addCustom.addEventListener('click', (e) => { e.stopPropagation(); commitCustom(); });
    valInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commitCustom(); }
    });
    keyInput.addEventListener('keydown', (e) => e.stopPropagation());
    customRow.appendChild(keyInput);
    customRow.appendChild(valInput);
    customRow.appendChild(addCustom);
    pop.appendChild(customRow);

    const closeHandler = (e: any) => {
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
