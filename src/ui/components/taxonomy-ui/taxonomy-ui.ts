/**
 * Taxonomy UI helpers — language selector, flag mapping, diacritic-insensitive search,
 * and suggestion provider factory.
 *
 * Reusable across any app that uses TaxonomyResolver + BirdNETPlayer.
 */

import {
  normalizeSearch, matchTier, compareRanked, speciesCodes, splitHighlight, MATCH, LOCAL_THRESHOLD,
} from './species-ranking.ts';

export { normalizeSearch };

/** Map BirdNET language codes to Unicode flag emoji. */
export const LANG_FLAGS = {
  af: '\u{1F1FF}\u{1F1E6}', ar: '\u{1F1F8}\u{1F1E6}', bg: '\u{1F1E7}\u{1F1EC}',
  ca: '\u{1F3F4}\u{E0065}\u{E0073}\u{E0063}\u{E0074}\u{E007F}', cs: '\u{1F1E8}\u{1F1FF}',
  da: '\u{1F1E9}\u{1F1F0}', de: '\u{1F1E9}\u{1F1EA}', el: '\u{1F1EC}\u{1F1F7}',
  en_uk: '\u{1F1EC}\u{1F1E7}', es: '\u{1F1EA}\u{1F1F8}', fi: '\u{1F1EB}\u{1F1EE}',
  fr: '\u{1F1EB}\u{1F1F7}', he: '\u{1F1EE}\u{1F1F1}', hr: '\u{1F1ED}\u{1F1F7}',
  hu: '\u{1F1ED}\u{1F1FA}', in: '\u{1F1EE}\u{1F1E9}', is: '\u{1F1EE}\u{1F1F8}',
  it: '\u{1F1EE}\u{1F1F9}', ja: '\u{1F1EF}\u{1F1F5}', ko: '\u{1F1F0}\u{1F1F7}',
  lt: '\u{1F1F1}\u{1F1F9}', ml: '\u{1F1EE}\u{1F1F3}', nl: '\u{1F1F3}\u{1F1F1}',
  no: '\u{1F1F3}\u{1F1F4}', pl: '\u{1F1F5}\u{1F1F1}', pt_BR: '\u{1F1E7}\u{1F1F7}',
  pt_PT: '\u{1F1F5}\u{1F1F9}', ro: '\u{1F1F7}\u{1F1F4}', ru: '\u{1F1F7}\u{1F1FA}',
  sk: '\u{1F1F8}\u{1F1F0}', sl: '\u{1F1F8}\u{1F1EE}', sr: '\u{1F1F7}\u{1F1F8}',
  sv: '\u{1F1F8}\u{1F1EA}', th: '\u{1F1F9}\u{1F1ED}', tr: '\u{1F1F9}\u{1F1F7}',
  uk: '\u{1F1FA}\u{1F1E6}', zh: '\u{1F1E8}\u{1F1F3}',
};

/**
 * Build a detail string with flags of languages that matched the query.
 * Returns e.g. "🇩🇪 Kohlmeise · 🇫🇷 Mésange charbonnière".
 */
export function buildMatchDetail(record: any, query: any, displayLang: any) {
  if (!query || !record?.n) return '';
  const q = normalizeSearch(query);
  const parts = [];
  for (const [lang, name] of Object.entries(record.n)) {
    if (lang === displayLang) continue;
    if (!normalizeSearch(name).includes(q)) continue;
    const flag = (LANG_FLAGS as any)[lang] || lang;
    parts.push(`${flag}\u00a0${name}`);
    if (parts.length >= 3) break;
  }
  return parts.join(' \u00b7 ');
}

/**
 * Populate a `<select>` element with taxonomy languages + scientific option.
 *
 * @param {HTMLSelectElement} selectEl
 * @param {import('../../src/infrastructure/taxonomyResolver.ts').TaxonomyResolver} taxonomy
 * @param {string} [defaultLang]  Language code to pre-select (from URL param etc.)
 * @returns {string} The resolved initial language value
 */
