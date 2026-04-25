/**
 * Reference Calls Modal
 *
 * Opens a full-screen modal that lets the user compare a labeled segment
 * against Xeno-Canto reference recordings of the same (or searched) species.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  Reference Calls — Turdus merula                       [×]  │
 *   │  [Species search ─────────────────────────────────────────]  │
 *   ├──────────────────────────────────────────────────────────────┤
 *   │  Your recording (reference segment)                          │
 *   │  ┌────────────────────────────────────────────────────────┐  │
 *   │  │  compact BirdNETPlayer with the labeled segment        │  │
 *   │  └────────────────────────────────────────────────────────┘  │
 *   ├──────────────────────────────────────────────────────────────┤
 *   │  XC Recordings — Quality A       ← page 1 of N →           │
 *   │  [group: song] ─────────────────────────────────────────    │
 *   │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
 *   │  │sono image│ │sono image│ │          │ │          │       │
 *   │  │ ▶ XC1234 │ │ ▶ XC2345│ │  player  │ │  image   │       │
 *   │  │ A · 0:05 │ │ A · 0:03│ │(on click)│ │          │       │
 *   │  └──────────┘ └──────────┘ └──────────┘ └──────────┘       │
 *   └──────────────────────────────────────────────────────────────┘
 */

import { createSpeciesSearchWidget } from './taxonomy-ui.js';
import ModalManager from '../../src/ui/modal-manager.ts';

const XC_API = 'https://xeno-canto.org/api/3/recordings';

// Compact player options (mirrors storybook compact-embed story)
const COMPACT_PLAYER_OPTS = {
  showOverview: false, showFileOpen: false, showTime: false,
  showVolume: false, showViewToggles: false, showZoom: false,
  showFFTControls: false, showDisplayGain: false, showStatusbar: false,
  transportStyle: 'hero', transportOverlay: true, viewMode: 'spectrogram',
};

// Reference player — no overlay so the spectrogram is visible immediately
const REF_PLAYER_OPTS = {
  ...COMPACT_PLAYER_OPTS,
  transportOverlay: false,
  showTime: true,
};

