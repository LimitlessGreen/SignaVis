/**
 * Compact card-based label list for sidebar display.
 *
 * Each label renders as a vertical card showing:
 *   • Color dot + name (inline-editable) + action buttons
 *   • Scientific name (italic, muted)
 *   • Time range + frequency range
 *   • Tag badges (preset + custom) + confidence
 *   • Expandable detail section (double-click) with tag dropdowns
 *
 * Usage:
 *   import { LabelList } from './lib/label-list.js';
 *   const list = new LabelList({
 *     container: document.getElementById('labelList'),
 *     emptyEl:   document.getElementById('labelsEmpty'),
 *     resolveName: (lbl) => ({ display, scientific }),
 *     onSync:  () => syncToPlayer(),
 *     onSeek:  (lbl) => player.currentTime = lbl.start,
 *     onEdit:  (id)  => player.spectrogramLabels._renameSpectrogramLabelPrompt(id),
 *     onFocus: (id)  => player._emit('labelfocus', { id, source: 'table' }),
 *     onHover: (id, on) => highlightLabel(id, on),
 *   });
 *   list.render(labels);
 */

import { TAG_PRESETS } from './label-table.js';

const PRESET_KEYS = new Set(TAG_PRESETS.map((p) => p.key));

function fmt(sec) {
  return Number(sec).toFixed(2) + 's';
}

export class LabelList {
  /**
   * @param {object} opts
   * @param {HTMLElement}  opts.container    Scrollable parent for label cards
   * @param {HTMLElement}  opts.emptyEl      "No labels" placeholder
   * @param {HTMLElement}  [opts.badgeEl]    Element for label count text
   * @param {(lbl: any) => {display: string, scientific: string}} opts.resolveName
   * @param {() => void}   opts.onSync
   * @param {(lbl: any) => void}  [opts.onSeek]
   * @param {(id: string) => void} [opts.onEdit]
   * @param {(id: string, source: string) => void} [opts.onFocus]
   * @param {(id: string, on: boolean) => void}     [opts.onHover]
   */
  constructor(opts) {
    this._container = opts.container;
    this._emptyEl = opts.emptyEl;
    this._badgeEl = opts.badgeEl || null;
    this._resolveName = opts.resolveName;
    this._onSync = opts.onSync;
    this._onSeek = opts.onSeek;
    this._onEdit = opts.onEdit;
    this._onFocus = opts.onFocus;
    this._onHover = opts.onHover;
    this._onRemove = null;
    this._cardMap = new Map();
    this._selectedId = null;
    this._labels = [];
  }

  set onRemove(fn) { this._onRemove = fn; }
  get selectedId() { return this._selectedId; }

  /** Full re-render of the label list, grouped by origin. */
  render(labels) {
    this._labels = labels;
    this._container.innerHTML = '';
    this._cardMap = new Map();
    const sorted = labels.slice().sort((a, b) => a.start - b.start);
    if (this._badgeEl) this._badgeEl.textContent = String(sorted.length);
    this._emptyEl.style.display = sorted.length ? 'none' : '';

    // Group by origin
    const ORDER = { manual: 0, BirdNET: 1, 'xeno-canto': 2 };
    /** @type {Map<string, any[]>} */
    const groups = new Map();
    for (const lbl of sorted) {
      const origin = lbl.origin || 'manual';
      if (!groups.has(origin)) groups.set(origin, []);
      /** @type {any[]} */ (groups.get(origin)).push(lbl);
    }
    const origins = [...groups.keys()].sort((a, b) =>
      (ORDER[a] ?? 99) - (ORDER[b] ?? 99) || a.localeCompare(b));

    // Only show headers when more than one origin is present
    const showHeaders = origins.length > 1;

    for (const origin of origins) {
      if (showHeaders) {
        const header = document.createElement('div');
        header.className = 'label-group-header';
        header.textContent = origin;
        this._container.appendChild(header);
      }
      for (const lbl of /** @type {any[]} */ (groups.get(origin))) {
        const card = this._buildCard(lbl);
        this._container.appendChild(card);
        this._cardMap.set(lbl.id, card);
      }
    }

    if (this._selectedId) this.highlightRow(this._selectedId);
  }

  highlightRow(labelId) {
    this._selectedId = labelId || null;
    for (const c of this._container.querySelectorAll('.label-card.selected')) {
      c.classList.remove('selected');
    }
    if (labelId) {
      const card = this._cardMap.get(labelId);
      if (card) {
        card.classList.add('selected');
        card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }

  highlightHover(labelId) {
    for (const c of this._container.querySelectorAll('.label-card.highlighted')) {
      c.classList.remove('highlighted');
    }
    if (labelId) {
      const card = this._cardMap.get(labelId);
      if (card) {
        card.classList.add('highlighted');
        card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }

  // ── Card builder ──────────────────────────────────────────────────

  _buildCard(lbl) {
    const { display, scientific } = this._resolveName(lbl);

    const card = document.createElement('div');
    card.className = 'label-card';
    card.dataset.labelId = lbl.id;

    card.addEventListener('click', () => {
      this._onSeek?.(lbl);
      this.highlightRow(lbl.id);
      this._onFocus?.(lbl.id, 'list');
    });
    card.addEventListener('pointerenter', () => this._onHover?.(lbl.id, true));
    card.addEventListener('pointerleave', () => this._onHover?.(lbl.id, false));

    // ── Header: dot + name + spacer + actions ──
    const header = document.createElement('div');
    header.className = 'label-card-header';

    if (lbl.color) {
      const dot = document.createElement('span');
      dot.className = 'color-dot';
      dot.style.background = lbl.color;
      header.appendChild(dot);
    }

    const nameEl = document.createElement('span');
    nameEl.className = 'label-card-name';
    nameEl.textContent = display;
    nameEl.title = 'Click to edit';
    nameEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this._startInlineEdit(nameEl, lbl, display);
    });
    header.appendChild(nameEl);

    const spacer = document.createElement('span');
    spacer.className = 'label-card-spacer';
    header.appendChild(spacer);

    const editBtn = document.createElement('button');
    editBtn.className = 'act-btn';
    editBtn.textContent = '✎';
    editBtn.title = 'Edit (taxonomy search)';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._onEdit?.(lbl.id);
    });
    header.appendChild(editBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'act-btn danger';
    delBtn.textContent = '×';
    delBtn.title = 'Remove label';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._onRemove?.(lbl);
    });
    header.appendChild(delBtn);