export function populateLanguageSelect(selectEl: any, taxonomy: any, defaultLang = '') {
  const langs = taxonomy.languages.slice().sort((a: any, b: any) => a.localeCompare(b));
  selectEl.innerHTML = '';

  const sciOpt = document.createElement('option');
  sciOpt.value = 'scientific';
  sciOpt.textContent = '🔬 Scientific';
  selectEl.appendChild(sciOpt);

  for (const lang of langs) {
    const opt = document.createElement('option');
    opt.value = lang;
    opt.textContent = lang;
    selectEl.appendChild(opt);
  }

  const allOpts = ['scientific', ...langs];
  const chosen = allOpts.includes(defaultLang) ? defaultLang
    : langs.includes('en_uk') ? 'en_uk' : langs[0];
  selectEl.value = chosen;
  return chosen;
}

/**
 * One row of the species search dropdown. All fields beyond `name` are optional;
 * `group` switches the widget to the grouped, two-line layout.
 */
export interface SpeciesSuggestion {
  name: string;
  scientificName?: string;
  color?: string;
  /** Short legacy badge text (origin / other-language match) for older renderers. */
  detail?: string;
  /** 'recent' | 'project' | 'taxonomy' | 'extra' (species outside the BirdNET model). */
  group?: string;
  /** Number of results in this group before truncation. */
  groupTotal?: number;
  /** Labels with this species in the project. */
  count?: number;
  /** "🇫🇷 Mésange charbonnière" when only another language's name matched. */
  matchedAlt?: string;
  /** Upper-case species code when the query matched one (e.g. "PAMA"). */
  code?: string;
  /** Species occurs at the recording location according to the geo model. */
  local?: boolean;
  /** On the user's active species list. */
  listed?: boolean;
  [k: string]: any;
}

/** Up to this many species outside the BirdNET model are shown (own group, at the end). */
const EXTRA_LIMIT = 4;

const _searchIndex = new WeakMap<object, { hay: string, codes: string[] }[]>();
/** Normalized haystack (all names + scientific name) and species codes per record, cached per records array. */
function searchIndex(records: any[]) {
  let idx = _searchIndex.get(records);
  if (!idx) {
    idx = records.map((rec: any) => ({
      hay: normalizeSearch(`${rec.n ? Object.values(rec.n).join(' ') : ''} ${rec.s}`),
      codes: speciesCodes(rec.s),
    }));
    _searchIndex.set(records, idx);
  }
  return idx;
}

/** First other-language name containing `q`, prefixed with its flag. */
export function altNameMatch(record: any, q: string, displayLang: string) {
  if (!q || !record?.n) return '';
  for (const [lang, name] of Object.entries(record.n)) {
    if (lang === displayLang) continue;
    if (!normalizeSearch(name).includes(q)) continue;
    return `${(LANG_FLAGS as any)[lang] || lang} ${name}`;
  }
  return '';
}

/**
 * Create a label-suggestion provider function.
 *
 * Results come in groups: species already used in the project (labels, XC pool,
 * background species), then taxonomy matches (ranked, see species-ranking.ts),
 * then species outside the BirdNET model.
 *
 * @param {object} opts
 * @param {import('../../src/infrastructure/taxonomyResolver.ts').TaxonomyResolver} opts.taxonomy
 * @param {() => string} opts.getLang    Returns current display language
 * @param {() => Array}  opts.getLabels  Returns current label array
 * @param {() => Array}  opts.getPool    Returns XC label pool array
 * @param {(sci: string) => number|null} [opts.getGeoScore]  Occurrence probability at the recording location
 * @returns {(query: string, limit?: number) => SpeciesSuggestion[]}
 */
