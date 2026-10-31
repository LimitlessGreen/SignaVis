/**
 * Reference Calls Modal
 *
 * Compares a labeled segment against Xeno-Canto reference recordings of the
 * same (or a searched) species.
 *
 * Layout:
 *   ┌───────────────────────────────────────────────────────────────────┐
 *   │ [img] Common name / Sci name   [species search]   keys hint   [×]  │
 *   ├─────────────────────────────────────────────┬─────────────────────┤
 *   │ YOUR RECORDING                              │ Quality A · 312 rec │
 *   │ ┌─────────────────────────────────────────┐ │ ── song ──────────  │
 *   │ │ player (labeled segment)                │ │ [sono] XC1234 A 0:05│
 *   │ └─────────────────────────────────────────┘ │ [sono] XC2345 B 0:03│
 *   │ REFERENCE — XC1234 · song · A · DE · ↗      │ ── call ──────────  │
 *   │ ┌─────────────────────────────────────────┐ │ [sono] …            │
 *   │ │ player (selected candidate, lazy)       │ │                     │
 *   │ └─────────────────────────────────────────┘ │  ← 1 / 12 →         │
 *   └─────────────────────────────────────────────┴─────────────────────┘
 *
 * Keyboard (the modal owns the keyboard while open; no player listens to
 * document keys): Space play/pause focused side · ↑↓ / J K candidate ·
 * R own recording · F reference · A play own segment then reference.
 * Only one player ever plays at a time.
 */

import { createSpeciesSearchWidget } from '../taxonomy-ui/taxonomy-ui.ts';
import ModalManager from '../modal/modal-manager.ts';

const XC_API = 'https://xeno-canto.org/api/3/recordings';
const BIRD_IMG_BASE = './data/species_images/';
const FALLBACK_SVG = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 72 72'%3E%3Crect width='72' height='72' fill='%23303030'/%3E%3Cpath d='M36 18c-6 0-11 4-13 9l-5-3c-1-1-3 0-2 2l4 7c-1 2-2 4-2 7 0 8 8 14 18 14s18-6 18-14c0-2-1-4-2-6l5-8c1-2-1-3-2-2l-6 4c-2-6-7-10-13-10z' fill='%23555'/%3E%3C/svg%3E`;

const PLAYER_HEIGHT = 230;
const AUDIO_CACHE_MAX = 24;

