/**
 * Species lists tab: build, edit, import/export and pick the list that limits BirdNET.
 *
 *   ┌ Used for analysis ───────────────┐
 *   │ ◉ All species  (model default)   │  ← radio cards; one is active
 *   │ ○ Garden · 42 species        ›   │  ← click a card to edit it below
 *   └──────────────────────────────────┘
 *   [+ New list]  Empty · Expected here · From labels · Import file
 *   ── editor: name, search-to-add, filter, rows with remove, ⋯ menu ──
 */
import {
  SpeciesListStore, parseSpeciesListText, serializeSpeciesList, type SpeciesList,
} from '../../domain/species-lists.ts';
import { showContextMenu } from '../components/context-menu/context-menu.ts';

export interface SpeciesListsPanelOpts {
  store: SpeciesListStore;
  /** Localised common name ('' when unknown). */
  commonName: (sci: string) => string;
  /** English model label name for the --slist export ('' when unknown). */
  modelLabelName?: (sci: string) => string;
  /** Canonical scientific name from the taxonomy, or '' when unknown. */
  canonical: (nameOrSci: string) => string;
  /** Species search widget factory (same as the label editor). */
  speciesSearchFactory?: () => ((anchor: HTMLElement, onSelect: (item: any) => void) => { el?: HTMLElement; input: HTMLInputElement; destroy(): void; clear?(): void }) | null;
  /** Species the area model expects at the recording's place and date (sorted by score). */
  getExpectedSpecies?: (minScore: number) => Promise<{ species: string[]; place: string } | null>;
  /** Scientific names labelled in the current project. */
  getLabelledSpecies?: () => string[];
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]);
const plural = (n: number) => `${n} species`;
const copyText = (t: string) => navigator.clipboard?.writeText(t).catch(() => {});

type MenuItem = { label?: string; action?: () => void; danger?: boolean; disabled?: boolean; separator?: boolean };

/** Right-click menu for a list card ("All species" when list is null). */
export function listCardMenuItems(list: SpeciesList | null, active: boolean, act: {
  use: () => void; edit: () => void; duplicate: () => void; exportFile: () => void; remove: () => void;
}): MenuItem[] {
  const use = { label: active ? 'Used for analysis' : 'Use for analysis', action: act.use, disabled: active };
  if (!list) return [use];
  return [
    use,
    { label: 'Edit list', action: act.edit },
    { separator: true },
    { label: 'Duplicate', action: act.duplicate },
    { label: 'Export for BirdNET (--slist)…', action: act.exportFile, disabled: !list.species.length },
    { separator: true },
    { label: 'Delete list', action: act.remove, danger: true },
  ];
}

/** Right-click menu for a species row inside a list. */
export function speciesRowMenuItems(sci: string, common: string, others: SpeciesList[], act: {
  copy: (text: string) => void; addTo: (listId: string) => void; remove: () => void;
}): MenuItem[] {
  const items: MenuItem[] = [];
  if (common) items.push({ label: `Copy “${common}”`, action: () => act.copy(common) });
  items.push({ label: `Copy “${sci}”`, action: () => act.copy(sci) });
  const lc = sci.toLowerCase();
  if (others.length) items.push({ separator: true });
  for (const o of others.slice(0, 8)) {
    const has = o.species.some((s) => s.toLowerCase() === lc);
    items.push({ label: has ? `Already on “${o.name}”` : `Add to “${o.name}”`, action: () => act.addTo(o.id), disabled: has });
  }
  items.push({ separator: true }, { label: 'Remove from list', action: act.remove, danger: true });
  return items;
}

const SOURCE_TEXT: Record<string, string> = {
  manual: 'Made by hand', location: 'Expected at a place', import: 'Imported', labels: 'From labels',
};

export class SpeciesListsPanel {
  el: HTMLElement;
  private o: SpeciesListsPanelOpts;
  private editingId: string | null = null;
  private filter = '';
  private undo: { text: string; run: () => void } | null = null;
  private search: { input: HTMLInputElement; destroy(): void; clear?(): void } | null = null;
  private els: Record<string, HTMLElement> = {};