export function createSuggestionProvider({ taxonomy, getLang, getLabels, getPool, getGeoScore, isListed }: any) {
  return (query: any, limit = 14): SpeciesSuggestion[] => {
    const q = normalizeSearch(query).trim();
    const lang = getLang();
    const project = new Map<string, SpeciesSuggestion>();

    const recordFor = (sci: string) => (sci && taxonomy.data ? taxonomy.resolve(sci) : null);
    const add = (key: string, item: SpeciesSuggestion) => { if (!project.has(key)) project.set(key, item); };

    add('name:noise', { name: 'Noise', scientificName: '', count: 0 });

    // Pool items: xeno-canto label pool + background species.
    // Items carry an optional `origin` field ('xeno-canto', 'background', …).
    for (const item of getPool()) {
      const name = String(item?.name || '').trim();
      const sci  = String(item?.scientificName || '').trim();
      if (!name) continue;
      // Resolve via taxonomy so XC English names become localized and bare
      // scientific names (e.g. background species) get a canonical sci: key.
      const resolvedSci  = sci || (taxonomy.data ? taxonomy.resolve(name)?.s : '') || '';
      const record       = recordFor(resolvedSci);
      const localName    = record ? (taxonomy.resolveCommonName(record, lang) || record.s) : name;
      const finalSci     = record?.s || sci;
      const key = finalSci ? `sci:${finalSci}` : `name:${localName.toLowerCase()}`;
      add(key, { name: localName, scientificName: finalSci, detail: item?.origin || '', count: 0 });
    }

    // User-drawn labels — count per species; show origin for non-manual labels (BirdNET, xeno-canto).
    for (const lbl of getLabels()) {
      const rawSci = String(lbl?.scientificName || '').trim();
      const record = recordFor(rawSci);
      // Canonical name, so labels using an older alias count towards the same species.
      const sci = record?.s || rawSci;
      const localized = record ? taxonomy.resolveCommonName(record, lang) : '';
      const name = String(localized || lbl?.commonName || lbl?.label || sci).trim();
      if (!name) continue;
      const key = sci ? `sci:${sci}` : `name:${name.toLowerCase()}`;
      const origin = lbl?.origin && lbl.origin !== 'manual' ? lbl.origin : '';
      add(key, { name, scientificName: sci, detail: origin, count: 0 });
      project.get(key)!.count = (project.get(key)!.count || 0) + 1;
    }

    // Project group: filter + rank.
    const projectRows: (SpeciesSuggestion & { tier: number })[] = [];
    for (const item of project.values()) {
      const rec = recordFor(item.scientificName || '');
      const tier = matchTier(q, item.name, item.scientificName, rec?.n ? Object.values(rec.n) : []);
      if (tier === MATCH.NONE) continue;
      const geo = item.scientificName ? getGeoScore?.(item.scientificName) : null;
      projectRows.push({
        ...item,
        tier,
        listed: !!(item.scientificName && isListed?.(item.scientificName)),
        group: 'project',
        local: geo != null && geo >= LOCAL_THRESHOLD,
        matchedAlt: tier === MATCH.ALT ? altNameMatch(rec, q, lang) : '',
        code: tier === MATCH.CODE ? q.toUpperCase() : '',
      });
    }
    projectRows.sort((a, b) =>
      (q ? a.tier - b.tier : 0) || Number(!!b.listed) - Number(!!a.listed) || (b.count || 0) - (a.count || 0) || a.name.localeCompare(b.name));

    // Taxonomy: full scan over the cached index (≈11k records), then rank.
    const taxRows: any[] = [];
    const extraRows: any[] = [];
    if (q && taxonomy.data) {
      const records = taxonomy.records;
      const idx = searchIndex(records);
      for (let i = 0; i < records.length; i++) {
        const { hay, codes } = idx[i];
        if (!hay.includes(q) && !codes.includes(q)) continue;
        const rec = records[i];
        if (project.has(`sci:${rec.s}`)) continue;
        const name = taxonomy.resolveCommonName(rec, lang) || rec.s;
        const tier = matchTier(q, name, rec.s, rec.n ? Object.values(rec.n) : []);
        if (tier === MATCH.NONE) continue;
        const geo = getGeoScore?.(rec.s) ?? null;
        const row = {
          name, scientificName: rec.s, tier, geo,
          listed: !!isListed?.(rec.s),
          local: geo != null && geo >= LOCAL_THRESHOLD,
          matchedAlt: tier === MATCH.ALT ? altNameMatch(rec, q, lang) : '',
          code: tier === MATCH.CODE ? q.toUpperCase() : '',
        };
        (rec.x ? extraRows : taxRows).push(row);
      }
      taxRows.sort(compareRanked);
      extraRows.sort(compareRanked);
    }

    const finish = (rows: any[], group: string, max: number) => rows.slice(0, max).map(({ tier, geo, ...r }) => ({
      ...r,
      group,
      groupTotal: rows.length,
      detail: group === 'extra' ? 'not in BirdNET model' : (r.detail || r.matchedAlt || ''),
    }));
    const max = Math.max(1, limit);
    return [
      ...finish(projectRows, 'project', max),
      ...finish(taxRows, 'taxonomy', max),
      ...finish(extraRows, 'extra', Math.min(EXTRA_LIMIT, max)),
    ];
  };
}