// Shared player options: spectrogram only, no chrome, own keyboard handling.
// The reference players keep their own spectrogram settings on purpose.
const PLAYER_OPTS = {
  showOverview: false, showFileOpen: false, showTime: true,
  showVolume: false, showViewToggles: false, showZoom: false,
  showFFTControls: false, showDisplayGain: false, showStatusbar: false,
  transportStyle: 'hero', transportOverlay: false, viewMode: 'spectrogram',
  keyboardShortcuts: false,
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
}
.rc-dialog {
  display: flex; flex-direction: column; width: 100%;
  background: var(--color-bg-primary); overflow: hidden;
}
.rc-header {
  display: flex; align-items: center; gap: 14px;
  padding: 10px 16px; border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-surface); flex-shrink: 0; flex-wrap: wrap;
}
.rc-species { display: flex; align-items: center; gap: 10px; min-width: 0; }
.rc-species-img {
  width: 48px; height: 48px; border-radius: 6px; object-fit: cover;
  background: #111; border: 1px solid var(--color-border); flex-shrink: 0;
}
.rc-species-common { font-size: 16px; font-weight: 700; color: var(--color-text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rc-species-sci { font-size: 12px; font-style: italic; color: var(--color-text-secondary); }
.rc-search { flex: 1; min-width: 220px; max-width: 420px; }
.rc-search .species-search-widget { width: 100%; }
.rc-keys { font-size: 11px; color: var(--color-text-secondary); margin-left: auto; white-space: nowrap; }
.rc-keys kbd {
  display: inline-block; padding: 0 4px; margin: 0 1px; border-radius: 3px;
  border: 1px solid var(--color-border); background: var(--color-bg-primary);
  font: 10px/16px ui-monospace, monospace;
}
.rc-close {
  background: none; border: none; cursor: pointer; padding: 4px 8px;
  color: var(--color-text-secondary); font-size: 20px; line-height: 1; border-radius: 4px;
}
.rc-close:hover { background: var(--color-bg-primary); color: var(--color-text-primary); }
.rc-main { flex: 1; min-height: 0; display: flex; }
.rc-compare { flex: 1; min-width: 0; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 14px; }
.rc-side { display: flex; flex-direction: column; gap: 6px; }
.rc-side-title {
  font-size: 11px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase;
  color: var(--color-text-secondary); display: flex; align-items: center; gap: 8px; min-height: 18px;
}
.rc-side-title .rc-side-meta { text-transform: none; letter-spacing: 0; font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rc-side-title a { color: var(--color-accent); text-decoration: none; text-transform: none; }
.rc-player {
  height: ${PLAYER_HEIGHT}px; border-radius: 8px; overflow: hidden;
  background: var(--color-bg-surface); border: 2px solid transparent;
}
.rc-side.rc-focused .rc-player { border-color: var(--color-accent); }
.rc-side.rc-focused .rc-side-title { color: var(--color-accent); }
.rc-list {
  width: 380px; flex-shrink: 0; border-left: 1px solid var(--color-border);
  display: flex; flex-direction: column; min-height: 0; background: var(--color-bg-surface);
}
.rc-list-body { flex: 1; overflow-y: auto; padding: 8px 10px; }
.rc-info { font-size: 11px; color: var(--color-text-secondary); margin: 2px 2px 8px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.rc-badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-weight: 600; font-size: 10px; background: var(--color-accent-faint); color: var(--color-accent); }
.rc-badge.rc-warn { background: rgba(234,179,8,0.15); color: #b45309; }
.rc-group-label {
  font-size: 11px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase;
  color: var(--color-text-secondary); margin: 10px 2px 6px; display: flex; align-items: center; gap: 8px;
}
.rc-group-label::after { content: ''; flex: 1; height: 1px; background: var(--color-border); }
.rc-item {
  display: flex; flex-direction: column; gap: 4px; padding: 6px; margin-bottom: 6px;
  border: 1px solid var(--color-border); border-radius: 6px; cursor: pointer;
  background: var(--color-bg-primary); transition: border-color 0.12s, box-shadow 0.12s;
}
.rc-item:hover { border-color: var(--color-accent); }
.rc-item.rc-selected { border-color: var(--color-accent); box-shadow: 0 0 0 2px var(--color-accent); }
.rc-item-sono { height: 54px; border-radius: 4px; overflow: hidden; background: #111; }
.rc-item-sono img { width: 100%; height: 100%; object-fit: cover; object-position: left center; display: block; }
.rc-item-head { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; color: var(--color-text-primary); }
.rc-item-head .rc-len { margin-left: auto; font-weight: 400; color: var(--color-text-secondary); }
.rc-item-meta { font-size: 11px; color: var(--color-text-secondary); line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rc-pagination {
  display: flex; align-items: center; justify-content: center; gap: 10px;
  padding: 8px; border-top: 1px solid var(--color-border); flex-shrink: 0;
}
.rc-pagination button {
  padding: 4px 12px; border-radius: 6px; border: 1px solid var(--color-border);
  background: var(--color-bg-primary); color: var(--color-text-primary); cursor: pointer; font-size: 12px;
}
.rc-pagination button:hover:not(:disabled) { border-color: var(--color-accent); }
.rc-pagination button:disabled { opacity: 0.4; cursor: default; }
.rc-page-info { font-size: 12px; color: var(--color-text-secondary); min-width: 60px; text-align: center; }
.rc-status { padding: 24px 16px; text-align: center; color: var(--color-text-secondary); font-size: 13px; }
.rc-status-error { color: var(--color-error, #ef4444); }
@media (max-width: 820px) {
  .rc-main { flex-direction: column; }
  .rc-list { width: auto; border-left: none; border-top: 1px solid var(--color-border); max-height: 45vh; }
  .rc-keys { display: none; }
}
`;
  document.head.appendChild(s);
}

// ─── Helpers ────────────────────────────────────────────────────────

// Shorten a Creative Commons URL to a readable label, e.g. "CC BY-NC-SA 4.0"
function formatLicense(lic: any) {
  if (!lic) return null;
  const m = String(lic).match(/creativecommons\.org\/licenses\/([^/]+)\/([^/]+)/i);
  if (m) return `CC ${m[1].toUpperCase()} ${m[2]}`;
  if (/publicdomain|zero|cc0/i.test(lic)) return 'CC0';
  return null; // unknown format — show nothing rather than a raw URL
}

function parseXcLen(len: any) {
  if (!len) return 0;
  const parts = String(len).split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

function fmtLen(len: any) {
  const s = parseXcLen(len);
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

function esc(s: any) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function absUrl(u: any) {
  if (!u) return '';
  const s = String(u);
  return s.startsWith('//') ? `https:${s}` : s;
}

function groupByType(recordings: any[], preferredType: string) {
  const groups = new Map<string, any[]>();
  for (const rec of recordings) {
    const t = (rec.type || 'unknown').toLowerCase().trim() || 'unknown';
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t)!.push(rec);
  }
  // Preferred type first, then alphabetical
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

function isTyping(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

// Fully disable labeling on a player: blocks both drawMode and Shift+drag.
function disableLabeling(p: any) {
  for (const layer of [p.spectrogramLabels, p.annotations]) {
    if (!layer) continue;
    layer.drawMode = false;
    if (layer.overlay) layer.overlay.style.pointerEvents = 'none';
  }
  if (p._drawBtn)  p._drawBtn.hidden  = true;
  if (p._stampBtn) p._stampBtn.hidden = true;
}

const el = (tag: string, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// ─── Main export ────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {object}   opts.xcPanel        XenoCantoPanel instance (for apiKey + fetchAudio)
 * @param {function} opts.getSuggestions Species suggestion provider
 * @param {function} opts.BirdNETPlayer  BirdNETPlayer constructor
 * @param {function} [opts.resolveSci]   vernacular → scientific name
 * @param {object}   opts.taxonomy       TaxonomyResolver instance
 * @param {function} opts.getLang        Function returning current language code
 * @param {function} [opts.getMainPlayer] Main app player (paused on open)
 */
export function createReferenceCallsModal({ xcPanel, getSuggestions, BirdNETPlayer, resolveSci = () => '', taxonomy, getLang, getMainPlayer }: any) {
  injectCss();

  // ── DOM ──────────────────────────────────────────────────────────
  const backdrop = el('div', 'rc-backdrop');
  backdrop.hidden = true;
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  const dialog = el('div', 'rc-dialog');
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);

  // Header: species · search · key hints · close
  const header = el('div', 'rc-header');
  const speciesEl = el('div', 'rc-species');
  const searchWrap = el('div', 'rc-search');
  const keys = el('div', 'rc-keys');
  keys.innerHTML = '<kbd>Space</kbd> play · <kbd>↑</kbd><kbd>↓</kbd> candidate · <kbd>R</kbd>/<kbd>F</kbd> own/reference · <kbd>A</kbd> A/B';
  const closeBtn = el('button', 'rc-close', '×') as HTMLButtonElement;
  closeBtn.title = 'Close (Esc)';
  header.append(speciesEl, searchWrap, keys, closeBtn);
  dialog.appendChild(header);

  const main = el('div', 'rc-main');
  dialog.appendChild(main);

  // Compare column: own recording above, selected reference below
  const compare = el('div', 'rc-compare');
  const ownSide = el('div', 'rc-side');
  const ownTitle = el('div', 'rc-side-title');
  const ownPlayerWrap = el('div', 'rc-player');
  ownSide.append(ownTitle, ownPlayerWrap);
  const refSide = el('div', 'rc-side');
  const refTitle = el('div', 'rc-side-title');
  const refPlayerWrap = el('div', 'rc-player');
  refSide.append(refTitle, refPlayerWrap);
  compare.append(ownSide, refSide);
  main.appendChild(compare);

  // Candidate list
  const list = el('div', 'rc-list');
  const listBody = el('div', 'rc-list-body');
  const pagination = el('div', 'rc-pagination');
  const prevBtn = el('button', '', '← Prev') as HTMLButtonElement;
  const pageInfo = el('div', 'rc-page-info');
  const nextBtn = el('button', '', 'Next →') as HTMLButtonElement;
  pagination.append(prevBtn, pageInfo, nextBtn);
  list.append(listBody, pagination);
  main.appendChild(list);

  const requestClose = () => { cleanup(); manager.close(); };
  const manager = new ModalManager({ backdrop: backdrop as any, dialog: dialog as any, onClose: requestClose } as any);
  closeBtn.addEventListener('click', requestClose);

  // ── State ────────────────────────────────────────────────────────
  let _label: any = null;
  let _sciName = '';
  let _page = 1;
  let _totalPages = 1;
  let _preferredType = '';
  let _searchWidget: any = null;
  let _loadToken = 0;          // invalidates stale page loads
  let _activeTier = 0;         // index into QUALITY_TIERS

  let _ownPlayer: any = null;
  let _refPlayer: any = null;
  let _refBlobUrl: string | null = null;
  let _refToken = 0;           // invalidates stale reference loads

  let _items: { el: HTMLElement, rec: any }[] = [];
  let _selected = -1;          // index into _items
  let _focus: 'own' | 'ref' = 'own';
  let _abPending = false;      // A/B: play reference once own segment ends
  let _ownClip = false;        // stop own playback at the label end

  const _audioCache = new Map<string, ArrayBuffer>();

  // ── Playback coordination ─────────────────────────────────────────
  const players = () => [_ownPlayer, _refPlayer].filter(Boolean);
  function stopAll() { for (const p of players()) if (p.isPlaying) p.pause(); }

  /** Only one player may play: when one starts, pause the other. */
  function watchPlayer(p: any) {
    p.on?.('play', () => {
      for (const other of players()) if (other !== p && other.isPlaying) other.pause();
    });
  }

  function seek(p: any, t: number) {
    try { p._state?._seekToTime?.(t, true); } catch {}
  }

  function segment() {
    const s = Number(_label?.start), e = Number(_label?.end);
    return Number.isFinite(s) && Number.isFinite(e) && e > s ? { start: s, end: e } : null;
  }

  function playOwn() {
    if (!_ownPlayer) return;
    stopAll();
    const seg = segment();
    const t = _ownPlayer.currentTime || 0;
    if (seg && (t < seg.start || t >= seg.end - 0.02)) seek(_ownPlayer, seg.start);
    _ownPlayer.play();
  }

  function playRef() {
    if (!_refPlayer) return;
    stopAll();
    if (_refPlayer.duration && _refPlayer.currentTime >= _refPlayer.duration - 0.05) seek(_refPlayer, 0);
    _refPlayer.play();
  }

  function toggle(side: 'own' | 'ref') {
    const p = side === 'own' ? _ownPlayer : _refPlayer;
    if (!p) return;
    _abPending = false;
    if (p.isPlaying) p.pause();
    else if (side === 'own') playOwn();
    else playRef();
  }

  /** A/B: own segment, then the selected reference from its start. */
  function playAB() {
    if (!_ownPlayer || !_refPlayer) return;
    seek(_refPlayer, 0);
    playOwn();
    _abPending = true;
  }

  function onOwnSegmentEnd() {
    const seg = segment();
    if (seg) seek(_ownPlayer, seg.start);
    if (_abPending) { _abPending = false; playRef(); }
  }

  function setFocus(side: 'own' | 'ref') {
    _focus = side;
    ownSide.classList.toggle('rc-focused', side === 'own');
    refSide.classList.toggle('rc-focused', side === 'ref');
  }

  // ── Keyboard (window capture: runs before every document listener) ─
  function onKeyDown(e: KeyboardEvent) {
    if (backdrop.hidden || e.key === 'Escape' || e.key === 'Tab') return;
    if (isTyping(e.target)) return;
    let handled = true;
    switch (e.code) {
      case 'Space': toggle(_focus); break;
      case 'ArrowDown': case 'KeyJ': selectItem(_selected + 1); break;
      case 'ArrowUp':   case 'KeyK': selectItem(_selected - 1); break;
      case 'KeyR': setFocus('own'); break;
      case 'KeyF': setFocus('ref'); break;
      case 'KeyA': playAB(); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
    // Swallow everything so the main player underneath stays quiet.
    e.stopImmediatePropagation();
  }
  window.addEventListener('keydown', onKeyDown, true);
  ownSide.addEventListener('pointerdown', () => setFocus('own'));
  refSide.addEventListener('pointerdown', () => setFocus('ref'));

  // ── Header: species + search ──────────────────────────────────────
  function renderSpecies(sciName: string, fallbackName = '') {
    const record = sciName ? taxonomy?.resolve(sciName) : null;
    const lang = getLang?.() || 'en';
    const common = (record && taxonomy.resolveCommonName(record, lang)) || fallbackName || sciName || 'Reference Calls';
    const imgSrc = sciName ? `${BIRD_IMG_BASE}${encodeURIComponent(sciName)}.webp` : FALLBACK_SVG;
    const attribution = record?.img_author ? `Image © ${record.img_author}${record.img_license ? ` (${record.img_license})` : ''}` : '';
    speciesEl.innerHTML = `
      <img class="rc-species-img" src="${esc(imgSrc)}" alt="" title="${esc(attribution)}" onerror="this.src='${FALLBACK_SVG}'" />
      <div style="min-width:0">
        <div class="rc-species-common">${esc(common)}</div>
        ${sciName && sciName !== common ? `<div class="rc-species-sci">${esc(sciName)}</div>` : ''}
      </div>`;
  }

  function mountSearchWidget(initialSciName: string, displayName: string) {
    if (_searchWidget) {
      try { _searchWidget.el?.remove(); } catch {}
      try { _searchWidget.destroy?.(); } catch {}
    }
    _searchWidget = createSpeciesSearchWidget({
      getSuggestions,
      placeholder: 'Compare with species…',
      initialValue: displayName || initialSciName,
      onSelect: (item: any) => {
        // Prefer the explicit scientific name; resolve vernacular names via taxonomy
        let sci = item?.scientificName || '';
        if (!sci && item?.name) sci = resolveSci(item.name) || '';
        if (!sci) sci = item?.name || '';
        if (!sci) return;
        _sciName = sci;
        renderSpecies(sci);
        loadPage(1);
      },
    });
    searchWrap.appendChild(_searchWidget.el);
  }

  // ── Own recording ─────────────────────────────────────────────────
  async function mountOwnPlayer(audioUrl: string, label: any) {
    ownPlayerWrap.innerHTML = '';
    try { _ownPlayer?.destroy?.(); } catch {}
    _ownPlayer = null;
    const seg = segment();
    ownTitle.innerHTML = `<span>Your recording</span>`
      + (seg ? `<span class="rc-side-meta">${esc(label?.label || '')} · ${seg.start.toFixed(2)}–${seg.end.toFixed(2)} s</span>` : '');
    if (!audioUrl || !BirdNETPlayer) {
      ownPlayerWrap.innerHTML = '<div class="rc-status">No audio for this label.</div>';
      return;
    }
    const inner = el('div');
    inner.style.height = '100%';
    ownPlayerWrap.appendChild(inner);
    try {
      const p = new BirdNETPlayer(inner, { ...PLAYER_OPTS, height: PLAYER_HEIGHT });
      await p.ready;
      await p.loadUrl(audioUrl);
      if (!inner.isConnected) { p.destroy?.(); return; }
      _ownPlayer = p;
      watchPlayer(p);
      disableLabeling(p);
      p.on('timeupdate', (e: any) => {
        const s = segment();
        if (!_ownClip || !s || !p.isPlaying) return;
        if ((e.detail?.currentTime ?? p.currentTime) >= s.end) { p.pause(); onOwnSegmentEnd(); }
      });
      // Clip to the label only when playback starts inside the segment
      // (clicking elsewhere in the spectrogram plays freely).
      p.on('play', () => {
        const s = segment(), t = p.currentTime || 0;
        _ownClip = !!s && t >= s.start - 0.05 && t < s.end;
      });
      p.on('finish', () => { _ownClip = false; if (_abPending) { _abPending = false; playRef(); } });
      if (seg) {
        // Highlight the labeled segment as readonly (no drag/resize/edit/delete).
        p.setSpectrogramLabels([{
          start: seg.start, end: seg.end,
          freqMin: label.freqMin, freqMax: label.freqMax,
          label: label.label || label.scientificName || '',
          color: 'rgba(59,130,246,0.25)',
          readonly: true,
        }]);
        seek(p, seg.start);
      }
    } catch (err) {
      ownPlayerWrap.innerHTML = `<div class="rc-status rc-status-error">Could not load recording: ${esc((err as any)?.message || String(err))}</div>`;
    }
  }

  // ── Selected reference (lazy) ─────────────────────────────────────
  function destroyRefPlayer() {
    try { _refPlayer?.destroy?.(); } catch {}
    _refPlayer = null;
    if (_refBlobUrl) { try { URL.revokeObjectURL(_refBlobUrl); } catch {} _refBlobUrl = null; }
  }

  function renderRefTitle(rec: any) {
    if (!rec) { refTitle.innerHTML = '<span>Reference</span>'; return; }
    const lic = formatLicense(rec.lic);
    const meta = [rec.type, rec.q && `Q ${rec.q}`, fmtLen(rec.len), rec.cnt, rec.rec, lic].filter(Boolean).map(esc).join(' · ');
    refTitle.innerHTML = `<span>Reference — XC${esc(rec.id)}</span><span class="rc-side-meta">${meta}</span>`
      + `<a href="https://xeno-canto.org/${esc(rec.id)}" target="_blank" rel="noopener noreferrer" title="Open on xeno-canto">↗</a>`;
  }

  async function getAudio(xcId: string): Promise<ArrayBuffer> {
    const hit = _audioCache.get(xcId);
    if (hit) return hit;
    const data = await xcPanel.fetchAudio(xcId);
    const buf: ArrayBuffer = data.buffer;
    _audioCache.set(xcId, buf);
    while (_audioCache.size > AUDIO_CACHE_MAX) _audioCache.delete(_audioCache.keys().next().value!);
    return buf;
  }

  async function showReference(rec: any) {
    const token = ++_refToken;
    _abPending = false;
    destroyRefPlayer();
    renderRefTitle(rec);
    refPlayerWrap.innerHTML = rec ? '<div class="rc-status">Loading…</div>' : '<div class="rc-status">Select a candidate on the right.</div>';
    if (!rec || !BirdNETPlayer) return;
    try {
      const buf = await getAudio(String(rec.id));
      if (token !== _refToken) return;
      const blobUrl = URL.createObjectURL(new Blob([buf.slice(0)], { type: 'audio/mpeg' }));
      refPlayerWrap.innerHTML = '';
      const inner = el('div');
      inner.style.height = '100%';
      refPlayerWrap.appendChild(inner);
      const p = new BirdNETPlayer(inner, { ...PLAYER_OPTS, height: PLAYER_HEIGHT });
      await p.ready;
      await p.loadUrl(blobUrl);
      if (token !== _refToken) { try { p.destroy?.(); } catch {} URL.revokeObjectURL(blobUrl); return; }
      _refPlayer = p;
      _refBlobUrl = blobUrl;
      watchPlayer(p);
      disableLabeling(p);
      prefetchNext();
    } catch (err) {
      if (token === _refToken) {
        refPlayerWrap.innerHTML = `<div class="rc-status rc-status-error">${esc((err as any)?.message || 'Load failed')}</div>`;
      }
    }
  }

  /** Warm the cache for the next candidate so ↓ feels instant. */
  function prefetchNext() {
    const next = _items[_selected + 1]?.rec;
    if (next && !_audioCache.has(String(next.id))) getAudio(String(next.id)).catch(() => {});
  }

  function selectItem(idx: number) {
    if (!_items.length) return;
    const i = Math.max(0, Math.min(idx, _items.length - 1));
    if (i === _selected && _refPlayer) { setFocus('ref'); return; }
    _selected = i;
    _items.forEach((it, j) => it.el.classList.toggle('rc-selected', j === i));
    _items[i].el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    setFocus('ref');
    showReference(_items[i].rec);
  }

  // ── XC API search (with quality fallback) ────────────────────────
  // Quality ladder: A only → A+B → any quality (no filter)
  const QUALITY_TIERS = [
    { label: 'Quality A',     filter: 'q:A'   },
    { label: 'Quality A & B', filter: 'q:A+q:B' },
    { label: 'Any quality',   filter: ''        },
  ];

  async function _fetchPage(baseQuery: string, qualityFilter: string, page: number, apiKey: string) {
    const q = qualityFilter ? `${baseQuery}+${qualityFilter}+len:2-7` : `${baseQuery}+len:2-7`;
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

  async function fetchXcRecordings(sciName: string, page = 1) {
    const [genus = '', epithet = ''] = sciName.trim().split(/\s+/);
    if (!genus) throw new Error('Invalid scientific name');
    const apiKey = xcPanel.apiKey;
    if (!apiKey) throw new Error('XC API key required to browse reference calls. Add your key in the XC API panel.');

    let baseQuery = `gen:${encodeURIComponent(genus)}`;
    if (epithet) baseQuery += `+sp:${encodeURIComponent(epithet)}`;

    // Page 1 decides the tier; later pages reuse it.
    if (page > 1) {
      const tier = QUALITY_TIERS[_activeTier];
      return { ...(await _fetchPage(baseQuery, tier.filter, page, apiKey)), qualityLabel: tier.label };
    }
    for (let i = 0; i < QUALITY_TIERS.length; i++) {
      const tier = QUALITY_TIERS[i];
      const result = await _fetchPage(baseQuery, tier.filter, 1, apiKey);
      if (result.recordings.length > 0 || i === QUALITY_TIERS.length - 1) {
        _activeTier = i;
        return { ...result, qualityLabel: tier.label };
      }
    }
    return { recordings: [], numPages: 1, numRecordings: 0, qualityLabel: 'Any quality' };
  }

  // ── Candidate list ────────────────────────────────────────────────
  function renderItem(rec: any) {
    const item = el('div', 'rc-item');
    const sono = absUrl(rec.sono?.med || rec.sono?.small);
    const meta = [rec.type, rec.cnt, rec.rec].filter(Boolean).map(esc).join(' · ');
    item.innerHTML = `
      <div class="rc-item-sono">${sono ? `<img src="${esc(sono)}" alt="" loading="lazy" />` : ''}</div>
      <div class="rc-item-head">
        <span>XC${esc(rec.id)}</span>
        ${rec.q ? `<span class="rc-badge">${esc(rec.q)}</span>` : ''}
        <span class="rc-len">${esc(fmtLen(rec.len))}</span>
      </div>
      <div class="rc-item-meta" title="${meta}">${meta}</div>`;
    const idx = _items.push({ el: item, rec }) - 1;
    item.addEventListener('click', () => selectItem(idx));
    return item;
  }

  async function loadPage(page: number) {
    const token = ++_loadToken;
    _page = page;
    _items = [];
    _selected = -1;
    showReference(null);
    listBody.innerHTML = '<div class="rc-status">Loading XC recordings…</div>';
    prevBtn.disabled = nextBtn.disabled = true;
    pageInfo.textContent = '';

    try {
      const { recordings, numPages, numRecordings, qualityLabel } = await fetchXcRecordings(_sciName, page);
      if (token !== _loadToken) return;
      _totalPages = numPages;
      listBody.innerHTML = '';

      if (recordings.length === 0) {
        listBody.innerHTML = `<div class="rc-status">No recordings found for <em>${esc(_sciName)}</em> between 2–7 seconds.</div>`;
      } else {
        const info = el('div', 'rc-info');
        info.innerHTML = `<span class="rc-badge ${_activeTier > 0 ? 'rc-warn' : ''}">${esc(qualityLabel)}</span>`
          + `<span>${numRecordings} recordings</span>`
          + (_activeTier > 0 ? '<span>· no quality-A recordings found</span>' : '');
        listBody.appendChild(info);

        const groups = groupByType(recordings, _preferredType);
        for (const [type, recs] of groups) {
          if (groups.length > 1) listBody.appendChild(el('div', 'rc-group-label', type.charAt(0).toUpperCase() + type.slice(1)));
          for (const rec of recs) listBody.appendChild(renderItem(rec));
        }
        selectItem(0);
        setFocus('own');
      }
      pageInfo.textContent = `${page} / ${numPages}`;
      prevBtn.disabled = page <= 1;
      nextBtn.disabled = page >= numPages;
    } catch (err) {
      if (token !== _loadToken) return;
      listBody.innerHTML = `<div class="rc-status rc-status-error">${esc((err as any)?.message || String(err))}</div>`;
    }
  }

  prevBtn.addEventListener('click', () => { if (_page > 1) loadPage(_page - 1); });
  nextBtn.addEventListener('click', () => { if (_page < _totalPages) loadPage(_page + 1); });

  // ── Public API ────────────────────────────────────────────────────
  function open(label: any, audioUrl: any) {
    _label = label;
    _preferredType = label?.type || label?.callType || '';
    const sci = label?.scientificName || '';
    const displayName = label?.label || label?.commonName || sci;
    _sciName = sci;

    try { const mp = getMainPlayer?.(); if (mp?.isPlaying) mp.pause(); } catch {}
    renderSpecies(sci, displayName);
    mountSearchWidget(sci, displayName);
    manager.open();
    setFocus('own');
    mountOwnPlayer(audioUrl, label);

    if (sci) {
      loadPage(1);
    } else {
      _items = [];
      showReference(null);
      listBody.innerHTML = '<div class="rc-status">No species name on this label. Use the search field above to look up a species.</div>';
      pageInfo.textContent = '';
      prevBtn.disabled = nextBtn.disabled = true;
    }
  }

  function cleanup() {
    _loadToken++;
    _refToken++;
    _abPending = false;
    destroyRefPlayer();
    try { _ownPlayer?.destroy?.(); } catch {}
    _ownPlayer = null;
    _items = [];
    if (_searchWidget) { try { _searchWidget.destroy?.(); } catch {} _searchWidget = null; }
  }

  return { open, close: requestClose };
}