  constructor(opts: SpeciesListsPanelOpts) {
    this.o = opts;
    this.el = document.createElement('div');
    this.el.className = 'scroll-panel species-lists';
    this.el.innerHTML = `
      <p class="mode-desc">BirdNET only reports species on the list you pick here — like BirdNET's own species list file.</p>
      <div class="sl-cards" role="radiogroup" aria-label="Species list used for analysis"></div>
      <div class="sl-new">
        <button type="button" class="sl-new-btn" aria-expanded="false">
          <span aria-hidden="true">＋</span> New list
        </button>
        <div class="sl-new-menu" hidden>
          <button type="button" data-new="empty"><strong>Empty list</strong><small>Add species one by one</small></button>
          <button type="button" data-new="location"><strong>Expected here</strong><small>From the area model at the recording's place and week</small></button>
          <button type="button" data-new="labels"><strong>From my labels</strong><small>Every species labelled in this project</small></button>
          <button type="button" data-new="import"><strong>Import file…</strong><small>BirdNET species list (.txt) or CSV</small></button>
        </div>
        <input type="file" accept=".txt,.csv,.tsv,text/plain,text/csv" hidden />
      </div>
      <div class="sl-status meta" aria-live="polite"></div>
      <section class="sl-editor" hidden></section>`;
    const q = (s: string) => this.el.querySelector(s) as HTMLElement;
    this.els = {
      cards: q('.sl-cards'), newBtn: q('.sl-new-btn'), newMenu: q('.sl-new-menu'),
      file: q('input[type=file]'), status: q('.sl-status'), editor: q('.sl-editor'),
    };
    this.bind();
    this.o.store.onChange(() => this.render());
    this.editingId = this.o.store.active?.id ?? this.o.store.lists[0]?.id ?? null;
    this.render();
  }

  /** Re-render after taxonomy or language change. */
  refresh() { this.render(); }