// ─── CSS injected once ──────────────────────────────────────────────
let _cssInjected = false;
function injectCss() {
  if (_cssInjected) return;
  _cssInjected = true;
  const s = document.createElement('style');
  s.textContent = `
.rc-backdrop {
  position: fixed; inset: 0; z-index: 9000;
  background: rgba(0,0,0,0.6);
  display: flex; align-items: stretch; justify-content: center;
  padding: 0;
}
.rc-dialog {
  display: flex; flex-direction: column;
  width: 100%; max-width: 100%;
  background: var(--color-bg-primary);
  overflow: hidden;
}
.rc-header {
  display: flex; align-items: center; gap: 12px;
  padding: 14px 20px; border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}
.rc-title { font-size: 15px; font-weight: 700; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rc-close {
  background: none; border: none; cursor: pointer; padding: 4px 8px;
  color: var(--color-text-secondary); font-size: 18px; line-height: 1;
  border-radius: 4px;
}
.rc-close:hover { background: var(--color-bg-surface); color: var(--color-text-primary); }
.rc-search-row {
  padding: 10px 20px; border-bottom: 1px solid var(--color-border);
  flex-shrink: 0; display: flex; align-items: center; gap: 10px;
}
.rc-search-row .species-search-widget { flex: 1; max-width: 480px; }
.rc-body {
  flex: 1; overflow-y: auto; display: flex; flex-direction: column;
}
.rc-section {
  padding: 14px 20px; border-bottom: 1px solid var(--color-border); flex-shrink: 0;
}
.rc-section-title {
  font-size: 11px; font-weight: 600; letter-spacing: 0.06em;
  text-transform: uppercase; color: var(--color-text-secondary);
  margin-bottom: 10px;
}
.rc-ref-player { border-radius: 8px; overflow: hidden; min-height: 280px; background: var(--color-bg-surface); }
.rc-grid-section { flex: 1; padding: 14px 20px; min-height: 0; }
.rc-group-label {
  font-size: 11px; font-weight: 600; letter-spacing: 0.05em;
  text-transform: uppercase; color: var(--color-text-secondary);
  margin: 12px 0 8px; display: flex; align-items: center; gap: 8px;
}
.rc-group-label::after { content: ''; flex: 1; height: 1px; background: var(--color-border); }
.rc-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px; margin-bottom: 4px;
}
.rc-card {
  border: 1px solid var(--color-border); border-radius: 8px; overflow: hidden;
  background: var(--color-bg-surface); cursor: pointer; position: relative;
  transition: border-color 0.15s, box-shadow 0.15s;
  display: flex; flex-direction: column;
}
.rc-card:hover { border-color: var(--color-accent); box-shadow: 0 0 0 2px var(--color-accent-faint); }
.rc-card-header {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px; border-bottom: 1px solid var(--color-border);
  font-size: 12px; font-weight: 700; color: var(--color-text-primary);
  flex-shrink: 0;
}
.rc-card-img-wrap {
  position: relative; background: #111; height: 120px; overflow: hidden; flex-shrink: 0;
}
.rc-card-img { width: 100%; height: 100%; object-fit: cover; object-position: left center; display: block; }
.rc-card-img-placeholder {
  width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;
  color: var(--color-text-secondary); font-size: 11px;
}
.rc-card-player-wrap { height: 160px; overflow: hidden; flex-shrink: 0; }
.rc-card-meta {
  padding: 6px 10px; font-size: 11px; color: var(--color-text-secondary);
  line-height: 1.5; flex: 1;
}
.rc-card-actions {
  padding: 6px 10px; border-top: 1px solid var(--color-border); flex-shrink: 0;
}
.rc-card-play-btn {
  display: flex; align-items: center; gap: 5px; width: 100%;
  padding: 4px 8px; border-radius: 5px; border: 1px solid var(--color-border);
  background: var(--color-bg-primary); color: var(--color-text-primary);
  font-size: 11px; font-weight: 600; cursor: pointer; transition: border-color 0.15s;
}
.rc-card-play-btn:hover { border-color: var(--color-accent); color: var(--color-accent); }
.rc-card-badge {
  display: inline-block; padding: 1px 5px; border-radius: 3px;
  background: var(--color-accent-faint); color: var(--color-accent);
  font-size: 10px; font-weight: 600;
}
.rc-pagination {
  display: flex; align-items: center; justify-content: center; gap: 12px;
  padding: 14px 20px; border-top: 1px solid var(--color-border);
  flex-shrink: 0;
}
.rc-pagination button {
  padding: 5px 14px; border-radius: 6px; border: 1px solid var(--color-border);
  background: var(--color-bg-surface); color: var(--color-text-primary);
  cursor: pointer; font-size: 13px;
}
.rc-pagination button:hover { border-color: var(--color-accent); }
.rc-pagination button:disabled { opacity: 0.4; cursor: default; }
.rc-pagination-info { font-size: 13px; color: var(--color-text-secondary); min-width: 80px; text-align: center; }
.rc-status { padding: 32px 20px; text-align: center; color: var(--color-text-secondary); font-size: 13px; }
.rc-status-error { color: var(--color-error, #ef4444); }
`;
  document.head.appendChild(s);
}

// ─── Helpers ────────────────────────────────────────────────────────

// Shorten a Creative Commons URL to a readable label, e.g. "CC BY-NC-SA 4.0"
function formatLicense(lic) {
  if (!lic) return null;
  const m = String(lic).match(/creativecommons\.org\/licenses\/([^/]+)\/([^/]+)/i);
  if (m) return `CC ${m[1].toUpperCase()} ${m[2]}`;
  if (/publicdomain|zero|cc0/i.test(lic)) return 'CC0';
  return null; // unknown format — show nothing rather than a raw URL
}

