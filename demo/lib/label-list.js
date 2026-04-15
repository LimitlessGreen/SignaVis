/**
 * Hierarchical label list for sidebar display.
 *
 * Labels are grouped by origin (manual / BirdNET / xeno-canto) and then
 * by label name. Each name group renders as a collapsible tree node:
 *   • Color dot + name (inline-editable) + count badge + taxonomy-edit btn
 *   • Scientific name (italic, muted)
 *   • Expandable list of instances, each showing:
 *     – Time range + frequency range
 *     – Tag badges + confidence
 *     – Delete button
 *     – Double-click: inline tag editing
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
import { createEditableSelect } from './editable-select.js';

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
    this._tagStore = opts.tagStore || null;
    this._cardMap = new Map();
    this._esInstances = [];
    this._selectedId = null;
    this._labels = [];
    /** @type {Set<string>} group keys that are expanded */
    this._expandedGroups = new Set();
    /** @type {Set<string>} label ids whose detail section is open */
    this._detailOpenIds = new Set();
  }

  set onRemove(fn) { this._onRemove = fn; }
  get selectedId() { return this._selectedId; }

  /** Update only the tag-badges of a specific label instance (no full re-render). */
  updateBadges(labelId, lbl) {
    const inst = this._cardMap.get(labelId);
    if (!inst) return;
    const oldBadges = inst.querySelector('.label-card-tags');
    if (oldBadges) {
      const newBadges = this._buildTagBadges(lbl);
      // Keep hidden if detail is open
      if (this._detailOpenIds.has(labelId)) newBadges.style.display = 'none';
      oldBadges.replaceWith(newBadges);
    }
  }

  /** Full re-render — groups labels by origin, then by name. */
  render(labels) {
    this._labels = labels;
    // Destroy old EditableSelect instances (removes portal dropdowns + listeners)
    for (const es of this._esInstances) es.destroy();
    this._esInstances = [];
    this._container.innerHTML = '';
    this._cardMap = new Map();
    if (this._badgeEl) this._badgeEl.textContent = String(labels.length);
    this._emptyEl.style.display = labels.length ? 'none' : '';

    const ORDER = { manual: 0, BirdNET: 1, 'xeno-canto': 2 };

    // Two-level: origin → label name → instances[]
    /** @type {Map<string, Map<string, any[]>>} */
    const originGroups = new Map();
    for (const lbl of labels) {
      const origin = lbl.origin || 'manual';
      if (!originGroups.has(origin)) originGroups.set(origin, new Map());
      const nameMap = /** @type {Map<string, any[]>} */ (originGroups.get(origin));
      const key = lbl.label || '(unlabeled)';
      if (!nameMap.has(key)) nameMap.set(key, []);
      /** @type {any[]} */ (nameMap.get(key)).push(lbl);
    }

    const origins = [...originGroups.keys()].sort((a, b) =>
      (ORDER[a] ?? 99) - (ORDER[b] ?? 99) || a.localeCompare(b));
    const showOriginHeaders = origins.length > 1;

    for (const origin of origins) {
      if (showOriginHeaders) {
        const hdr = document.createElement('div');
        hdr.className = 'label-origin-header';
        hdr.textContent = origin;
        this._container.appendChild(hdr);
      }
      const nameMap = /** @type {Map<string, any[]>} */ (originGroups.get(origin));
      const names = [...nameMap.keys()].sort((a, b) => a.localeCompare(b));
      for (const name of names) {
        const instances = /** @type {any[]} */ (nameMap.get(name));
        instances.sort((a, b) => a.start - b.start);
        this._container.appendChild(this._buildGroup(instances));
      }
    }

    if (this._selectedId) this.highlightRow(this._selectedId);
  }

  highlightRow(labelId) {
    this._selectedId = labelId || null;
    for (const c of this._container.querySelectorAll('.label-instance.selected')) {
      c.classList.remove('selected');
    }
    if (labelId) {
      const inst = this._cardMap.get(labelId);
      if (inst) {
        // Auto-expand parent group if collapsed
        const group = inst.closest('.label-group');
        if (group && !group.classList.contains('expanded')) {
          const list = group.querySelector('.label-group-instances');
          if (list) /** @type {HTMLElement} */ (list).hidden = false;
          group.classList.add('expanded');
        }
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
        // Auto-expand parent group if collapsed
        const group = inst.closest('.label-group');
        if (group && !group.classList.contains('expanded')) {
          const list = group.querySelector('.label-group-instances');
          if (list) /** @type {HTMLElement} */ (list).hidden = false;
          group.classList.add('expanded');
        }
        inst.classList.add('highlighted');
        inst.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }

  // ── Group builder ──────────────────────────────────────────────────

  /** @param {any[]} instances  Labels sharing the same name+origin */
  _buildGroup(instances) {
    const representative = instances[0];
    const { display, scientific } = this._resolveName(representative);
    const origin = representative.origin || 'manual';
    const groupKey = `${origin}::${representative.label || '(unlabeled)'}`;

    const group = document.createElement('div');
    group.className = 'label-group';

    // ── Group header: chevron + dot + name + count + edit btn ──
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
    nameEl.title = 'Click to edit name';
    nameEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this._startGroupInlineEdit(nameEl, instances, display);
    });
    row.appendChild(nameEl);

    if (instances.length > 1) {
      const count = document.createElement('span');
      count.className = 'label-group-count';
      count.textContent = String(instances.length);
      row.appendChild(count);
    }

    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    row.appendChild(spacer);

    const editBtn = document.createElement('button');
    editBtn.className = 'act-btn';
    editBtn.textContent = '✎';
    editBtn.title = 'Edit (taxonomy search)';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._onEdit?.(representative.id);
    });
    row.appendChild(editBtn);

    group.appendChild(row);

    // ── Scientific name ──
    if (scientific) {
      const sciEl = document.createElement('div');
      sciEl.className = 'label-group-sci';
      sciEl.textContent = scientific;
      group.appendChild(sciEl);
    }

    // ── Instances list (collapsible) ──
    const instanceList = document.createElement('div');
    instanceList.className = 'label-group-instances';

    for (const lbl of instances) {
      const inst = this._buildInstance(lbl);
      instanceList.appendChild(inst);
      this._cardMap.set(lbl.id, inst);
    }

    // Auto-expand single-instance groups; preserve expand state across re-renders
    const single = instances.length === 1;
    const shouldExpand = this._expandedGroups.has(groupKey) || single;
    instanceList.hidden = !shouldExpand;
    group.classList.toggle('expanded', shouldExpand);
    if (shouldExpand) this._expandedGroups.add(groupKey);

    group.appendChild(instanceList);

    row.addEventListener('click', () => {
      const collapsed = instanceList.hidden;
      instanceList.hidden = !collapsed;
      group.classList.toggle('expanded', collapsed);
      if (collapsed) this._expandedGroups.add(groupKey);
      else this._expandedGroups.delete(groupKey);
    });

    return group;
  }

  // ── Instance builder ──────────────────────────────────────────────

  _buildInstance(lbl) {
    const inst = document.createElement('div');
    inst.className = 'label-instance';
    inst.dataset.labelId = lbl.id;

    inst.addEventListener('click', (e) => {
      if (e.target.closest('.act-btn') || e.target.closest('select') || e.target.closest('input') || e.target.closest('.esel')) return;
      this._onSeek?.(lbl);
      this.highlightRow(lbl.id);
      this._onFocus?.(lbl.id, 'list');
    });
    inst.addEventListener('pointerenter', () => this._onHover?.(lbl.id, true));
    inst.addEventListener('pointerleave', () => this._onHover?.(lbl.id, false));

    // ── Header: time/freq + edit-toggle + delete ──
    const header = document.createElement('div');
    header.className = 'label-instance-header';

    const meta = document.createElement('span');
    meta.className = 'label-instance-meta';
    meta.textContent = `${fmt(lbl.start)} – ${fmt(lbl.end)}  ·  ${Math.round(lbl.freqMin)}–${Math.round(lbl.freqMax)} Hz`;
    header.appendChild(meta);

    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    header.appendChild(spacer);

    const editToggle = document.createElement('button');
    editToggle.className = 'act-btn edit-toggle';
    editToggle.textContent = '✎';
    editToggle.title = 'Edit tags';
    header.appendChild(editToggle);

    const delBtn = document.createElement('button');
    delBtn.className = 'act-btn danger';
    delBtn.textContent = '×';
    delBtn.title = 'Remove';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._onRemove?.(lbl);
    });
    header.appendChild(delBtn);

    inst.appendChild(header);

    // ── Tag badges (shown when detail is collapsed) ──
    const tagsEl = this._buildTagBadges(lbl);
    inst.appendChild(tagsEl);

    // ── Expandable detail (tag editing) ──
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

    editToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDetail();
    });

    // Keep dblclick as alternative
    inst.addEventListener('dblclick', (e) => {
      if (e.target.closest('.act-btn') || e.target.closest('input') || e.target.closest('select') || e.target.closest('.esel')) return;
      e.stopPropagation();
      toggleDetail();
    });

    return inst;
  }

  // ── Tag badges line ───────────────────────────────────────────────

  _buildTagBadges(lbl) {
    const el = document.createElement('div');
    el.className = 'label-card-tags';
    const tags = lbl.tags || {};

    // Show preset attributes as small labelled pills (e.g. "Sex: male")
    const PRESET_LABELS = { sex: 'Sex', lifeStage: 'Stage', soundType: 'Type' };
    for (const preset of TAG_PRESETS) {
      const val = tags[preset.key];
      if (val) {
        const badge = document.createElement('span');
        // Use modal-consistent pill styling for clarity in the sidebar
        badge.className = 'label-tag-badge';
        // small key label inside the pill
        const keySpan = document.createElement('span');
        keySpan.className = 'tag-key';
        keySpan.textContent = PRESET_LABELS[preset.key] || preset.key;
        badge.appendChild(keySpan);
        badge.appendChild(document.createTextNode(': ' + val + ' '));
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
        onAdd: store ? (val) => { store.add(preset.key, val); } : undefined,
        onRemove: store ? (val) => { store.remove(preset.key, val); } : undefined,
        onRename: store ? (oldVal, newVal) => { store.rename(preset.key, oldVal, newVal); } : undefined,
      });
      es.el.addEventListener('click', (e) => e.stopPropagation());
      this._esInstances.push(es);
      row.appendChild(es.el);
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
      // Use the same pill styling as the modal's label tag badges
      badge.className = 'label-tag-badge';
      const keySpan = document.createElement('span');
      keySpan.className = 'tag-key';
      keySpan.textContent = k;
      badge.appendChild(keySpan);
      badge.appendChild(document.createTextNode(': ' + v + ' '));
      const del = document.createElement('button');
      // modal uses a slightly different delete button class
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

  // ── Inline name editing (group-level, renames all instances) ────

  _startGroupInlineEdit(nameEl, instances, displayName) {
    if (nameEl.querySelector('input')) return;
    const input = document.createElement('input');
    input.className = 'inline-name-input';
    input.value = instances[0].label || displayName;
    nameEl.textContent = '';
    nameEl.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
      const val = input.value.trim();
      if (val && val !== instances[0].label) {
        for (const lbl of instances) {
          lbl.label = val;
          lbl.scientificName = '';
          lbl.commonName = '';
        }
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