    card.appendChild(header);

    // ── Scientific name ──
    if (scientific) {
      const sciEl = document.createElement('div');
      sciEl.className = 'label-card-sci';
      sciEl.textContent = scientific;
      card.appendChild(sciEl);
    }

    // ── Meta: time + freq ──
    const meta = document.createElement('div');
    meta.className = 'label-card-meta';
    meta.textContent = `${fmt(lbl.start)} – ${fmt(lbl.end)}  ·  ${Math.round(lbl.freqMin)}–${Math.round(lbl.freqMax)} Hz`;
    card.appendChild(meta);

    // ── Tag badges ──
    const tagsEl = this._buildTagBadges(lbl);
    if (tagsEl.childNodes.length > 0) card.appendChild(tagsEl);

    // ── Expandable detail (tag editing) ──
    const detail = this._buildDetail(lbl);
    detail.style.display = 'none';
    card.appendChild(detail);

    card.addEventListener('dblclick', (e) => {
      if (e.target.closest('.act-btn') || e.target.closest('input') || e.target.closest('select')) return;
      e.stopPropagation();
      const open = detail.style.display !== 'none';
      detail.style.display = open ? 'none' : '';
      card.classList.toggle('expanded', !open);
    });

    return card;
  }

  // ── Tag badges line ───────────────────────────────────────────────

  _buildTagBadges(lbl) {
    const el = document.createElement('div');
    el.className = 'label-card-tags';
    const tags = lbl.tags || {};

    for (const preset of TAG_PRESETS) {
      if (tags[preset.key]) {
        const badge = document.createElement('span');
        badge.className = 'tag-mini';
        badge.textContent = tags[preset.key];
        el.appendChild(badge);
      }
    }

    const custom = Object.entries(tags).filter(([k]) => !PRESET_KEYS.has(k));
    for (const [k, v] of custom) {
      const badge = document.createElement('span');
      badge.className = 'tag-mini custom';
      badge.textContent = `${k}: ${v}`;
      el.appendChild(badge);
    }

    if (lbl.confidence != null) {
      const badge = document.createElement('span');
      badge.className = 'tag-mini conf';
      badge.textContent = Number(lbl.confidence).toFixed(2);
      el.appendChild(badge);
    }

    if (lbl.origin) {
      const badge = document.createElement('span');
      badge.className = 'tag-mini origin';
      badge.textContent = lbl.origin;
      el.appendChild(badge);
    }

    return el;
  }

  // ── Expandable detail section ─────────────────────────────────────

  _buildDetail(lbl) {
    const detail = document.createElement('div');
    detail.className = 'label-card-detail';

    for (const preset of TAG_PRESETS) {
      const row = document.createElement('div');
      row.className = 'detail-row';

      const label = document.createElement('label');
      label.className = 'detail-label';
      label.textContent = preset.key;
      row.appendChild(label);

      const sel = document.createElement('select');
      sel.className = 'detail-select';
      const emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = '—';
      sel.appendChild(emptyOpt);
      for (const val of preset.options) {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = val;
        sel.appendChild(opt);
      }
      sel.value = lbl.tags?.[preset.key] || '';
      sel.addEventListener('change', (e) => {
        e.stopPropagation();
        if (!lbl.tags) lbl.tags = {};
        if (sel.value) lbl.tags[preset.key] = sel.value;
        else delete lbl.tags[preset.key];
        this._onSync();
      });
      sel.addEventListener('click', (e) => e.stopPropagation());
      row.appendChild(sel);
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
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._showCustomTagPopover(customTags, lbl, addBtn);
    });
    addRow.appendChild(addBtn);
    detail.appendChild(addRow);

    return detail;
  }

  _renderCustomTags(container, lbl) {
    container.innerHTML = '';
    const tags = lbl.tags || {};
    const custom = Object.entries(tags).filter(([k]) => !PRESET_KEYS.has(k));
    for (const [k, v] of custom) {
      const badge = document.createElement('span');
      badge.className = 'tag-badge';
      const keySpan = document.createElement('span');
      keySpan.className = 'tag-key';
      keySpan.textContent = k;
      badge.appendChild(keySpan);
      badge.appendChild(document.createTextNode(': ' + v + ' '));
      const del = document.createElement('button');
      del.className = 'tag-del';
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

  // ── Inline name editing ───────────────────────────────────────────

  _startInlineEdit(nameEl, lbl, displayName) {
    if (nameEl.querySelector('input')) return;
    const input = document.createElement('input');
    input.className = 'inline-name-input';
    input.value = lbl.label || displayName;
    nameEl.textContent = '';
    nameEl.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
      const val = input.value.trim();
      if (val && val !== lbl.label) {
        lbl.label = val;
        lbl.scientificName = '';
        lbl.commonName = '';
        this._onSync();
      } else {
        nameEl.textContent = displayName;
      }
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); nameEl.textContent = displayName; }
    });
    input.addEventListener('blur', commit);
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  // ── Custom tag popover ────────────────────────────────────────────

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