function parseXcLen(len) {
  if (!len) return 0;
  const parts = String(len).split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

function fmtLen(len) {
  const s = parseXcLen(len);
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function groupByType(recordings, preferredType) {
  const groups = new Map();
  for (const rec of recordings) {
    const t = (rec.type || 'unknown').toLowerCase().trim() || 'unknown';
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(rec);
  }
  // Sort groups: preferred type first, then alphabetical
  return [...groups.entries()].sort(([a], [b]) => {
    if (preferredType) {
      const pa = a.includes(preferredType.toLowerCase());
      const pb = b.includes(preferredType.toLowerCase());
      if (pa && !pb) return -1;
      if (pb && !pa) return 1;
    }
    return a.localeCompare(b);
  });
}

// ─── Main export ────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {object}   opts.xcPanel       XenoCantoPanel instance (for apiKey + fetchAudio)
 * @param {function} opts.getSuggestions Species suggestion provider
 * @param {function} opts.BirdNETPlayer  BirdNETPlayer constructor
 */
export function createReferenceCallsModal({ xcPanel, getSuggestions, BirdNETPlayer, resolveSci = () => '' }) {
  injectCss();

  // ── DOM ──────────────────────────────────────────────────────────
  const backdrop = document.createElement('div');
  backdrop.className = 'rc-backdrop';
  backdrop.hidden = true;
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');

  const dialog = document.createElement('div');
  dialog.className = 'rc-dialog';
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);

  // Header
  const header = document.createElement('div');
  header.className = 'rc-header';
  const titleEl = document.createElement('div');
  titleEl.className = 'rc-title';
  titleEl.textContent = 'Reference Calls';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'rc-close modal-close';
  closeBtn.title = 'Close';
  closeBtn.textContent = '×';
  header.appendChild(titleEl);
  header.appendChild(closeBtn);
  dialog.appendChild(header);

  // Search row
  const searchRow = document.createElement('div');
  searchRow.className = 'rc-search-row';
  const searchLabel = document.createElement('span');
  searchLabel.style.cssText = 'font-size:12px;color:var(--color-text-secondary);white-space:nowrap';
  searchLabel.textContent = 'Search:';
  searchRow.appendChild(searchLabel);
  dialog.appendChild(searchRow);

  // Body
  const body = document.createElement('div');
  body.className = 'rc-body';
  dialog.appendChild(body);

  // Reference section (player for labeled segment)
  const refSection = document.createElement('div');
  refSection.className = 'rc-section';
  const refTitle = document.createElement('div');
  refTitle.className = 'rc-section-title';
  refTitle.textContent = 'Your Recording — Reference Segment';
  refSection.appendChild(refTitle);
  const refPlayerWrap = document.createElement('div');
  refPlayerWrap.className = 'rc-ref-player';
  refSection.appendChild(refPlayerWrap);
  body.appendChild(refSection);

  // Grid section
  const gridSection = document.createElement('div');
  gridSection.className = 'rc-grid-section';
  body.appendChild(gridSection);

  // Pagination
  const pagination = document.createElement('div');
  pagination.className = 'rc-pagination';
  const prevBtn = document.createElement('button');
  prevBtn.textContent = '← Prev';
  const pageInfo = document.createElement('div');
  pageInfo.className = 'rc-pagination-info';
  const nextBtn = document.createElement('button');
  nextBtn.textContent = 'Next →';
  pagination.appendChild(prevBtn);
  pagination.appendChild(pageInfo);
  pagination.appendChild(nextBtn);
  dialog.appendChild(pagination);

  const manager = new ModalManager({ backdrop, dialog });
  closeBtn.addEventListener('click', () => manager.close());

  // ── State ────────────────────────────────────────────────────────
  let _currentLabel = null;
  let _currentAudioUrl = null;
  let _currentSciName = '';
  let _currentPage = 1;
  let _totalPages = 1;
  let _preferredType = '';
  let _refPlayer = null;
  let _activePlayers = [];
  let _searchWidget = null;
  let _loading = false;
  let _activeTier = 0; // index into QUALITY_TIERS

  // ── Species search widget ─────────────────────────────────────────
  function mountSearchWidget(initialSciName, displayName) {
    if (_searchWidget) {
      try { _searchWidget.el?.remove(); } catch {}
      try { _searchWidget.destroy?.(); } catch {}
    }
    _searchWidget = createSpeciesSearchWidget({
      getSuggestions,
      placeholder: 'Search species…',
      initialValue: displayName || initialSciName,
      onSelect: (item) => {
        // Prefer explicit scientific name; if missing, resolve via taxonomy
        // so vernacular-language searches always query XC with the Latin name.
        let sci = item?.scientificName || '';
        if (!sci && item?.name) sci = resolveSci(item.name) || '';
        if (!sci) sci = item?.name || '';
        if (!sci) return;
        _currentSciName = sci;
        titleEl.textContent = `Reference Calls — ${sci}`;
        _currentPage = 1;
        loadPage(1);
      },
    });
    searchRow.appendChild(_searchWidget.el);
  }

  // ── Reference player (labeled segment) ───────────────────────────
  async function mountRefPlayer(audioUrl, label) {
    refPlayerWrap.innerHTML = '';
    _refPlayer?.destroy?.();
    _refPlayer = null;
    if (!audioUrl || !BirdNETPlayer) return;

    const wrap = document.createElement('div');
    wrap.style.cssText = 'height:280px;border-radius:8px;overflow:hidden';
    refPlayerWrap.appendChild(wrap);

    try {
      const p = new BirdNETPlayer(wrap, { ...REF_PLAYER_OPTS, height: 280 });
      await p.ready;
      await p.loadUrl(audioUrl);
      _refPlayer = p;

      disableLabeling(p);

      // Highlight the labeled segment as readonly (no drag/resize/edit/delete).
      if (label.start != null && label.end != null) {
        p.setSpectrogramLabels([{
          start:    label.start,  end:    label.end,
          freqMin:  label.freqMin, freqMax: label.freqMax,
          label:    label.label || label.scientificName || '',
          color:    'rgba(59,130,246,0.25)',
          readonly: true,
        }]);
        try { p._state?.seekTo?.(label.start); } catch {}
      }
    } catch (err) {
      refPlayerWrap.innerHTML = `<div class="rc-status rc-status-error">Could not load reference: ${esc(err?.message || String(err))}</div>`;
    }
  }

  // ── XC API search (with quality fallback) ────────────────────────
  // Quality ladder: A only → A+B → any quality (no filter)
  const QUALITY_TIERS = [
    { label: 'Quality A',     filter: 'q:A'   },
    { label: 'Quality A & B', filter: 'q:A+q:B' },
    { label: 'Any quality',   filter: ''        },
  ];

  async function _fetchPage(baseQuery, qualityFilter, page, apiKey) {
    const q = qualityFilter
      ? `${baseQuery}+${qualityFilter}+len:2-7`
      : `${baseQuery}+len:2-7`;
    const url = `${XC_API}?query=${q}&page=${page}&key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`XC API error: HTTP ${res.status}`);
    const data = await res.json();
    return {
      recordings:    Array.isArray(data.recordings) ? data.recordings : [],
      numPages:      parseInt(data.numPages      || '1', 10) || 1,
      numRecordings: parseInt(data.numRecordings || '0', 10) || 0,
    };
  }

  async function fetchXcRecordings(sciName, page = 1) {
    const parts = sciName.trim().split(/\s+/);
    const genus   = parts[0] || '';
    const epithet = parts[1] || '';
    if (!genus) throw new Error('Invalid scientific name');

    const apiKey = xcPanel.apiKey;
    if (!apiKey) throw new Error('XC API key required to browse reference calls. Add your key in the XC API panel.');

    let baseQuery = `gen:${encodeURIComponent(genus)}`;
    if (epithet) baseQuery += `+sp:${encodeURIComponent(epithet)}`;

    // Try each quality tier; stop as soon as we get results (page 1 decides).
    // For subsequent pages we remember which tier worked (_activeTier).
    if (page === 1) _activeTier = 0; // reset on new search

    // On page > 1 use the already-selected tier directly.
    if (page > 1) {
      const tier = QUALITY_TIERS[_activeTier];
      return { ...(await _fetchPage(baseQuery, tier.filter, page, apiKey)), qualityLabel: tier.label };
    }

    for (let i = _activeTier; i < QUALITY_TIERS.length; i++) {
      const tier = QUALITY_TIERS[i];
      const result = await _fetchPage(baseQuery, tier.filter, 1, apiKey);
      if (result.recordings.length > 0 || i === QUALITY_TIERS.length - 1) {
        _activeTier = i;
        return { ...result, qualityLabel: tier.label };
      }
    }
    return { recordings: [], numPages: 1, numRecordings: 0, qualityLabel: 'Any quality' };
  }

  // Fully disable labeling on a player: blocks both drawMode and Shift+drag.
  function disableLabeling(p) {
    for (const layer of [p.spectrogramLabels, p.annotations]) {
      if (!layer) continue;
      layer.drawMode = false;
      if (layer.overlay) layer.overlay.style.pointerEvents = 'none';
    }
    if (p._drawBtn)  p._drawBtn.hidden  = true;
    if (p._stampBtn) p._stampBtn.hidden = true;
  }

  // ── Card auto-loading ────────────────────────────────────────────
  // Players are loaded strictly one at a time. buildGrayscale +
  // colorizeSpectrogram run on the main thread; parallel loads cause jank.
  // We yield via rAF between the fetch and the player creation so the browser
  // can paint the loading state before the heavy canvas work begins.
  const _loadQueue = [];
  let _queueRunning = false;

  function enqueueLoad(fn) {
    _loadQueue.push(fn);
    if (!_queueRunning) _drainQueue();
  }
  async function _drainQueue() {
    if (_queueRunning) return;
    _queueRunning = true;
    while (_loadQueue.length) {
      const next = _loadQueue.shift();
      await next();
      // Yield a frame between cards so the browser can paint progress.
      await new Promise(r => requestAnimationFrame(r));
    }
    _queueRunning = false;
  }

  // ── Card rendering ────────────────────────────────────────────────
  function renderCard(rec) {
    const card = document.createElement('div');
    card.className = 'rc-card';

    const xcId      = rec.id || '';
    const lenStr    = fmtLen(rec.len);
    const country   = rec.cnt || '';
    const recordist = rec.rec || '';
    const type      = rec.type || '';
    const quality   = rec.q || '';
    const licLabel  = formatLicense(rec.lic);
    const licUrl    = rec.lic || null;

    // ── Header ─────────────────────────────────────────────────────
    const header = document.createElement('div');
    header.className = 'rc-card-header';
    header.innerHTML = `<span>XC${esc(xcId)}</span>`
      + (quality ? `<span class="rc-card-badge">${esc(quality)}</span>` : '')
      + (lenStr  ? `<span style="margin-left:auto;color:var(--color-text-secondary)">${esc(lenStr)}</span>` : '');
    card.appendChild(header);

    // ── Player area (auto-loads) ────────────────────────────────────
    const playerWrap = document.createElement('div');
    playerWrap.className = 'rc-card-player-wrap';
    playerWrap.innerHTML = '<div class="rc-status" style="padding:16px;font-size:11px">Loading…</div>';
    card.appendChild(playerWrap);

    // ── Metadata ────────────────────────────────────────────────────
    const meta = document.createElement('div');
    meta.className = 'rc-card-meta';
    meta.innerHTML = [
      type      && esc(type),
      country   && esc(country),
      recordist && `<span style="opacity:0.65">${esc(recordist)}</span>`,
      licLabel  && (licUrl
        ? `<a href="${esc(licUrl)}" target="_blank" rel="noopener noreferrer" style="color:var(--color-text-secondary);text-decoration:underline dotted">${esc(licLabel)}</a>`
        : `<span style="opacity:0.65">${esc(licLabel)}</span>`),
    ].filter(Boolean).join(' · ');
    card.appendChild(meta);

    // Auto-load the compact player
    enqueueLoad(() => _loadCardPlayer(playerWrap, rec));

    return card;
  }

  async function _loadCardPlayer(playerWrap, rec) {
    if (!BirdNETPlayer) return;
    const xcId = rec.id;
    try {
      const audioData = await xcPanel.fetchAudio(xcId);
      if (!playerWrap.isConnected) return; // card was removed (page change)

      const blob    = new Blob([audioData.buffer], { type: 'audio/mpeg' });
      const blobUrl = URL.createObjectURL(blob);

      // Yield before the heavy player init + spectrogram generation so the
      // browser can paint the previous card's result first.
      await new Promise(r => requestAnimationFrame(r));
      if (!playerWrap.isConnected) { URL.revokeObjectURL(blobUrl); return; }

      playerWrap.innerHTML = '';
      const inner = document.createElement('div');
      inner.style.height = '100%';
      playerWrap.appendChild(inner);

      const p = new BirdNETPlayer(inner, { ...COMPACT_PLAYER_OPTS, height: 160 });
      _activePlayers.push({ player: p, blobUrl });
      await p.ready;
      await p.loadUrl(blobUrl);
      disableLabeling(p);
    } catch (err) {
      if (playerWrap.isConnected) {
        playerWrap.innerHTML = `<div class="rc-status rc-status-error" style="padding:8px;font-size:11px">${esc(err?.message || 'Load failed')}</div>`;
      }
    }
  }

  // ── Page loading ──────────────────────────────────────────────────
  async function loadPage(page) {
    if (_loading) return;
    _loading = true;
    _currentPage = page;

    gridSection.innerHTML = '<div class="rc-status">Loading XC recordings…</div>';
    prevBtn.disabled = true;
    nextBtn.disabled = true;

    // Cancel pending loads and destroy card players from previous page
    _loadQueue.length = 0;
    for (const { player, blobUrl } of _activePlayers) {
      try { player.destroy?.(); } catch {}
      try { URL.revokeObjectURL(blobUrl); } catch {}
    }
    _activePlayers = [];

    try {
      const { recordings, numPages, numRecordings, qualityLabel } = await fetchXcRecordings(_currentSciName, page);
      _totalPages = numPages;

      if (recordings.length === 0) {
        gridSection.innerHTML = `<div class="rc-status">No recordings found for <em>${esc(_currentSciName)}</em> between 2–7 seconds.</div>`;
      } else {
        gridSection.innerHTML = '';

        // Quality + count info bar
        const infoBar = document.createElement('div');
        infoBar.style.cssText = 'font-size:11px;color:var(--color-text-secondary);margin-bottom:10px;display:flex;align-items:center;gap:8px;';
        const qualBadge = document.createElement('span');
        qualBadge.style.cssText = `display:inline-block;padding:1px 6px;border-radius:3px;font-weight:600;font-size:10px;background:${_activeTier === 0 ? 'var(--color-accent-faint)' : 'rgba(234,179,8,0.15)'};color:${_activeTier === 0 ? 'var(--color-accent)' : '#b45309'};`;
        qualBadge.textContent = qualityLabel;
        infoBar.appendChild(qualBadge);
        if (_activeTier > 0) {
          const note = document.createElement('span');
          note.textContent = 'No quality-A recordings found — showing lower qualities.';
          infoBar.appendChild(note);
        }
        gridSection.appendChild(infoBar);

        const groups = groupByType(recordings, _preferredType);
        for (const [type, recs] of groups) {
          if (groups.length > 1) {
            const gl = document.createElement('div');
            gl.className = 'rc-group-label';
            gl.textContent = type.charAt(0).toUpperCase() + type.slice(1);
            gridSection.appendChild(gl);
          }
          const grid = document.createElement('div');
          grid.className = 'rc-grid';
          for (const rec of recs.slice(0, 3)) grid.appendChild(renderCard(rec));
          gridSection.appendChild(grid);
        }
      }

      pageInfo.textContent = `${page} / ${numPages}`;
      prevBtn.disabled = page <= 1;
      nextBtn.disabled = page >= numPages;
    } catch (err) {
      gridSection.innerHTML = `<div class="rc-status rc-status-error">${esc(err?.message || String(err))}</div>`;
      pageInfo.textContent = '';
      prevBtn.disabled = true;
      nextBtn.disabled = true;
    }

    _loading = false;
  }

  prevBtn.addEventListener('click', () => { if (_currentPage > 1) loadPage(_currentPage - 1); });
  nextBtn.addEventListener('click', () => { if (_currentPage < _totalPages) loadPage(_currentPage + 1); });

  // ── Public API ────────────────────────────────────────────────────
  function open(label, audioUrl) {
    _currentLabel   = label;
    _currentAudioUrl = audioUrl;
    _currentPage    = 1;
    _preferredType  = label?.type || label?.callType || '';

    // Resolve display name and scientific name
    const sci = label?.scientificName || '';
    const displayName = label?.label || label?.commonName || sci;
    _currentSciName = sci;

    titleEl.textContent = displayName
      ? `Reference Calls — ${displayName}`
      : 'Reference Calls';

    // Mount search widget
    mountSearchWidget(sci, displayName);

    manager.open();

    // Mount reference player
    mountRefPlayer(audioUrl, label);

    // Load first page of XC recordings
    if (sci) {
      loadPage(1);
    } else {
      gridSection.innerHTML = '<div class="rc-status">No species name found on this label. Use the search field above to look up a species.</div>';
      pageInfo.textContent = '';
      prevBtn.disabled = true;
      nextBtn.disabled = true;
    }
  }

  manager.on?.('close', cleanup);
  backdrop.addEventListener('rc-close', cleanup);

  function cleanup() {
    for (const { player, blobUrl } of _activePlayers) {
      try { player.destroy?.(); } catch {}
      try { URL.revokeObjectURL(blobUrl); } catch {}
    }
    _activePlayers = [];
    try { _refPlayer?.destroy?.(); } catch {}
    _refPlayer = null;
    if (_searchWidget) { try { _searchWidget.destroy?.(); } catch {} _searchWidget = null; }
  }

  return { open, close: () => manager.close() };
}