  // ── events ──────────────────────────────────────────────────────────
  private bind() {
    const { newBtn, newMenu, file } = this.els;
    const toggleMenu = (open = newMenu.hidden) => {
      newMenu.hidden = !open;
      newBtn.setAttribute('aria-expanded', String(open));
      if (open) (newMenu.querySelector('button') as HTMLElement)?.focus();
    };
    newBtn.addEventListener('click', () => toggleMenu());
    newMenu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { toggleMenu(false); newBtn.focus(); } });
    document.addEventListener('pointerdown', (e) => {
      if (!newMenu.hidden && !this.els.newBtn.parentElement!.contains(e.target as Node)) toggleMenu(false);
    });
    newMenu.addEventListener('click', (e) => {
      const kind = (e.target as HTMLElement).closest<HTMLElement>('[data-new]')?.dataset.new;
      if (!kind) return;
      toggleMenu(false);
      this.createList(kind);
    });
    file.addEventListener('change', async () => {
      const f = (file as HTMLInputElement).files?.[0];
      (file as HTMLInputElement).value = '';
      if (f) this.importText(await f.text(), f.name.replace(/\.[^.]+$/, ''));
    });

    // Drop a species list file anywhere on the tab.
    this.el.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); this.el.classList.add('is-drop'); }
    });
    this.el.addEventListener('dragleave', (e) => { if (e.target === this.el) this.el.classList.remove('is-drop'); });
    this.el.addEventListener('drop', async (e) => {
      const f = e.dataTransfer?.files?.[0];
      this.el.classList.remove('is-drop');
      if (!f) return;
      e.preventDefault();
      e.stopPropagation();
      this.importText(await f.text(), f.name.replace(/\.[^.]+$/, ''));
    });

    this.els.cards.addEventListener('click', (e) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>('[data-list]');
      if (!card) return;
      const id = card.dataset.list || null;
      this.o.store.setActive(id);
      if (id && id !== this.editingId) { this.editingId = id; this.filter = ''; }
      this.render();
    });
    this.els.cards.addEventListener('contextmenu', (e) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>('[data-list]');
      if (!card) return;
      e.preventDefault();
      const { store } = this.o;
      const id = card.dataset.list || null;
      const list = store.get(id);
      const r = !e.clientX && !e.clientY ? card.getBoundingClientRect() : null; // keyboard (Menu key)
      showContextMenu({
        x: r ? r.left : e.clientX, y: r ? r.bottom : e.clientY,
        items: listCardMenuItems(list, (store.state.activeId ?? null) === id, {
          use: () => store.setActive(id),
          edit: () => { if (id) this.open(id); },
          duplicate: () => { const c = id && store.duplicate(id); if (c) this.open(c.id, { focusName: true }); },
          exportFile: () => { if (list) this.exportList(list); },
          remove: () => { if (list) this.deleteList(list); },
        }),
      });
    });
    this.els.cards.addEventListener('keydown', (e) => {
      if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
      const cards = [...this.els.cards.querySelectorAll<HTMLElement>('[data-list]')];
      const i = cards.indexOf(document.activeElement as HTMLElement);
      const next = cards[(i + (e.key === 'ArrowDown' ? 1 : -1) + cards.length) % cards.length];
      e.preventDefault();
      next?.click();
      this.els.cards.querySelector<HTMLElement>(`[data-list="${next?.dataset.list}"]`)?.focus();
    });
    this.els.status.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.sl-undo') && this.undo) {
        this.undo.run();
        this.setStatus('Undone.');
      }
    });
  }

  private async createList(kind: string) {
    const { store } = this.o;
    if (kind === 'import') { (this.els.file as HTMLInputElement).click(); return; }
    if (kind === 'empty') {
      const l = store.create(this.uniqueName('My species list'));
      this.open(l.id, { focusName: true });
      this.setStatus('New empty list — search below to add species.');
      return;
    }
    if (kind === 'labels') {
      const sci = (this.o.getLabelledSpecies?.() || []).map((s) => this.o.canonical(s) || s).filter(Boolean);
      if (!sci.length) { this.setStatus('No species labels in this project yet.'); return; }
      const l = store.create(this.uniqueName('Labelled species'), sci, 'labels');
      this.open(l.id);
      this.setStatus(`Created from labels — ${plural(l.species.length)}.`);
      return;
    }
    if (kind === 'location') {
      if (!this.o.getExpectedSpecies) return;
      this.setStatus('Asking the area model…');
      try {
        const res = await this.o.getExpectedSpecies(0.03);
        if (!res) { this.setStatus('Set the recording\'s location first (Properties → Location), and use a model with area model.'); return; }
        if (!res.species.length) { this.setStatus('The area model expects no species there.'); return; }
        const l = store.create(this.uniqueName(`Expected · ${res.place}`), res.species, 'location');
        this.open(l.id);
        this.setStatus(`${plural(l.species.length)} expected at ${res.place} — remove what does not fit.`);
      } catch (err: any) {
        this.setStatus(`Area model failed: ${err?.message || err}`);
      }
    }
  }

  private importText(text: string, name: string) {
    const raw = parseSpeciesListText(text);
    if (!raw.length) { this.setStatus('No species found in that file.'); return; }
    let unknown = 0;
    const sci = raw.map((s) => {
      const c = this.o.canonical(s);
      if (!c) unknown++;
      return c || s;
    });
    const l = this.o.store.create(this.uniqueName(name || 'Imported list'), sci, 'import');
    this.open(l.id);
    this.setStatus(`Imported ${plural(l.species.length)}${unknown ? ` · ${unknown} not in the taxonomy (kept, marked)` : ''}.`);
  }

  private uniqueName(base: string) {
    const names = new Set(this.o.store.lists.map((l) => l.name));
    if (!names.has(base)) return base;
    let i = 2;
    while (names.has(`${base} ${i}`)) i++;
    return `${base} ${i}`;
  }

  private open(id: string, { focusName = false } = {}) {
    this.editingId = id;
    this.filter = '';
    this.render();
    if (focusName) {
      const n = this.els.editor.querySelector<HTMLInputElement>('.sl-name');
      n?.focus();
      n?.select();
    }
  }

  private setStatus(text: string, undo: { text: string; run: () => void } | null = null) {
    this.undo = undo;
    this.els.status.innerHTML = esc(text) + (undo ? ` <button type="button" class="sl-undo">${esc(undo.text)}</button>` : '');
  }

  // ── rendering ───────────────────────────────────────────────────────
  private render() {
    const { store } = this.o;
    if (this.editingId && !store.get(this.editingId)) this.editingId = null;
    const activeId = store.state.activeId;
    const card = (id: string | null, title: string, sub: string, list?: SpeciesList) => {
      const on = (activeId ?? null) === id;
      return `<button type="button" class="sl-card${on ? ' is-active' : ''}${list && list.id === this.editingId ? ' is-editing' : ''}"
          role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" data-list="${id ?? ''}">
        <span class="sl-radio" aria-hidden="true"></span>
        <span class="sl-card-text"><strong>${esc(title)}</strong><small>${esc(sub)}</small></span>
        ${list ? `<span class="sl-count">${list.species.length}</span>` : ''}
      </button>`;
    };
    this.els.cards.innerHTML = card(null, 'All species', 'Everything the model knows')
      + store.lists.map((l) => card(l.id, l.name, SOURCE_TEXT[l.source || 'manual'] || '', l)).join('');
    this.renderEditor();
  }

  private renderEditor() {
    const ed = this.els.editor;
    this.search?.destroy();
    this.search = null;
    const list = this.o.store.get(this.editingId);
    ed.hidden = !list;
    if (!list) { ed.innerHTML = ''; return; }
    const active = this.o.store.state.activeId === list.id;
    ed.innerHTML = `
      <div class="sl-editor-head">
        <input class="sl-name" value="${esc(list.name)}" aria-label="List name" maxlength="80" />
        <button type="button" class="tb-btn sl-more" aria-haspopup="menu" aria-expanded="false" title="More">⋯</button>
        <div class="sl-more-menu" role="menu" hidden>
          <button type="button" role="menuitem" data-act="export">Export as BirdNET list (.txt)</button>
          <button type="button" role="menuitem" data-act="duplicate">Duplicate</button>
          <button type="button" role="menuitem" data-act="delete" class="danger">Delete list</button>
        </div>
      </div>
      <div class="sl-editor-meta">
        <span>${plural(list.species.length)}</span>
        ${active ? '<span class="sl-pill">Used for analysis</span>'
          : '<button type="button" class="sl-use">Use for analysis</button>'}
      </div>
      <div class="sl-add"></div>
      ${list.species.length > 8 || this.filter ? `<input class="lt-filter sl-filter" type="search" placeholder="Filter this list…" aria-label="Filter species in list" value="${esc(this.filter)}" />` : ''}
      <ul class="sl-rows"></ul>`;

    const name = ed.querySelector<HTMLInputElement>('.sl-name')!;
    name.addEventListener('change', () => this.o.store.rename(list.id, name.value));
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
    ed.querySelector('.sl-use')?.addEventListener('click', () => this.o.store.setActive(list.id));

    const more = ed.querySelector<HTMLElement>('.sl-more')!;
    const menu = ed.querySelector<HTMLElement>('.sl-more-menu')!;
    more.addEventListener('click', () => {
      menu.hidden = !menu.hidden;
      more.setAttribute('aria-expanded', String(!menu.hidden));
    });
    menu.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      menu.hidden = true;
      if (act === 'export') this.exportList(list);
      if (act === 'duplicate') { const c = this.o.store.duplicate(list.id); if (c) this.open(c.id, { focusName: true }); }
      if (act === 'delete') this.deleteList(list);
    });

    const factory = this.o.speciesSearchFactory?.();
    const addWrap = ed.querySelector<HTMLElement>('.sl-add')!;
    if (factory) {
      this.search = factory(addWrap, (item: any) => {
        const sci = item?.scientificName ? (this.o.canonical(item.scientificName) || item.scientificName) : '';
        if (!sci) return;
        const had = list.species.some((s) => s.toLowerCase() === sci.toLowerCase());
        this.o.store.add(list.id, [sci]);
        this.setStatus(had ? `${this.display(sci)} is already on the list.` : `Added ${this.display(sci)}.`);
        requestAnimationFrame(() => this.els.editor.querySelector<HTMLInputElement>('.sl-add input')?.focus());
      });
      this.search.input.placeholder = 'Add a species…';
      addWrap.append((this.search as any).el || this.search.input.closest('.species-search-widget') || this.search.input);
    } else {
      // Taxonomy not loaded: plain field, scientific names separated by comma or newline.
      addWrap.innerHTML = '<input class="input sl-add-plain" placeholder="Add scientific name, press Enter" aria-label="Add species" />';
      const inp = addWrap.querySelector<HTMLInputElement>('input')!;
      inp.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const sci = parseSpeciesListText(inp.value.replace(/,/g, '\n'));
        if (!sci.length) return;
        this.o.store.add(list.id, sci);
        this.setStatus(`Added ${sci.join(', ')}.`);
        requestAnimationFrame(() => this.els.editor.querySelector<HTMLInputElement>('.sl-add input')?.focus());
      });
    }

    const filterInput = ed.querySelector<HTMLInputElement>('.sl-filter');
    filterInput?.addEventListener('input', () => { this.filter = filterInput.value; this.renderRows(list); });
    const rowsEl = ed.querySelector<HTMLElement>('.sl-rows')!;
    rowsEl.addEventListener('click', (e) => {
      const sci = (e.target as HTMLElement).closest<HTMLElement>('.sl-remove')?.dataset.sci;
      if (sci) this.removeSpecies(list, sci);
    });
    rowsEl.addEventListener('contextmenu', (e) => {
      const sci = (e.target as HTMLElement).closest<HTMLElement>('.sl-row')?.dataset.sci;
      if (!sci) return;
      e.preventDefault();
      const others = this.o.store.lists.filter((l) => l.id !== list.id);
      showContextMenu({
        x: e.clientX, y: e.clientY,
        items: speciesRowMenuItems(sci, this.o.commonName(sci), others, {
          copy: (t) => { copyText(t); this.setStatus(`Copied “${t}”.`); },
          addTo: (id) => {
            this.o.store.add(id, [sci]);
            this.setStatus(`Added ${this.display(sci)} to “${this.o.store.get(id)?.name}”.`);
          },
          remove: () => this.removeSpecies(list, sci),
        }),
      });
    });
    this.renderRows(list);
  }

  private removeSpecies(list: SpeciesList, sci: string) {
    {
      const idx = list.species.indexOf(sci);
      this.o.store.remove(list.id, [sci]);
      this.setStatus(`Removed ${this.display(sci)}.`, {
        text: 'Undo',
        run: () => {
          const l = this.o.store.get(list.id);
          if (!l) return;
          l.species.splice(Math.max(0, idx), 0, sci);
          this.o.store.add(list.id, []); // persist + notify
        },
      });
    }
  }

  private renderRows(list: SpeciesList) {
    const ul = this.els.editor.querySelector<HTMLElement>('.sl-rows');
    if (!ul) return;
    if (!list.species.length) {
      ul.innerHTML = '<li class="sl-empty">No species yet. Search above, or drop a BirdNET list file here.</li>';
      return;
    }
    const q = this.filter.trim().toLowerCase();
    const rows = list.species
      .map((sci) => ({ sci, common: this.o.commonName(sci), known: !!this.o.canonical(sci) }))
      .filter((r) => !q || r.sci.toLowerCase().includes(q) || r.common.toLowerCase().includes(q))
      .sort((a, b) => (a.common || a.sci).localeCompare(b.common || b.sci));
    ul.innerHTML = rows.map((r) => `
      <li class="sl-row${r.known ? '' : ' is-unknown'}" data-sci="${esc(r.sci)}" title="${r.known ? '' : 'Not in the BirdNET taxonomy — BirdNET will never report this name'}">
        <span class="sl-row-text"><span class="sl-common">${esc(r.common || r.sci)}</span>${r.common ? `<i class="sl-sci">${esc(r.sci)}</i>` : ''}</span>
        <button type="button" class="sl-remove" data-sci="${esc(r.sci)}" aria-label="Remove ${esc(r.common || r.sci)}" title="Remove">×</button>
      </li>`).join('') || '<li class="sl-empty">Nothing matches the filter.</li>';
  }

  private display(sci: string) { return this.o.commonName(sci) || sci; }

  private exportList(list: SpeciesList) {
    // BirdNET-Analyzer compares whole label lines: use the model's English names, not the shown language.
    const text = serializeSpeciesList(list.species, (s) => this.o.modelLabelName?.(s) || '');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = `${list.name.replace(/[^\w\- ]+/g, '').trim() || 'species_list'}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    this.setStatus(`Exported ${plural(list.species.length)} — usable with BirdNET-Analyzer --slist.`);
  }

  private deleteList(list: SpeciesList) {
    const wasActive = this.o.store.state.activeId === list.id;
    const snapshot = { ...list, species: [...list.species] };
    const pos = this.o.store.lists.indexOf(list);
    this.o.store.delete(list.id);
    this.setStatus(`Deleted “${list.name}”.`, {
      text: 'Undo',
      run: () => {
        this.o.store.state.lists.splice(pos, 0, snapshot);
        if (wasActive) this.o.store.setActive(snapshot.id);
        else this.o.store.setActive(this.o.store.state.activeId);
        this.open(snapshot.id);
      },
    });
  }
}
