/**
 * Taxonomy UI helpers — language selector, flag mapping, diacritic-insensitive search,
 * and suggestion provider factory.
 *
 * Reusable across any app that uses TaxonomyResolver + BirdNETPlayer.
 */

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

/** Normalize text for search: lowercase + strip diacritics (ü→u, é→e, etc.) */
export function normalizeSearch(text: any) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

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
 * Create a label-suggestion provider function.
 *
 * @param {object} opts
 * @param {import('../../src/infrastructure/taxonomyResolver.ts').TaxonomyResolver} opts.taxonomy
 * @param {() => string} opts.getLang    Returns current display language
 * @param {() => Array}  opts.getLabels  Returns current label array
 * @param {() => Array}  opts.getPool    Returns XC label pool array
 * @returns {(query: string, limit?: number) => Array}
 */
export function createSuggestionProvider({ taxonomy, getLang, getLabels, getPool }: any) {
  return (query: any, limit = 14) => {
    const q = normalizeSearch(query);
    const lang = getLang();
    const dedupe = new Map();

    dedupe.set('name:noise', { name: 'Noise', scientificName: '' });

    // Pool items: xeno-canto label pool + background species.
    // Items carry an optional `origin` field ('xeno-canto', 'background', …).
    for (const item of getPool()) {
      const name = String(item?.name || '').trim();
      const sci  = String(item?.scientificName || '').trim();
      if (!name) continue;
      // Resolve via taxonomy so XC English names become localized and bare
      // scientific names (e.g. background species) get a canonical sci: key.
      const resolvedSci  = sci || (taxonomy.data ? taxonomy.resolve(name)?.s : '') || '';
      const record       = resolvedSci ? taxonomy.resolve(resolvedSci) : null;
      const localName    = record ? (taxonomy.resolveCommonName(record, lang) || record.s) : name;
      const finalSci     = record?.s || sci;
      const key = finalSci ? `sci:${finalSci}` : `name:${localName.toLowerCase()}`;
      if (!dedupe.has(key)) {
        dedupe.set(key, { name: localName, scientificName: finalSci, detail: item?.origin || '' });
      }
    }

    // User-drawn labels — show origin for non-manual labels (BirdNET, xeno-canto).
    for (const lbl of getLabels()) {
      const sci = String(lbl?.scientificName || '').trim();
      const record = sci ? taxonomy.resolve(sci) : null;
      const localized = record ? taxonomy.resolveCommonName(record, lang) : '';
      const name = String(localized || lbl?.commonName || lbl?.label || sci).trim();
      if (!name) continue;
      const key = sci ? `sci:${sci}` : `name:${name.toLowerCase()}`;
      if (!dedupe.has(key)) {
        const origin = lbl?.origin && lbl.origin !== 'manual' ? lbl.origin : '';
        dedupe.set(key, { name, scientificName: sci, detail: origin });
      }
    }

    if (q && taxonomy.data) {
      for (const rec of taxonomy.records) {
        const allNames = rec.n ? Object.values(rec.n) : [];
        const hay = normalizeSearch(`${allNames.join(' ')} ${rec.s}`);
        if (!hay.includes(q)) continue;
        const key = `sci:${rec.s}`;
        const displayName = taxonomy.resolveCommonName(rec, lang);
        if (!dedupe.has(key)) {
          dedupe.set(key, {
            name: displayName || rec.s,
            scientificName: rec.s,
            detail: buildMatchDetail(rec, q, lang),
          });
        }
        if (dedupe.size >= limit * 3) break;
      }
    }

    const out = [];
    for (const item of dedupe.values()) {
      if (q) {
        const sci = item.scientificName;
        const rec = sci ? taxonomy.resolve(sci) : null;
        if (rec?.n) {
          const allNames = Object.values(rec.n);
          const hay = normalizeSearch(`${allNames.join(' ')} ${rec.s}`);
          if (!hay.includes(q)) continue;
          if (!item.detail) item.detail = buildMatchDetail(rec, q, lang);
        } else {
          const hay = normalizeSearch(`${item.name} ${sci || ''}`);
          if (!hay.includes(q)) continue;
        }
      }
      out.push(item);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out.slice(0, Math.max(1, limit));
  };
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
  document.body.appendChild(dropdown);

  let activeIndex = -1;
  let items: any = [];
  let destroyed = false;

  function positionDropdown() {
    const r = inner.getBoundingClientRect();
    dropdown.style.position = 'fixed';
    dropdown.style.top = (r.bottom + 2) + 'px';
    dropdown.style.left = r.left + 'px';
    dropdown.style.width = Math.max(r.width, 200) + 'px';
    dropdown.style.zIndex = '9999';
  }

  function updateHighlight() {
    for (let i = 0; i < items.length; i++) items[i].classList.toggle('active', i === activeIndex);
    if (activeIndex >= 0 && items[activeIndex]) items[activeIndex].scrollIntoView({ block: 'nearest' });
  }

  function renderDropdown() {
    if (destroyed) return;
    const query = input.value.trim();
    dropdown.innerHTML = '';
    items = [];
    activeIndex = -1;
    positionDropdown();

    const suggestions = getSuggestions(query, 16);

    if (suggestions.length === 0 && query) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'species-search-item';
      row.innerHTML = `<span class="search-name">Create: <b>${escHtml(query)}</b></span>`;
      row.addEventListener('mousedown', (e) => { e.preventDefault(); selectEntry({ name: query, scientificName: '' }); });
      dropdown.appendChild(row);
      items.push(row);
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
      row.addEventListener('mousedown', (e) => { e.preventDefault(); selectEntry(s); });
      row.addEventListener('pointerenter', () => { activeIndex = items.indexOf(row); updateHighlight(); });
      dropdown.appendChild(row);
      items.push(row);
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