// ── Shared rendering for grouped species rows (search widget + label editor) ──

const GROUP_TITLES: Record<string, string> = {
  recent: 'Recent',
  project: 'In this project',
  taxonomy: 'Taxonomy',
  extra: 'More species <span class="search-group-sub">· not detected by BirdNET</span>',
};
export const EXTRA_TITLE = 'Can be labelled, but BirdNET cannot detect this species';

function esc(s: unknown) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function hl(text: string, q: string) {
  const [pre, hit, post] = splitHighlight(text, q);
  return hit ? `${esc(pre)}<mark>${esc(hit)}</mark>${esc(post)}` : esc(text);
}

/** Inner HTML of a group header; `n` shown, `total` before truncation. */
export function speciesGroupHeaderHtml(group: string, n: number, total = n) {
  const title = GROUP_TITLES[group] || esc(group);
  return `<span>${title}</span><span>${total > n ? `${n} of ${total}` : n}</span>`;
}

export function speciesRowClass(s: SpeciesSuggestion) {
  return 'species-search-item species-search-item--rich' + (s.group === 'extra' ? ' is-extra' : '');
}

/** Inner HTML of a two-line species row; `q` is the normalized query to highlight. */
export function speciesRowHtml(s: SpeciesSuggestion, q: string) {
  const dot = s.color && s.group !== 'taxonomy' && s.group !== 'extra'
    ? `<span class="search-dot" style="background:${esc(s.color)}"></span>`
    : '<span class="search-dot search-dot--hollow"></span>';
  const sub = s.scientificName ? `<i>${hl(s.scientificName, q)}</i>` : '';
  const alt = s.matchedAlt ? `${sub ? ' · ' : ''}<span class="search-alt">${hl(s.matchedAlt, q)}</span>` : '';
  const code = s.code ? `<span class="search-code">${esc(s.code)}</span>` : '';
  const meta = (s.listed ? '<span class="search-listed" title="On your active species list">list</span>' : '')
    + (s.local ? '<span class="search-local" title="Occurs at the recording location (BirdNET geo model)"></span>' : '')
    + (s.count ? `<span class="search-count">${s.count}×</span>` : '');
  return `${dot}<span class="search-name">${hl(s.name, q)}</span>`
    + `<span class="search-meta">${meta}</span>`
    + (sub || alt || code ? `<span class="search-sub">${sub}${alt}${code}</span>` : '');
}

/**
 * Create a reusable species autocomplete widget (input + floating dropdown).
 *
 * The dropdown is appended to `document.body` and fixed-positioned under the
 * anchor so it works correctly inside any scroll container.
 *
 * Suggestion objects may include optional fields that are rendered in the row:
 *   `color`          — hex string, rendered as a coloured dot
 *   `scientificName` — italic secondary line
 *   `detail`         — small badge (e.g. origin / language code)
 *
 * `onSelect` receives the full suggestion object (including `color` etc.) so
 * callers do not need to look up the item again.
 *
 * @param {object} opts
 * @param {(query: string, limit?: number) => Array<{name:string, scientificName?:string, color?:string, detail?:string}>} opts.getSuggestions
 * @param {(item: {name:string, scientificName:string, color?:string, [k:string]:any}) => void} opts.onSelect
 * @param {() => void} [opts.onClear]   Called when the user explicitly clears the field via the × button.
 * @param {string}  [opts.placeholder]
 * @param {string}  [opts.initialValue]
 * @returns {{ el: HTMLElement, input: HTMLInputElement, setValue: (v:string)=>void, destroy: () => void }}
 */
let _widgetSeq = 0;

