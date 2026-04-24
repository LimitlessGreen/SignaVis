/**
 * Editable select component — a modern combobox dropdown with search,
 * preset options, custom (user-added) options, and add/edit/delete for custom entries.
 *
 * This is a copy of the demo widget moved into `src/` so library code (e.g.
 * the label editor modal) can reuse the same implementation.
 */

function esc(s: unknown) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function createEditableSelect(opts: unknown) {
  let currentValue = opts.value || '';
  let items = (opts.items || []).slice();
  let activeIndex = -1;
  let rows = [];
  let open = false;
  let editingValue = null;

  const root = document.createElement('div');
  root.className = 'esel' + (opts.className ? ' ' + opts.className : '');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'esel-trigger';
  updateTriggerText();
  root.appendChild(trigger);

  const dropdown = document.createElement('div');
  dropdown.className = 'esel-dropdown hidden';

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'esel-search';
  searchInput.placeholder = 'Search / add…';
  searchInput.autocomplete = 'off';
  searchInput.spellcheck = false;

  const listEl = document.createElement('div');
  listEl.className = 'esel-list';

  dropdown.appendChild(searchInput);
  dropdown.appendChild(listEl);

  function updateTriggerText() {
    trigger.textContent = currentValue || opts.placeholder || '–';
    trigger.classList.toggle('esel-has-value', !!currentValue);
  }

  function ensurePortal() { if (!dropdown.parentElement) document.body.appendChild(dropdown); }

  function show() {
    if (open) return;
    open = true;
    searchInput.value = '';
    editingValue = null;
    ensurePortal();
    dropdown.classList.remove('hidden');
    renderList();
    positionDropdown();
    searchInput.focus();
  }

  function hide() {
    if (!open) return;
    open = false;
    dropdown.classList.add('hidden');
    editingValue = null;
    activeIndex = -1;
  }

  function positionDropdown() {
    const rect = trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    dropdown.style.position = 'fixed';
    dropdown.style.left = rect.left + 'px';
    dropdown.style.minWidth = rect.width + 'px';
    if (spaceBelow < 180 && spaceAbove > spaceBelow) {
      dropdown.style.bottom = (window.innerHeight - rect.top) + 'px';
      dropdown.style.top = 'auto';
    } else {
      dropdown.style.top = rect.bottom + 'px';
      dropdown.style.bottom = 'auto';
    }
  }

  function renderList() {
    const query = searchInput.value.trim().toLowerCase();
    listEl.innerHTML = '';
    rows = [];
    activeIndex = -1;

    const filtered = query
      ? items.filter((it: unknown) => it.value.toLowerCase().includes(query))
      : items;

    if (currentValue) {
      const clearRow = makeRow('–', false, true);
      clearRow.addEventListener('click', (e) => { e.stopPropagation(); selectValue(''); });
      listEl.appendChild(clearRow);
      rows.push(clearRow);
    }

    for (const it of filtered) {
      if (editingValue != null && it.value === editingValue && it.custom) {
        const row = document.createElement('div');
        row.className = 'esel-row esel-editing';
        const editInput = document.createElement('input');
        editInput.type = 'text';
        editInput.className = 'esel-edit-input';
        editInput.value = it.value;
        editInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); finishEdit(it.value, editInput.value); }
          else if (e.key === 'Escape') { e.preventDefault(); editingValue = null; renderList(); searchInput.focus(); }
          e.stopPropagation();
        });
        editInput.addEventListener('click', (e) => e.stopPropagation());
        row.appendChild(editInput);
        listEl.appendChild(row);
        rows.push(row);
        requestAnimationFrame(() => { editInput.focus(); editInput.select(); });
        continue;
      }

      const row = makeRow(it.value, it.custom, it.value === currentValue);
      row.addEventListener('click', (e) => { e.stopPropagation(); selectValue(it.value); });
      row.addEventListener('pointerenter', () => { activeIndex = rows.indexOf(row); highlightActive(); });
      listEl.appendChild(row);
      rows.push(row);
    }

    if (query && !items.some((it: unknown) => it.value.toLowerCase() === query)) {
      const addRow = document.createElement('div');
      addRow.className = 'esel-row esel-add-row';
      addRow.innerHTML = `<span class="esel-add-label">+ ${esc(searchInput.value.trim())}</span>`;
      addRow.addEventListener('click', (e) => { e.stopPropagation(); addCustom(searchInput.value.trim()); });
      addRow.addEventListener('pointerenter', () => { activeIndex = rows.indexOf(addRow); highlightActive(); });
      listEl.appendChild(addRow);
      rows.push(addRow);
    }
  }

  function makeRow(value: unknown, isCustom: unknown, isSelected: unknown) {
    const row = document.createElement('div');
    row.className = 'esel-row' + (isSelected ? ' esel-selected' : '');
    const label = document.createElement('span');
    label.className = 'esel-label';
    label.textContent = value;
    row.appendChild(label);

    if (isCustom) {
      const actions = document.createElement('span');
      actions.className = 'esel-actions';
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'esel-act-btn';
      editBtn.title = 'Rename';
      editBtn.textContent = '✎';
      editBtn.addEventListener('click', (e) => { e.stopPropagation(); editingValue = value; renderList(); });
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'esel-act-btn esel-del';
      delBtn.title = 'Remove';
      delBtn.textContent = '×';
      delBtn.addEventListener('click', (e) => { e.stopPropagation(); removeCustom(value); });
      actions.append(editBtn, delBtn);
      row.appendChild(actions);
    }
    return row;
  }

  function highlightActive() {
    for (let i = 0; i < rows.length; i++) rows[i].classList.toggle('esel-active', i === activeIndex);
    if (activeIndex >= 0 && rows[activeIndex]) rows[activeIndex].scrollIntoView({ block: 'nearest' });
  }

  function selectValue(val: unknown) { currentValue = val; updateTriggerText(); hide(); opts.onChange(val); }

  function addCustom(val: unknown) {
    const trimmed = (val || '').trim();
    if (!trimmed) return;
    opts.onAdd?.(trimmed);
    items.push({ value: trimmed, custom: true });
    selectValue(trimmed);
  }

  function removeCustom(val: unknown) {
    opts.onRemove?.(val);
    items = items.filter((it: unknown) => !(it.custom && it.value === val));
    if (currentValue === val) { currentValue = ''; updateTriggerText(); opts.onChange(''); }
    renderList();
  }

  function finishEdit(oldVal: unknown, newVal: unknown) {
    const trimmed = (newVal || '').trim();
    editingValue = null;
    if (!trimmed || trimmed === oldVal) { renderList(); searchInput.focus(); return; }
    opts.onRename?.(oldVal, trimmed);
    for (const it of items) if (it.custom && it.value === oldVal) it.value = trimmed;
    if (currentValue === oldVal) { currentValue = trimmed; updateTriggerText(); opts.onChange(trimmed); }
    renderList(); searchInput.focus();
  }

  let destroyed = false;
  trigger.addEventListener('click', (e) => { e.stopPropagation(); if (open) hide(); else show(); });
  searchInput.addEventListener('input', () => renderList());
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (rows.length) { activeIndex = (activeIndex + 1) % rows.length; highlightActive(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (rows.length) { activeIndex = activeIndex <= 0 ? rows.length - 1 : activeIndex - 1; highlightActive(); } }
    else if (e.key === 'Enter') { e.preventDefault(); if (activeIndex >= 0 && rows[activeIndex]) rows[activeIndex].click(); else if (searchInput.value.trim()) { const lq = searchInput.value.trim().toLowerCase(); const match = items.find((it: unknown) => it.value.toLowerCase() === lq); if (match) selectValue(match.value); else addCustom(searchInput.value.trim()); } }
    else if (e.key === 'Escape') { e.preventDefault(); hide(); trigger.focus(); }
  });

  function onPointerDown(e: unknown) {
    if (destroyed) return;
    if (open && !root.contains(e.target) && !dropdown.contains(e.target)) hide();
  }
  document.addEventListener('pointerdown', onPointerDown);

  return {
    el: root,
    getValue() { return currentValue; },
    setValue(val: unknown) { currentValue = val || ''; updateTriggerText(); },
    setItems(newItems: unknown) { items = (newItems || []).slice(); if (open) renderList(); },
    destroy() { destroyed = true; hide(); document.removeEventListener('pointerdown', onPointerDown); if (dropdown.parentElement) dropdown.remove(); root.remove(); },
  };
}
