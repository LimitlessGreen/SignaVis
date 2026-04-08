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
export function normalizeSearch(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * Build a detail string with flags of languages that matched the query.
 * Returns e.g. "🇩🇪 Kohlmeise · 🇫🇷 Mésange charbonnière".
 */
export function buildMatchDetail(record, query, displayLang) {
  if (!query || !record?.n) return '';
  const q = normalizeSearch(query);
  const parts = [];
  for (const [lang, name] of Object.entries(record.n)) {
    if (lang === displayLang) continue;
    if (!normalizeSearch(name).includes(q)) continue;
    const flag = LANG_FLAGS[lang] || lang;
    parts.push(`${flag}\u00a0${name}`);
    if (parts.length >= 3) break;
  }
  return parts.join(' \u00b7 ');
}

/**
 * Populate a `<select>` element with taxonomy languages + scientific option.
 *
 * @param {HTMLSelectElement} selectEl
 * @param {import('../../src/taxonomyResolver.js').TaxonomyResolver} taxonomy
 * @param {string} [defaultLang]  Language code to pre-select (from URL param etc.)
 * @returns {string} The resolved initial language value
 */
export function populateLanguageSelect(selectEl, taxonomy, defaultLang = '') {
  const langs = taxonomy.languages.slice().sort((a, b) => a.localeCompare(b));
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
 * @param {import('../../src/taxonomyResolver.js').TaxonomyResolver} opts.taxonomy
 * @param {() => string} opts.getLang    Returns current display language
 * @param {() => Array}  opts.getLabels  Returns current label array
 * @param {() => Array}  opts.getPool    Returns XC label pool array
 * @returns {(query: string, limit?: number) => Array}
 */
export function createSuggestionProvider({ taxonomy, getLang, getLabels, getPool }) {
  return (query, limit = 14) => {
    const q = normalizeSearch(query);
    const lang = getLang();
    const dedupe = new Map();

    dedupe.set('name:noise', { name: 'Noise', scientificName: '' });

    for (const item of getPool()) {
      const name = String(item?.name || '').trim();
      const sci = String(item?.scientificName || '').trim();
      if (!name) continue;
      const key = sci ? `sci:${sci}` : `name:${name.toLowerCase()}`;
      if (!dedupe.has(key)) dedupe.set(key, { name, scientificName: sci });
    }

    for (const lbl of getLabels()) {
      const sci = String(lbl?.scientificName || '').trim();
      const record = sci ? taxonomy.resolve(sci) : null;
      const localized = record ? taxonomy.resolveCommonName(record, lang) : '';
      const name = String(localized || lbl?.commonName || lbl?.label || sci).trim();
      if (!name) continue;
      const key = sci ? `sci:${sci}` : `name:${name.toLowerCase()}`;
      if (!dedupe.has(key)) dedupe.set(key, { name, scientificName: sci });
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