export function createSpeciesSearchWidget({ getSuggestions, onSelect, onClear, placeholder = 'Species / Label…', initialValue = '' }: any) {
  function escHtml(s: any) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── DOM ──
  const wrap = document.createElement('div');
  wrap.className = 'species-search-widget';
  wrap.style.cssText = 'position:relative;display:flex;align-items:center;width:100%;';

  const inner = document.createElement('div');
  inner.className = 'species-search-inner';
  inner.style.width = '100%';

  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('class', 'species-search-icon');
  icon.setAttribute('width', '13');
  icon.setAttribute('height', '13');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '2.5');
  icon.setAttribute('stroke-linecap', 'round');
  icon.innerHTML = '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>';
  inner.appendChild(icon);

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'species-search-input';
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.value = initialValue;
  if (initialValue) input.classList.add('has-selection');
  inner.appendChild(input);

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'species-search-clear' + (initialValue ? '' : ' hidden');
  clearBtn.title = 'Clear';
  clearBtn.textContent = '×';
  inner.appendChild(clearBtn);

  wrap.appendChild(inner);

  // ── Floating dropdown (portalled to body) ──
  const dropdown = document.createElement('div');
  dropdown.className = 'species-search-dropdown hidden';
  dropdown.id = `species-search-${++_widgetSeq}`;
  dropdown.setAttribute('role', 'listbox');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', dropdown.id);
  document.body.appendChild(dropdown);

  let activeIndex = -1;
  let items: any = [];
  let destroyed = false;

  function positionDropdown() {
    const r = inner.getBoundingClientRect();
    dropdown.style.position = 'fixed';
    dropdown.style.top = (r.bottom + 2) + 'px';
    dropdown.style.left = r.left + 'px';
    dropdown.style.width = Math.min(Math.max(r.width, 280), window.innerWidth - r.left - 8) + 'px';
    dropdown.style.zIndex = '9999';
  }

  function updateHighlight() {
    for (let i = 0; i < items.length; i++) items[i].classList.toggle('active', i === activeIndex);
    if (items[activeIndex]) input.setAttribute('aria-activedescendant', items[activeIndex].id);
    if (activeIndex >= 0 && items[activeIndex]) items[activeIndex].scrollIntoView({ block: 'nearest' });
  }

  function addRow(row: HTMLElement, entry: any) {
    row.setAttribute('role', 'option');
    row.id = `${dropdown.id}-opt-${items.length}`;
    row.addEventListener('mousedown', (e) => { e.preventDefault(); selectEntry(entry); });
    row.addEventListener('pointerenter', () => { activeIndex = items.indexOf(row); updateHighlight(); });
    dropdown.appendChild(row);
    items.push(row);
  }

  /** Two-line row for grouped results. */
  function groupedRow(s: any, q: string) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = speciesRowClass(s);
    row.innerHTML = speciesRowHtml(s, q);
    if (s.group === 'extra') row.title = EXTRA_TITLE;
    return row;
  }

  function renderGrouped(suggestions: any[], rawQuery: string) {
    const q = normalizeSearch(rawQuery);
    let current = '';
    for (const s of suggestions) {
      const group = s.group || 'project';
      if (group !== current) {
        if (current) dropdown.appendChild(Object.assign(document.createElement('div'), { className: 'search-sep' }));
        current = group;
        const n = suggestions.filter((x) => (x.group || 'project') === group).length;
        const total = Math.max(n, s.groupTotal || 0);
        const head = document.createElement('div');
        head.className = 'search-group' + (group === 'extra' ? ' is-extra' : '');
        head.setAttribute('role', 'presentation');
        head.innerHTML = speciesGroupHeaderHtml(group, n, total);
        dropdown.appendChild(head);
      }
      addRow(groupedRow(s, q), s);
    }
    const exact = suggestions.some((s) => normalizeSearch(s.name) === q || normalizeSearch(s.scientificName) === q);
    if (q && !exact) {
      if (suggestions.length) dropdown.appendChild(Object.assign(document.createElement('div'), { className: 'search-sep' }));
      else dropdown.appendChild(Object.assign(document.createElement('div'), { className: 'search-empty', textContent: 'No species found.' }));
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'species-search-item species-search-item--create';
      row.innerHTML = `<span class="search-plus">+</span><span class="search-name">Use “<b>${escHtml(rawQuery)}</b>” as new label</span>`;
      addRow(row, { name: rawQuery, scientificName: '' });
    }
    if (items.length) {
      const hint = document.createElement('div');
      hint.className = 'search-keys';
      hint.innerHTML = '<span><kbd>↑</kbd><kbd>↓</kbd> select</span><span><kbd>Enter</kbd> apply</span><span><kbd>Esc</kbd> close</span>';
      dropdown.appendChild(hint);
    }
  }

  function renderDropdown() {
    if (destroyed) return;
    const query = input.value.trim();
    dropdown.innerHTML = '';
    items = [];
    activeIndex = -1;
    input.removeAttribute('aria-activedescendant');
    positionDropdown();

    const suggestions = getSuggestions(query, 16);

    if (suggestions.some((s: any) => s.group)) {
      renderGrouped(suggestions, query);
      dropdown.classList.toggle('hidden', items.length === 0);
      return;
    }

    // Legacy single-line rows (providers without groups).
    if (suggestions.length === 0 && query) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'species-search-item';
      row.innerHTML = `<span class="search-name">Create: <b>${escHtml(query)}</b></span>`;
      addRow(row, { name: query, scientificName: '' });
    }

    for (const s of suggestions) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'species-search-item';
      let html = '';
      if (s.color) html += `<span class="search-dot" style="background:${escHtml(s.color)}"></span>`;
      html += `<span class="search-name">${escHtml(s.name)}</span>`;
      if (s.scientificName) html += `<span class="search-sci">${escHtml(s.scientificName)}</span>`;
      if (s.detail) html += `<span class="search-badge">${escHtml(s.detail)}</span>`;
      row.innerHTML = html;
      addRow(row, s);
    }

    dropdown.classList.toggle('hidden', items.length === 0);
  }

  function selectEntry(item: any) {
    const name = (item.name || '').trim();
    input.value = name;
    input.classList.toggle('has-selection', !!name);
    clearBtn.classList.toggle('hidden', !name);
    dropdown.classList.add('hidden');
    // Pass the full item so callers can access color, detail, etc. without re-lookup.
    onSelect({ ...item, name, scientificName: item.scientificName || '' });
  }

  /** Programmatically update the displayed value without triggering onSelect. */
  function setValue(name: any) {
    input.value = name || '';
    input.classList.toggle('has-selection', !!name);
    clearBtn.classList.toggle('hidden', !name);
    dropdown.classList.add('hidden');
  }

  /** Re-render the dropdown in place, but only if it is already visible. */
  function refresh() {
    if (!destroyed && !dropdown.classList.contains('hidden')) {
      renderDropdown();
    }
  }

  function destroy() {
    destroyed = true;
    dropdown.remove();
    document.removeEventListener('mousedown', onDocClick, true);
    window.removeEventListener('scroll', positionDropdown, true);
    window.removeEventListener('resize', positionDropdown);
  }

  function onDocClick(e: any) {
    if (!wrap.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.add('hidden');
    }
  }

  input.addEventListener('focus', () => renderDropdown());
  input.addEventListener('input', () => {
    // Any manual edit invalidates the confirmed selection.
    if (input.classList.contains('has-selection')) {
      input.classList.remove('has-selection');
      clearBtn.classList.toggle('hidden', !input.value);
      onClear?.();
    }
    renderDropdown();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIndex = Math.min(activeIndex + 1, items.length - 1); updateHighlight(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIndex = Math.max(activeIndex - 1, 0); updateHighlight(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0 && items[activeIndex]) items[activeIndex].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      else if (input.value.trim()) selectEntry({ name: input.value.trim(), scientificName: '' });
    } else if (e.key === 'Escape') {
      dropdown.classList.add('hidden');
      activeIndex = -1;
      input.blur();
    }
  });
  input.addEventListener('blur', () => {
    setTimeout(() => { if (!destroyed) dropdown.classList.add('hidden'); }, 120);
  });
  clearBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();            // keep input focused — prevents blur → hide-timer race
    input.value = '';
    input.classList.remove('has-selection');
    clearBtn.classList.add('hidden');
    onClear?.();
    renderDropdown();
  });
  document.addEventListener('mousedown', onDocClick, true);
  window.addEventListener('scroll', positionDropdown, true);
  window.addEventListener('resize', positionDropdown);

  return { el: wrap, input, setValue, refresh, destroy };
}
