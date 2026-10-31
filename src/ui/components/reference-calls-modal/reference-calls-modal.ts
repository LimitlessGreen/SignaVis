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
 * R own recording · F reference · A play own segment then reference ·
 * V confirm · S use species · T use sound type · N next unconfirmed label.
 *
 * Sources: Xeno-Canto search, ★ pinned XC recordings (audio kept offline in
 * the Cache API) and own confirmed labels of the same species.
 *
 * Docked mode (⇥ in the header): the view becomes a right-hand drawer without
 * backdrop, follows the label selection of the main app and only takes keys
 * after the user clicked into it.
 *
 * The reference player jumps to the loudest section inside the label's
 * frequency band ("call"), marks it and clips playback to it.
 * Only one player ever plays at a time.
 */

import { createSpeciesSearchWidget } from '../taxonomy-ui/taxonomy-ui.ts';
import ModalManager from '../modal/modal-manager.ts';
import { findCall } from './find-call.ts';

const XC_API = 'https://xeno-canto.org/api/3/recordings';
const BIRD_IMG_BASE = './data/species_images/';
const FALLBACK_SVG = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 72 72'%3E%3Crect width='72' height='72' fill='%23303030'/%3E%3Cpath d='M36 18c-6 0-11 4-13 9l-5-3c-1-1-3 0-2 2l4 7c-1 2-2 4-2 7 0 8 8 14 18 14s18-6 18-14c0-2-1-4-2-6l5-8c1-2-1-3-2-2l-6 4c-2-6-7-10-13-10z' fill='%23555'/%3E%3C/svg%3E`;

const SPEC_HEIGHT = 300;     // spectrogram px; the player adds its own toolbar/axis
const AUDIO_CACHE_MAX = 24;

// Shared player options: spectrogram only, no chrome, own keyboard handling.
// The reference players keep their own spectrogram settings on purpose.
const PLAYER_OPTS = {
  showOverview: false, showFileOpen: false, showTime: true,
  showVolume: false, showViewToggles: false, showZoom: false,
  showFFTControls: false, showDisplayGain: false, showStatusbar: false,
  transportStyle: 'hero', transportOverlay: false, viewMode: 'spectrogram',
  keyboardShortcuts: false,
  spectrogramHeight: SPEC_HEIGHT,
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
  min-height: ${SPEC_HEIGHT}px; border-radius: 6px; overflow: hidden;
  background: var(--color-bg-surface); border: 2px solid transparent;
}
.rc-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.rc-pair > .rc-side { min-width: 0; }
.rc-viewbar { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--color-text-secondary); }
.rc-viewbar .rc-view-info { margin-right: auto; }
.rc-viewbar .rc-btn { padding: 2px 9px; }
.rc-side.rc-focused .rc-player { border-color: var(--color-accent); }
.rc-side.rc-focused .rc-side-title { color: var(--color-accent); }
.rc-decide {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 10px; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-bg-surface);
}
.rc-decide-status { font-size: 12px; color: var(--color-text-secondary); margin-right: auto; }
.rc-decide-status.rc-ok { color: var(--color-success, #16a34a); font-weight: 600; }
.rc-btn {
  padding: 4px 10px; border-radius: 6px; border: 1px solid var(--color-border);
  background: var(--color-bg-primary); color: var(--color-text-primary); font-size: 12px; cursor: pointer; white-space: nowrap;
}
.rc-btn:hover:not(:disabled) { border-color: var(--color-accent); color: var(--color-accent); }
.rc-btn:disabled { opacity: 0.4; cursor: default; }
.rc-btn.rc-primary { background: var(--color-accent); border-color: var(--color-accent); color: #fff; }
.rc-btn.rc-primary:hover:not(:disabled) { color: #fff; filter: brightness(1.1); }
.rc-btn kbd { font: 10px ui-monospace, monospace; opacity: 0.7; margin-left: 4px; }
.rc-list {
  width: 380px; flex-shrink: 0; border-left: 1px solid var(--color-border);
  display: flex; flex-direction: column; min-height: 0; background: var(--color-bg-surface);
}
.rc-filters { padding: 8px 10px; border-bottom: 1px solid var(--color-border); display: flex; flex-direction: column; gap: 5px; flex-shrink: 0; }
.rc-filter-row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.rc-filter-name { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-secondary); width: 54px; flex-shrink: 0; }
.rc-seg { display: inline-flex; border: 1px solid var(--color-border); border-radius: 4px; overflow: hidden; }
.rc-chip {
  padding: 2px 8px; border: none; border-right: 1px solid var(--color-border); border-radius: 0;
  background: var(--color-bg-primary); color: var(--color-text-secondary); font-size: 11px; cursor: pointer;
}
.rc-chip:last-child { border-right: none; }
.rc-chip:hover:not(:disabled) { color: var(--color-text-primary); background: var(--color-bg-surface); }
.rc-chip.rc-on { background: var(--color-accent); color: #fff; font-weight: 600; }
.rc-chip:disabled { opacity: 0.4; cursor: default; }
.rc-list-body { flex: 1; overflow-y: auto; padding: 8px 10px; }
.rc-info { font-size: 11px; color: var(--color-text-secondary); margin: 2px 2px 8px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.rc-badge { display: inline-block; padding: 1px 6px; border-radius: 2px; font-weight: 600; font-size: 10px; background: var(--color-accent-faint); color: var(--color-accent); }
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
.rc-pin {
  margin-left: 4px; background: none; border: none; cursor: pointer; padding: 0 2px;
  font-size: 14px; line-height: 1; color: var(--color-text-secondary);
}
.rc-pin:hover, .rc-pin.rc-on { color: #eab308; }
.rc-item-own { height: 54px; border-radius: 4px; background: var(--color-bg-surface); display: flex; align-items: center; justify-content: center; font-size: 11px; color: var(--color-text-secondary); }
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
.rc-dock {
  background: none; border: 1px solid var(--color-border); cursor: pointer; padding: 3px 8px;
  color: var(--color-text-secondary); font-size: 12px; border-radius: 4px; white-space: nowrap;
}
.rc-dock:hover { color: var(--color-text-primary); border-color: var(--color-accent); }
.rc-backdrop.rc-docked {
  left: auto; width: min(760px, 55vw); background: none;
  border-left: 1px solid var(--color-border); box-shadow: -8px 0 24px rgba(0,0,0,0.35);
}
.rc-docked .rc-main { flex-direction: column; }
.rc-docked .rc-compare { flex: none; overflow: visible; }
.rc-docked .rc-list { width: auto; flex: 1; min-height: 220px; border-left: none; border-top: 1px solid var(--color-border); }
.rc-docked .rc-keys { display: none; }
.rc-docked .rc-pair { grid-template-columns: 1fr; }
.rc-docked .rc-dialog { overflow-y: auto; }
.rc-docked.rc-kbd-idle .rc-header { opacity: 0.85; }
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

// ─── Filters ────────────────────────────────────────────────────────
const TYPE_OPTS = [
  { v: '', t: 'All' }, { v: 'song', t: 'Song' }, { v: 'call', t: 'Call' },
  { v: 'alarm call', t: 'Alarm' }, { v: 'flight call', t: 'Flight' }, { v: 'drumming', t: 'Drum' },
];
const QUALITY_OPTS = [{ v: 'auto', t: 'Best' }, { v: 'A', t: 'A' }, { v: 'AB', t: 'A–B' }, { v: 'any', t: 'Any' }];
const LEN_OPTS = [{ v: '0-3', t: '<3 s' }, { v: '2-7', t: '2–7 s' }, { v: '5-20', t: '5–20 s' }, { v: '', t: 'Any' }];
const REGION_OPTS = [{ v: 'any', t: 'World' }, { v: 'near', t: 'Nearby' }];

// XC query tags. '>C' = better than C, i.e. A and B.
const QUALITY_TAG: Record<string, string> = { A: 'q:A', AB: `q:${encodeURIComponent('">C"')}`, any: '' };
// Quality ladder for 'auto': A only → A+B → any
const QUALITY_TIERS = [
  { label: 'Quality A',     q: 'A'   },
  { label: 'Quality A & B', q: 'AB'  },
  { label: 'Any quality',   q: 'any' },
];

function matchTypeOpt(type: string) {
  const t = (type || '').toLowerCase().trim();
  if (!t) return '';
  return TYPE_OPTS.find(o => o.v && t === o.v)?.v
      ?? TYPE_OPTS.find(o => o.v && t.includes(o.v))?.v
      ?? '';
}

// ─── Pinned references (per species, localStorage + Cache API audio) ──
const PINS_KEY = 'rc-pins';
const AUDIO_CACHE_NAME = 'rc-pinned-audio';
const audioCacheUrl = (xcId: string) => `https://rc-cache.local/xc/${encodeURIComponent(xcId)}`;

function readPins(): Record<string, any[]> {
  try { return JSON.parse(localStorage.getItem(PINS_KEY) || '{}') || {}; } catch { return {}; }
}
function writePins(pins: Record<string, any[]>) {
  try { localStorage.setItem(PINS_KEY, JSON.stringify(pins)); } catch {}
}
function trimRec(r: any) {
  return { id: r.id, type: r.type, q: r.q, len: r.len, cnt: r.cnt, rec: r.rec, lic: r.lic,
           sono: r.sono ? { small: r.sono.small, med: r.sono.med } : undefined };
}
async function cacheGet(xcId: string): Promise<ArrayBuffer | null> {
  try {
    if (typeof caches === 'undefined') return null;
    const res = await (await caches.open(AUDIO_CACHE_NAME)).match(audioCacheUrl(xcId));
    return res ? await res.arrayBuffer() : null;
  } catch { return null; }
}
async function cachePut(xcId: string, buf: ArrayBuffer) {
  try {
    if (typeof caches === 'undefined') return;
    await (await caches.open(AUDIO_CACHE_NAME)).put(audioCacheUrl(xcId), new Response(buf.slice(0)));
  } catch {}
}
async function cacheDelete(xcId: string) {
  try { if (typeof caches !== 'undefined') await (await caches.open(AUDIO_CACHE_NAME)).delete(audioCacheUrl(xcId)); } catch {}
}

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
 * @param {function} [opts.getCoords]    Recording location {lat, lon} for the 'Nearby' filter
 * @param {function} [opts.onUpdateLabel] (patch with id) → updated label, or null if not editable
 * @param {function} [opts.isLabelLocked] (id) → true when the label may not be edited
 * @param {function} [opts.getNextLabel]  (currentId) → next unconfirmed label or null
 * @param {function} [opts.getOwnReferences] (sciName, excludeId) → own confirmed labels:
 *        [{ id, start, end, freqMin?, freqMax?, recordingName, soundType?, getAudioUrl() }]
 */
export function createReferenceCallsModal({ xcPanel, getSuggestions, BirdNETPlayer, resolveSci = () => '', taxonomy, getLang, getMainPlayer, getCoords, onUpdateLabel, isLabelLocked, getNextLabel, getOwnReferences }: any) {
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
  const dockBtn = el('button', 'rc-dock') as HTMLButtonElement;
  dockBtn.type = 'button';
  // 'modal-close' + bound flag: ModalManager neither injects a second × nor binds it twice.
  const closeBtn = el('button', 'rc-close modal-close', '×') as HTMLButtonElement;
  closeBtn.title = 'Close (Esc)';
  closeBtn.dataset.modalHandlerBound = '1';
  header.append(speciesEl, searchWrap, keys, dockBtn, closeBtn);
  dialog.appendChild(header);

  const main = el('div', 'rc-main');
  dialog.appendChild(main);

  // Compare area: own recording and selected reference side by side, same time scale
  const compare = el('div', 'rc-compare');
  const ownSide = el('div', 'rc-side');
  const ownTitle = el('div', 'rc-side-title');
  const ownPlayerWrap = el('div', 'rc-player');
  ownSide.append(ownTitle, ownPlayerWrap);
  const refSide = el('div', 'rc-side');
  const refTitle = el('div', 'rc-side-title');
  const refPlayerWrap = el('div', 'rc-player');
  refSide.append(refTitle, refPlayerWrap);
  const decide = el('div', 'rc-decide');
  const decideStatus = el('span', 'rc-decide-status');
  const mkBtn = (text: string, key: string, cls = '') => {
    const b = el('button', `rc-btn ${cls}`) as HTMLButtonElement;
    b.type = 'button';
    b.innerHTML = `${esc(text)}<kbd>${key}</kbd>`;
    return b;
  };
  const confirmBtn = mkBtn('✓ Confirm', 'V', 'rc-primary');
  const speciesBtn = mkBtn('Use species', 'S');
  const typeBtn    = mkBtn('Use type', 'T');
  const nextBtnL   = mkBtn('Next label →', 'N');
  decide.append(decideStatus, confirmBtn, speciesBtn, typeBtn, nextBtnL);
  const viewbar = el('div', 'rc-viewbar');
  const viewInfo = el('span', 'rc-view-info');
  const zoomOutBtn = mkBtn('−', '-');
  const zoomInBtn  = mkBtn('+', '+');
  const fitBtn     = mkBtn('Fit', '0');
  viewbar.append(viewInfo, zoomOutBtn, zoomInBtn, fitBtn);
  const pair = el('div', 'rc-pair');
  pair.append(ownSide, refSide);
  compare.append(viewbar, pair, decide);
  main.appendChild(compare);

  // Candidate list
  const list = el('div', 'rc-list');
  const filtersEl = el('div', 'rc-filters');
  const listBody = el('div', 'rc-list-body');
  const pagination = el('div', 'rc-pagination');
  const prevBtn = el('button', '', '← Prev') as HTMLButtonElement;
  const pageInfo = el('div', 'rc-page-info');
  const nextBtn = el('button', '', 'Next →') as HTMLButtonElement;
  pagination.append(prevBtn, pageInfo, nextBtn);
  list.append(filtersEl, listBody, pagination);
  main.appendChild(list);

  const DOCK_KEY = 'rc-docked';
  let _docked = false;
  try { _docked = localStorage.getItem(DOCK_KEY) === '1'; } catch {}
  let _kbdInside = false;      // docked: keys only after clicking into the drawer

  const isOpen = () => !backdrop.hidden;
  const requestClose = () => {
    cleanup();
    if (_docked) backdrop.hidden = true; else manager.close();
  };
  const manager = new ModalManager({ backdrop: backdrop as any, dialog: dialog as any, onClose: requestClose } as any);
  closeBtn.addEventListener('click', requestClose);

  function show() {
    backdrop.classList.toggle('rc-docked', _docked);
    dockBtn.textContent = _docked ? '⤢ Full view' : '⇥ Dock';
    dockBtn.title = _docked ? 'Back to the full-screen view' : 'Dock to the side; follows the label selection';
    if (_docked) { backdrop.hidden = false; _kbdInside = true; }
    else manager.open();
    backdrop.classList.toggle('rc-kbd-idle', _docked && !_kbdInside);
  }
  dockBtn.addEventListener('click', () => {
    if (!_docked) manager.close();   // drop focus trap + backdrop handlers
    _docked = !_docked;
    try { localStorage.setItem(DOCK_KEY, _docked ? '1' : '0'); } catch {}
    show();
  });
  // Docked: clicking outside hands the keyboard back to the main app.
  document.addEventListener('pointerdown', (e) => {
    if (!_docked || backdrop.hidden) return;
    _kbdInside = dialog.contains(e.target as Node);
    backdrop.classList.toggle('rc-kbd-idle', !_kbdInside);
  }, true);

  // ── State ────────────────────────────────────────────────────────
  let _label: any = null;
  let _sciName = '';
  let _page = 1;
  let _totalPages = 1;
  let _preferredType = '';
  let _searchWidget: any = null;
  let _loadToken = 0;          // invalidates stale page loads
  let _activeTier = 0;         // index into QUALITY_TIERS ('auto' quality)
  const _filters = { type: '', quality: 'auto', len: '2-7', region: 'any' };
  let _source: 'xc' | 'pinned' | 'own' = 'xc';
  let _audioUrl: string | null = null;

  let _ownPlayer: any = null;
  let _refPlayer: any = null;
  let _refBlobUrl: string | null = null;
  let _refToken = 0;           // invalidates stale reference loads

  let _items: { el: HTMLElement, rec: any }[] = [];
  let _selected = -1;          // index into _items
  let _focus: 'own' | 'ref' = 'own';
  let _abPending = false;      // A/B: play reference once own segment ends
  let _ownClip = false;        // stop own playback at the label end
  let _refCall: { start: number, end: number } | null = null; // found call in the reference
  let _refClip = false;        // stop reference playback at the call end

  const _audioCache = new Map<string, ArrayBuffer>();
  const _queryCache = new Map<string, any>();

  // ── Playback coordination ─────────────────────────────────────────
  const players = () => [_ownPlayer, _refPlayer].filter(Boolean);
  function stopAll() { for (const p of players()) if (p.isPlaying) p.pause(); }

  /** Only one player may play: when one starts, pause the other. */
  function watchPlayer(p: any) {
    p.on?.('play', () => {
      for (const other of players()) if (other !== p && other.isPlaying) other.pause();
      try { const mp = getMainPlayer?.(); if (mp?.isPlaying) mp.pause(); } catch {}
    });
  }

  function seek(p: any, t: number) {
    try { p._state?._seekToTime?.(t, false); } catch {}
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
    const t = _refPlayer.currentTime || 0;
    if (_refCall && (t < _refCall.start || t >= _refCall.end - 0.02)) seek(_refPlayer, _refCall.start);
    else if (_refPlayer.duration && t >= _refPlayer.duration - 0.05) seek(_refPlayer, 0);
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
    seek(_refPlayer, _refCall?.start ?? 0);
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

  // ── Shared view: same seconds-per-pixel and frequency band in both ──
  let _winScale = 1;

  function baseDur() {
    const seg = segment();
    return seg ? seg.end - seg.start : (_refCall ? _refCall.end - _refCall.start : 2);
  }
  /** Visible window in seconds: the call plus generous context, times zoom. */
  function viewLen() {
    const d = baseDur();
    // At least ~1.5 s context on each side and never under 3 s at Fit.
    return Math.max(0.4, Math.max(3, d + 2 * Math.max(1.5, d)) * _winScale);
  }
  function band(st: any) {
    const max = st?.coords?.boundedMaxFreq || 0;
    const lo0 = Number(_label?.freqMin), hi0 = Number(_label?.freqMax);
    if (!max || !Number.isFinite(lo0) || !Number.isFinite(hi0) || hi0 <= lo0) return null;
    const span = Math.max(4000, (hi0 - lo0) * 2.5);
    const mid = (lo0 + hi0) / 2;
    const lo = Math.max(0, mid - span / 2);
    return { lo, hi: Math.min(max, lo + span) };
  }
  function sharedPps() {
    const widths = players().map(p => p._state?._getViewportWidth?.() || 0).filter(w => w > 0);
    return widths.length ? Math.min(...widths) / viewLen() : 0;
  }
  function applyView(p: any, anchor: number, dur: number, pps: number) {
    const st = p?._state;
    if (!st?.audioBuffer || !pps) return;
    const total = st.audioBuffer.duration;
    const W = viewLen();
    // Centre the call; the onset sits at the same x in both players.
    const start = Math.max(0, Math.min(anchor - (W - dur) / 2, Math.max(0, total - W)));
    const b = band(st);
    try {
      if (b) st._freqZoom.set(b.lo, b.hi); else st._freqZoom.reset();
      st._setPixelsPerSecond(pps, true, start, 0);
    } catch {}
  }
  function syncView() {
    const pps = sharedPps();
    const seg = segment();
    if (_ownPlayer && seg) applyView(_ownPlayer, seg.start, seg.end - seg.start, pps);
    if (_refPlayer && _refCall) applyView(_refPlayer, _refCall.start, _refCall.end - _refCall.start, pps);
    const b = band(_ownPlayer?._state || _refPlayer?._state);
    viewInfo.textContent = `Window ${viewLen().toFixed(1)} s`
      + (b ? ` · ${(b.lo / 1000).toFixed(1)}–${(b.hi / 1000).toFixed(1)} kHz` : '')
      + ' · same scale in both views';
  }
  // Players finish their own initial layout asynchronously; apply again shortly after.
  let _viewTimer = 0;
  function scheduleView() {
    syncView();
    clearTimeout(_viewTimer);
    _viewTimer = window.setTimeout(syncView, 250);
  }
  const zoom = (f: number) => { _winScale = Math.max(0.15, Math.min(8, _winScale * f)); syncView(); };
  zoomOutBtn.addEventListener('click', () => zoom(1.5));
  zoomInBtn.addEventListener('click', () => zoom(1 / 1.5));
  fitBtn.addEventListener('click', () => { _winScale = 1; syncView(); });
  let _resizeRaf = 0;
  new ResizeObserver(() => {
    if (backdrop.hidden) return;
    cancelAnimationFrame(_resizeRaf);
    _resizeRaf = requestAnimationFrame(() => scheduleView());
  }).observe(pair);

  // ── Keyboard (window capture: runs before every document listener) ─
  function onKeyDown(e: KeyboardEvent) {
    if (backdrop.hidden || e.key === 'Tab') return;
    if (_docked && !_kbdInside) return;
    if (e.key === 'Escape') { if (_docked) { e.preventDefault(); requestClose(); } return; }
    if (isTyping(e.target)) return;
    let handled = true;
    switch (e.code) {
      case 'Space': toggle(_focus); break;
      case 'ArrowDown': case 'KeyJ': selectItem(_selected + 1); break;
      case 'ArrowUp':   case 'KeyK': selectItem(_selected - 1); break;
      case 'KeyR': setFocus('own'); break;
      case 'KeyF': setFocus('ref'); break;
      case 'KeyA': playAB(); break;
      case 'KeyV': if (!confirmBtn.disabled) confirmBtn.click(); break;
      case 'KeyS': if (!speciesBtn.disabled) speciesBtn.click(); break;
      case 'KeyT': if (!typeBtn.disabled) typeBtn.click(); break;
      case 'KeyN': if (!nextBtnL.disabled) nextBtnL.click(); break;
      case 'Minus': case 'NumpadSubtract': zoom(1.5); break;
      case 'Equal': case 'NumpadAdd': zoom(1 / 1.5); break;
      case 'Digit0': case 'Numpad0': _winScale = 1; syncView(); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
    // Full view: swallow everything so the main player underneath stays quiet.
    if (handled || !_docked) e.stopImmediatePropagation();
  }
  window.addEventListener('keydown', onKeyDown, true);
  ownSide.addEventListener('pointerdown', () => setFocus('own'));
  refSide.addEventListener('pointerdown', () => setFocus('ref'));

  // ── Decisions on the label ────────────────────────────────────────
  const tagsOf = (l: any) => (l?.tags && typeof l.tags === 'object' ? l.tags : {}) as Record<string, string>;
  const labelType = () => String(tagsOf(_label).soundType || _label?.type || _label?.callType || '');
  const selectedRec = () => _items[_selected]?.rec ?? null;
  const editable = () => !!_label?.id && !!onUpdateLabel && !isLabelLocked?.(_label.id);

  function speciesName(sci: string) {
    const record = sci ? taxonomy?.resolve(sci) : null;
    return (record && taxonomy.resolveCommonName(record, getLang?.() || 'en')) || sci;
  }

  function renderDecision() {
    const tags = tagsOf(_label);
    const verified = tags.verified === 'yes';
    const rec = selectedRec();
    const canEdit = editable();
    decide.hidden = !_label?.id;

    decideStatus.className = `rc-decide-status${verified ? ' rc-ok' : ''}`;
    decideStatus.textContent = !canEdit
      ? 'Read-only label'
      : verified ? `✓ Confirmed${tags.referenceXc ? ` with ${tags.referenceXc}` : ''}` : 'Not confirmed yet';

    confirmBtn.disabled = !canEdit;
    confirmBtn.innerHTML = `${verified ? 'Undo confirm' : '✓ Confirm'}<kbd>V</kbd>`;
    confirmBtn.classList.toggle('rc-primary', !verified);

    const otherSpecies = !!_sciName && _sciName !== (_label?.scientificName || '');
    speciesBtn.hidden = !otherSpecies;
    speciesBtn.disabled = !canEdit;
    speciesBtn.innerHTML = `Use ${esc(speciesName(_sciName))}<kbd>S</kbd>`;

    const recType = String((rec?.kind === 'own' ? rec.soundType : rec?.type) || '').split(',')[0].trim().toLowerCase();
    typeBtn.hidden = !recType || recType === labelType().toLowerCase();
    typeBtn.disabled = !canEdit;
    typeBtn.innerHTML = `Type “${esc(recType)}”<kbd>T</kbd>`;
    typeBtn.dataset.type = recType;

    nextBtnL.disabled = !getNextLabel;
  }

  function patchLabel(patch: Record<string, any>) {
    if (!editable()) return;
    const updated = onUpdateLabel({ id: _label.id, ...patch });
    if (!updated) return;
    _label = { ..._label, ...updated };
    renderDecision();
  }

  confirmBtn.addEventListener('click', () => {
    const tags = { ...tagsOf(_label) };
    if (tags.verified === 'yes') {
      delete tags.verified;
      delete tags.referenceXc;
    } else {
      tags.verified = 'yes';
      const rec = selectedRec();
      if (rec?.id && rec.kind !== 'own') tags.referenceXc = `XC${rec.id}`; else delete tags.referenceXc;
    }
    patchLabel({ tags });
  });

  speciesBtn.addEventListener('click', () => {
    if (!_sciName) return;
    const common = speciesName(_sciName);
    patchLabel({ scientificName: _sciName, commonName: common, label: common });
    renderSpecies(_sciName);
  });

  typeBtn.addEventListener('click', () => {
    const t = typeBtn.dataset.type;
    if (t) patchLabel({ tags: { ...tagsOf(_label), soundType: t } });
  });

  nextBtnL.addEventListener('click', () => {
    const next = getNextLabel?.(_label?.id);
    if (next) open(next, _audioUrl);
    else { decideStatus.className = 'rc-decide-status rc-ok'; decideStatus.textContent = 'All labels confirmed 🎉'; }
  });

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
        renderDecision();
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
      const p = new BirdNETPlayer(inner, { ...PLAYER_OPTS });
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
      scheduleView();
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
    if (rec.kind === 'own') {
      const meta = [rec.recordingName, `${Number(rec.start).toFixed(2)}–${Number(rec.end).toFixed(2)} s`, rec.soundType].filter(Boolean).map(esc).join(' · ');
      refTitle.innerHTML = `<span>Own reference</span><span class="rc-side-meta">${meta}</span>`;
      return;
    }
    const lic = formatLicense(rec.lic);
    const meta = [rec.type, rec.q && `Q ${rec.q}`, fmtLen(rec.len), rec.cnt, rec.rec, lic].filter(Boolean).map(esc).join(' · ');
    refTitle.innerHTML = `<span>Reference — XC${esc(rec.id)}</span><span class="rc-side-meta">${meta}</span>`
      + `<a href="https://xeno-canto.org/${esc(rec.id)}" target="_blank" rel="noopener noreferrer" title="Open on xeno-canto">↗</a>`;
  }

  async function getAudio(xcId: string): Promise<ArrayBuffer> {
    const hit = _audioCache.get(xcId);
    if (hit) return hit;
    const buf: ArrayBuffer = (await cacheGet(xcId)) ?? (await xcPanel.fetchAudio(xcId)).buffer;
    _audioCache.set(xcId, buf);
    while (_audioCache.size > AUDIO_CACHE_MAX) _audioCache.delete(_audioCache.keys().next().value!);
    return buf;
  }

  async function showReference(rec: any) {
    const token = ++_refToken;
    _abPending = false;
    _refCall = null;
    destroyRefPlayer();
    renderRefTitle(rec);
    refPlayerWrap.innerHTML = rec ? '<div class="rc-status">Loading…</div>' : '<div class="rc-status">Select a candidate on the right.</div>';
    if (!rec || !BirdNETPlayer) return;
    try {
      const own = rec.kind === 'own';
      let blobUrl: string;
      if (own) {
        blobUrl = await rec.getAudioUrl();
        if (!blobUrl) throw new Error('Audio of this recording is not available');
      } else {
        const buf = await getAudio(String(rec.id));
        if (token !== _refToken) return;
        blobUrl = URL.createObjectURL(new Blob([buf.slice(0)], { type: 'audio/mpeg' }));
      }
      if (token !== _refToken) { if (!own) URL.revokeObjectURL(blobUrl); return; }
      refPlayerWrap.innerHTML = '';
      const inner = el('div');
      inner.style.height = '100%';
      refPlayerWrap.appendChild(inner);
      const p = new BirdNETPlayer(inner, { ...PLAYER_OPTS });
      await p.ready;
      await p.loadUrl(blobUrl);
      if (token !== _refToken) { try { p.destroy?.(); } catch {} if (!own) URL.revokeObjectURL(blobUrl); return; }
      _refPlayer = p;
      _refBlobUrl = own ? null : blobUrl;   // own URLs belong to the app
      watchPlayer(p);
      disableLabeling(p);
      p.on('play', () => {
        const t = p.currentTime || 0;
        _refClip = !!_refCall && t >= _refCall.start - 0.05 && t < _refCall.end;
      });
      p.on('timeupdate', (e: any) => {
        if (!_refClip || !_refCall || !p.isPlaying) return;
        if ((e.detail?.currentTime ?? p.currentTime) >= _refCall.end) { p.pause(); seek(p, _refCall.start); }
      });
      if (own) {
        // Own labels already know where the call is.
        _refCall = { start: Number(rec.start), end: Number(rec.end) };
        p.setSpectrogramLabels([{
          start: _refCall.start, end: _refCall.end, freqMin: rec.freqMin, freqMax: rec.freqMax,
          label: rec.label || 'reference', color: 'rgba(34,197,94,0.22)', readonly: true,
        }]);
        seek(p, _refCall.start);
        scheduleView();
      } else {
        prefetchNext();
        locateCall(p, token);
      }
    } catch (err) {
      if (token === _refToken) {
        refPlayerWrap.innerHTML = `<div class="rc-status rc-status-error">${esc((err as any)?.message || 'Load failed')}</div>`;
      }
    }
  }

  /** Jump to the loudest section in the label's band and mark it. */
  async function locateCall(p: any, token: number) {
    const buffer: AudioBuffer | undefined = p._state?.audioBuffer;
    if (!buffer) return;
    const seg = segment();
    const dur = seg ? seg.end - seg.start : 2;
    try {
      const call = await findCall(buffer, Number(_label?.freqMin), Number(_label?.freqMax), dur);
      if (token !== _refToken || p !== _refPlayer) return;
      _refCall = call;
      p.setSpectrogramLabels([{
        start: call.start, end: call.end,
        freqMin: _label?.freqMin, freqMax: _label?.freqMax,
        label: 'call', color: 'rgba(234,179,8,0.22)', readonly: true,
      }]);
      if (!p.isPlaying) seek(p, call.start);
      scheduleView();
    } catch { /* keep the reference usable without a marked call */ }
  }

  /** Warm the cache for the next candidate so ↓ feels instant. */
  function prefetchNext() {
    const next = _items[_selected + 1]?.rec;
    if (next && next.kind !== 'own' && !_audioCache.has(String(next.id))) getAudio(String(next.id)).catch(() => {});
  }

  function selectItem(idx: number) {
    if (!_items.length) return;
    const i = Math.max(0, Math.min(idx, _items.length - 1));
    if (i === _selected && _refPlayer) { setFocus('ref'); return; }
    _selected = i;
    _items.forEach((it, j) => it.el.classList.toggle('rc-selected', j === i));
    _items[i].el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    setFocus('ref');
    renderDecision();
    showReference(_items[i].rec);
  }

  // ── Pins ──────────────────────────────────────────────────────────
  const pinsFor = (sci: string) => readPins()[sci] || [];
  const isPinned = (id: any) => pinsFor(_sciName).some(r => String(r.id) === String(id));

  async function togglePin(rec: any) {
    const pins = readPins();
    const list = pins[_sciName] || [];
    const id = String(rec.id);
    if (list.some(r => String(r.id) === id)) {
      pins[_sciName] = list.filter(r => String(r.id) !== id);
      if (!pins[_sciName].length) delete pins[_sciName];
      writePins(pins);
      cacheDelete(id);
    } else {
      pins[_sciName] = [...list, trimRec(rec)];
      writePins(pins);
      getAudio(id).then(buf => cachePut(id, buf)).catch(() => {});
    }
    renderFilters();
  }

  // ── XC API search ────────────────────────────────────────────────
  function filterTags(quality: string) {
    const tags: string[] = [];
    if (_filters.type) tags.push(`type:${encodeURIComponent(`"${_filters.type}"`)}`);
    if (QUALITY_TAG[quality]) tags.push(QUALITY_TAG[quality]);
    if (_filters.len) tags.push(`len:${_filters.len}`);
    const c = _filters.region === 'near' ? coords() : null;
    if (c) {
      // ~300 km box around the recording location
      const f = (v: number) => v.toFixed(2);
      tags.push(`box:${f(c.lat - 3)},${f(c.lon - 4.5)},${f(c.lat + 3)},${f(c.lon + 4.5)}`);
    }
    return tags;
  }

  async function _fetchPage(baseQuery: string, quality: string, page: number, apiKey: string) {
    const q = [baseQuery, ...filterTags(quality)].join('+');
    const cacheKey = `${q}&page=${page}`;
    let data = _queryCache.get(cacheKey);
    if (!data) {
      const url = `${XC_API}?query=${q}&page=${page}&key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`XC API error: HTTP ${res.status}`);
      data = await res.json();
      _queryCache.set(cacheKey, data);
      while (_queryCache.size > 60) _queryCache.delete(_queryCache.keys().next().value!);
    }
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

    if (_filters.quality !== 'auto') {
      const label = QUALITY_OPTS.find(o => o.v === _filters.quality)?.t || '';
      return { ...(await _fetchPage(baseQuery, _filters.quality, page, apiKey)), qualityLabel: `Quality ${label}`, fallback: false };
    }
    // 'auto': page 1 decides the tier; later pages reuse it.
    if (page > 1) {
      const tier = QUALITY_TIERS[_activeTier];
      return { ...(await _fetchPage(baseQuery, tier.q, page, apiKey)), qualityLabel: tier.label, fallback: _activeTier > 0 };
    }
    for (let i = 0; i < QUALITY_TIERS.length; i++) {
      const tier = QUALITY_TIERS[i];
      const result = await _fetchPage(baseQuery, tier.q, 1, apiKey);
      if (result.recordings.length > 0 || i === QUALITY_TIERS.length - 1) {
        _activeTier = i;
        return { ...result, qualityLabel: tier.label, fallback: i > 0 };
      }
    }
    return { recordings: [], numPages: 1, numRecordings: 0, qualityLabel: 'Any quality', fallback: true };
  }

  function coords(): { lat: number, lon: number } | null {
    try {
      const c = getCoords?.();
      return c && Number.isFinite(c.lat) && Number.isFinite(c.lon) ? c : null;
    } catch { return null; }
  }

  function ownRefs(): any[] {
    try { return (getOwnReferences?.(_sciName, _label?.id) || []).map((r: any) => ({ ...r, kind: 'own' })); }
    catch { return []; }
  }

  // ── Filter chips ──────────────────────────────────────────────────
  function renderFilters() {
    filtersEl.innerHTML = '';
    const row = (name: string, key: keyof typeof _filters, opts: { v: string, t: string }[], disabled?: (v: string) => boolean) => {
      const r = el('div', 'rc-filter-row');
      r.appendChild(el('span', 'rc-filter-name', name));
      const seg = el('div', 'rc-seg');
      r.appendChild(seg);
      for (const o of opts) {
        const b = el('button', 'rc-chip', o.t) as HTMLButtonElement;
        b.type = 'button';
        b.classList.toggle('rc-on', _filters[key] === o.v);
        if (disabled?.(o.v)) { b.disabled = true; b.title = 'No recording location set'; }
        b.addEventListener('click', () => {
          if (_filters[key] === o.v) return;
          _filters[key] = o.v;
          renderFilters();
          if (_sciName) loadPage(1);
        });
        seg.appendChild(b);
      }
      filtersEl.appendChild(r);
    };
    // Source row
    const src = el('div', 'rc-filter-row');
    src.appendChild(el('span', 'rc-filter-name', 'Source'));
    const srcSeg = el('div', 'rc-seg');
    src.appendChild(srcSeg);
    const ownCount = _sciName ? (ownRefs().length) : 0;
    for (const o of [
      { v: 'xc', t: 'Xeno-Canto' },
      { v: 'pinned', t: `★ Pinned (${_sciName ? pinsFor(_sciName).length : 0})` },
      { v: 'own', t: `Own (${ownCount})` },
    ] as const) {
      const b = el('button', 'rc-chip', o.t) as HTMLButtonElement;
      b.type = 'button';
      b.classList.toggle('rc-on', _source === o.v);
      if (o.v === 'own' && !getOwnReferences) b.disabled = true;
      b.addEventListener('click', () => {
        if (_source === o.v) return;
        _source = o.v;
        renderFilters();
        if (_sciName) loadPage(1);
      });
      srcSeg.appendChild(b);
    }
    filtersEl.appendChild(src);
    if (_source !== 'xc') return;
    row('Type', 'type', TYPE_OPTS);
    row('Quality', 'quality', QUALITY_OPTS);
    row('Length', 'len', LEN_OPTS);
    row('Region', 'region', REGION_OPTS, v => v === 'near' && !coords());
  }

  // ── Candidate list ────────────────────────────────────────────────
  function renderItem(rec: any) {
    if (rec.kind === 'own') return renderOwnItem(rec);
    const item = el('div', 'rc-item');
    const sono = absUrl(rec.sono?.med || rec.sono?.small);
    const meta = [rec.type, rec.cnt, rec.rec].filter(Boolean).map(esc).join(' · ');
    item.innerHTML = `
      <div class="rc-item-sono">${sono ? `<img src="${esc(sono)}" alt="" loading="lazy" />` : ''}</div>
      <div class="rc-item-head">
        <span>XC${esc(rec.id)}</span>
        ${rec.q ? `<span class="rc-badge">${esc(rec.q)}</span>` : ''}
        <span class="rc-len">${esc(fmtLen(rec.len))}</span>
        <button class="rc-pin" type="button"></button>
      </div>
      <div class="rc-item-meta" title="${meta}">${meta}</div>`;
    const pin = item.querySelector('.rc-pin') as HTMLButtonElement;
    const paintPin = () => {
      const on = isPinned(rec.id);
      pin.textContent = on ? '★' : '☆';
      pin.classList.toggle('rc-on', on);
      pin.title = on ? 'Unpin' : 'Pin as reference for this species (kept offline)';
    };
    paintPin();
    pin.addEventListener('click', async (e) => {
      e.stopPropagation();
      await togglePin(rec);
      paintPin();
      if (_source === 'pinned' && !isPinned(rec.id)) loadPage(1);
    });
    const idx = _items.push({ el: item, rec }) - 1;
    item.addEventListener('click', () => selectItem(idx));
    return item;
  }

  function renderOwnItem(rec: any) {
    const item = el('div', 'rc-item');
    const meta = [rec.recordingName, rec.soundType].filter(Boolean).map(esc).join(' · ');
    item.innerHTML = `
      <div class="rc-item-own">${esc(rec.label || '')} · ${Number(rec.start).toFixed(2)}–${Number(rec.end).toFixed(2)} s</div>
      <div class="rc-item-head"><span>Own label</span><span class="rc-badge">✓</span>
        <span class="rc-len">${(Number(rec.end) - Number(rec.start)).toFixed(1)} s</span></div>
      <div class="rc-item-meta" title="${meta}">${meta}</div>`;
    const idx = _items.push({ el: item, rec }) - 1;
    item.addEventListener('click', () => selectItem(idx));
    return item;
  }

  function renderLocalList(recs: any[], emptyText: string) {
    listBody.innerHTML = '';
    pagination.hidden = true;
    if (!recs.length) { listBody.innerHTML = `<div class="rc-status">${emptyText}</div>`; return; }
    for (const rec of recs) listBody.appendChild(renderItem(rec));
    selectItem(0);
    setFocus('own');
  }

  async function loadPage(page: number) {
    const token = ++_loadToken;
    _page = page;
    _items = [];
    _selected = -1;
    showReference(null);
    if (_source === 'pinned') {
      renderLocalList(pinsFor(_sciName), 'No pinned references for this species yet — pin XC recordings with ☆.');
      return;
    }
    if (_source === 'own') {
      renderLocalList(ownRefs(), 'No other confirmed labels of this species yet.');
      return;
    }
    pagination.hidden = false;
    listBody.innerHTML = '<div class="rc-status">Loading XC recordings…</div>';
    prevBtn.disabled = nextBtn.disabled = true;
    pageInfo.textContent = '';

    try {
      const { recordings, numPages, numRecordings, qualityLabel, fallback } = await fetchXcRecordings(_sciName, page);
      if (token !== _loadToken) return;
      _totalPages = numPages;
      listBody.innerHTML = '';

      if (recordings.length === 0) {
        listBody.innerHTML = `<div class="rc-status">No recordings found for <em>${esc(_sciName)}</em> with these filters.</div>`;
      } else {
        const info = el('div', 'rc-info');
        info.innerHTML = `<span class="rc-badge ${fallback ? 'rc-warn' : ''}">${esc(qualityLabel)}</span>`
          + `<span>${numRecordings} recordings</span>`
          + (fallback ? '<span>· no quality-A recordings found</span>' : '');
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
    _audioUrl = audioUrl;
    _winScale = 1;
    _preferredType = labelType();
    const sci = label?.scientificName || '';
    const displayName = label?.label || label?.commonName || sci;
    _sciName = sci;
    _filters.type = matchTypeOpt(_preferredType);
    if (_filters.region === 'near' && !coords()) _filters.region = 'any';
    renderFilters();
    renderDecision();

    if (!_docked) { try { const mp = getMainPlayer?.(); if (mp?.isPlaying) mp.pause(); } catch {} }
    renderSpecies(sci, displayName);
    mountSearchWidget(sci, displayName);
    if (backdrop.hidden) show();
    else { stopAll(); _abPending = false; }
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
    _refCall = null;
    destroyRefPlayer();
    try { _ownPlayer?.destroy?.(); } catch {}
    _ownPlayer = null;
    _items = [];
    if (_searchWidget) { try { _searchWidget.destroy?.(); } catch {} _searchWidget = null; }
  }

  /** Docked view: show another label when the selection in the app changes. */
  function follow(label: any, audioUrl: any) {
    if (!_docked || !isOpen() || !label?.id || label.id === _label?.id) return;
    open(label, audioUrl);
  }

  return {
    open, follow, close: requestClose, isOpen,
    isDocked: () => _docked,
    pauseAll: () => stopAll(),
  };
}
