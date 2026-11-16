/**
 * SignaVis mobile — its own UI for phones (plans/mobile-ui-plan.md, design: plans/mobile-design/mockup.html).
 *
 * On phones (PHONE_QUERY) the desktop shell is hidden and this app is shown instead.
 * It reuses the app's data and the one BirdNETPlayer instance: the player root is moved
 * into the review screen while the phone UI is active and moved back afterwards; CSS
 * (`html.is-mobile`) hides the player's desktop chrome (toolbar, waveform, zoom strip).
 *
 * Screens (bottom nav): Aufnahmen · Prüfen · Live · Arten.
 * „Prüfen“ is a queue of open detections over all recordings; a tap opens the recording (review screen)
 * where ✓ copies a detection into „Meine Labels“ and ✕ removes it (both with undo).
 * New files and Live recordings are analysed right away with the current analysis settings.
 */
import { speciesImageBase } from '../../infrastructure/tauri/runtime.ts';
import { LiveRecorder } from '../../infrastructure/audio/LiveRecorder.ts';
import { LiveSpectrogramView } from '../components/live-view/live-spectrogram-view.ts';

export const PHONE_QUERY = '(max-width: 600px), (pointer: coarse) and (max-height: 500px)';

export interface MobileRecording {
  id: string;
  title: string;
  /** Short line under the title, e.g. "Xeno-canto" or "48 kHz". */
  meta: string;
  labels: any[];
  active: boolean;
}

export interface MobileAppHost {
  /** The player instance (BirdNETPlayer). */
  player: any;
  /** Element the player renders into (moved between desktop and phone layout). */
  playerRoot: HTMLElement;
  getRecordings(): MobileRecording[];
  openRecording(id: string): Promise<void> | void;
  /** Labels of the active recording. */
  getLabels(): any[];
  resolveName(lbl: any): { display: string; scientific?: string };
  /** True for labels in "My labels" (confirmed by the user). */
  isOwn?(lbl: any): boolean;
  /** Open the file picker to add audio. */
  addFile(): void;
  /** ✓: copy a detection of the active recording into "My labels" (desktop: spectrogramlabeladopt). */
  acceptLabel?(id: string): void;
  /** ✕: remove a label of the active recording; returns the removed label (for undo). */
  discardLabel?(id: string): any;
  /** Undo for ✕: put a removed label back into the active recording. */
  restoreLabel?(lbl: any): void;
  /** Called when phone mode is entered (true) or left (false). */
  onModeChange?(phone: boolean): void;
  /**
   * The app's analysis controls (desktop Analyse panel). The phone screen drives these
   * elements, so BirdNET / BirdBox keep one implementation.
   */
  analysis?: AnalysisControls;
  /** Live screen: microphone + BirdNET every 3 s; the recording is added to the project. */
  live?: LiveHost;
}

export interface LivePrediction { scientific: string; common: string; confidence: number }

export interface LiveHost {
  /** Load BirdNET (and the location filter); returns a classifier for one chunk of audio. */
  prepare(onStatus: (msg: string) => void): Promise<{
    analyze(pcm: Float32Array, sampleRate: number): Promise<LivePrediction[]>;
  }>;
  /** Add the finished recording to the project and open it. */
  save(file: File): Promise<void>;
  /** Short line about the filter, e.g. "Geofilter: Leipzig" (optional). */
  describe?(): string;
}

export interface AnalysisControls {
  confInput: HTMLInputElement;
  overlapSelect?: HTMLSelectElement | null;
  mergeCheckbox?: HTMLInputElement | null;
  geoCheckbox?: HTMLInputElement | null;
  locationLine?: HTMLElement | null;
  analyzeBtn: HTMLButtonElement;
  status?: HTMLElement | null;
  progressBar?: HTMLElement | null;
  birdboxBtn?: HTMLButtonElement | null;
  birdboxStatus?: HTMLElement | null;
  birdboxProgressWrap?: HTMLElement | null;
  birdboxProgressBar?: HTMLElement | null;
}

type Screen = 'recordings' | 'queue' | 'review' | 'analyse' | 'live' | 'species';

const FALLBACK_IMG = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Crect width='40' height='40' fill='%23252525'/%3E%3Cpath d='M20 9c-4 0-7 3-8 6l-4-2c-1-1-2 0-1 1l3 5c-1 1-2 3-2 5 0 6 5 10 12 10s12-4 12-10c0-2-1-3-1-4l3-5c1-1-1-2-2-1l-4 3c-1-4-4-8-8-8z' fill='%23444'/%3E%3C/svg%3E`;

const I = {
  lib: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5"/></svg>',
  bird: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M16 7h.01"/><path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20"/><path d="m20 7 2 .5-2 .5"/><path d="M10 18v3M14 17.75V21M7 18a6 6 0 0 0 3.84-10.61"/></svg>',
  analyse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h3l3-8 4 16 3-8h5"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l12-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  rw: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  fw: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
};

const SKIP_SEC = 5;
/** Seconds visible in the spectrogram on phones (the desktop default is far too zoomed in there). */
const VIEW_SEC = 10;
const RATES = [1, 0.5, 0.25];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function button(cls: string, html: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', cls);
  b.type = 'button';
  b.innerHTML = html;
  b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}

export function fmtClock(sec: number, tenths = true) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${String(m).padStart(2, '0')}:${tenths ? r.toFixed(1).padStart(4, '0') : String(Math.floor(r)).padStart(2, '0')}`;
}

function sourceName(lbl: any) {
  const o = String(lbl.origin || '');
  if (o === 'BirdNET') return 'BirdNET';
  if (o === 'BirdBox') return 'BirdBox';
  if (o === 'xeno-canto') return 'Xeno-canto';
  return o && o !== 'manual' ? o : 'Eigenes Label';
}

/** Review state of one recording's labels: detections, which are confirmed (copied into own labels), which are open. */
export function reviewState(labels: any[], isOwn: (l: any) => boolean) {
  const adopted = new Set(labels.filter((l) => isOwn(l) && l.adoptedFrom?.id != null).map((l) => String(l.adoptedFrom.id)));
  const detections = labels.filter((l) => !isOwn(l) && l.origin && l.origin !== 'manual');
  const open = detections.filter((l) => !adopted.has(String(l.id)));
  return { adopted, detections, open };
}

export class MobileApp {
  private h: MobileAppHost;
  private mql: MediaQueryList;
  private active = false;
  private screen: Screen = 'recordings';

  private root: HTMLElement;
  private screens = new Map<Screen, HTMLElement>();
  private navBtns = new Map<Screen, HTMLButtonElement>();
  private navBadge: HTMLElement;

  // Recordings
  private recList!: HTMLElement;
  // Review
  private rvTitle!: HTMLElement;
  private rvSub!: HTMLElement;
  private playerSlot!: HTMLElement;
  private timeCur!: HTMLElement;
  private timeDur!: HTMLElement;
  private playBtn!: HTMLButtonElement;
  private rateBtn!: HTMLButtonElement;
  private loopBtn!: HTMLButtonElement;
  private detHead!: HTMLElement;
  private detList!: HTMLElement;
  private currentDetId: string | null = null;
  private rvFilter: 'open' | 'all' = 'open';
  private rvChips = new Map<'open' | 'all', HTMLButtonElement>();
  /** Where the review screen was opened from (back button + highlighted nav tab). */
  private rvFrom: Screen = 'queue';
  private qList!: HTMLElement;
  private qHead!: HTMLElement;
  private snack!: HTMLElement;
  private snackTimer = 0;
  private rvProgress!: HTMLElement;
  /** Analyse the next recording that gets loaded (after „Neu“ or Live). */
  private autoAnalyse = false;
  private loopSeg: { start: number; end: number } | null = null;

  // Species
  private spList!: HTMLElement;
  private spSearch!: HTMLInputElement;
  private spChips = new Map<string, HTMLButtonElement>();
  private spSortBtn!: HTMLButtonElement;
  private spMeta!: HTMLElement;
  private spFilter: 'all' | 'confirmed' | 'detected' = 'all';
  private spSort: 'count' | 'name' | 'conf' = 'count';
  private spOpen = new Set<string>();

  // Analyse
  private anSub!: HTMLElement;
  private anProgress!: HTMLElement;
  private anProgressText!: HTMLElement;
  private anProgressBar!: HTMLElement;
  private anBirdnet!: HTMLInputElement;
  private anBirdbox!: HTMLInputElement;
  private anGeo!: HTMLInputElement;
  private anGeoRow!: HTMLElement;
  private anLocation!: HTMLElement;
  private anConf!: HTMLInputElement;
  private anConfVal!: HTMLElement;
  private anRun!: HTMLButtonElement;
  private anExpert!: HTMLElement;
  private anBackTo: Screen = 'review';
  private anJob: 'idle' | 'birdnet' | 'birdbox' = 'idle';
  private anJobStarted = false;
  private anJobAt = 0;

  // Live
  private lvSpec!: HTMLElement;
  private lvMeter!: HTMLElement;
  private lvInfo!: HTMLElement;
  private lvList!: HTMLElement;
  private lvTime!: HTMLElement;
  private lvBtn!: HTMLButtonElement;
  private lvDiscard!: HTMLButtonElement;
  private lvRec: LiveRecorder | null = null;
  private lvView: LiveSpectrogramView | null = null;
  private lvSpecies = new Map<string, { sci: string; common: string; count: number; max: number; last: number }>();
  private lvBusy = false;
  private lvRaf = 0;
  private lvTick = 0;

  // Where the player root lives on the desktop
  private playerHome: { parent: Node; next: Node | null } | null = null;
  private raf = 0;
  /** A recording was loaded while the player was hidden: fit the time span once it shows. */
  private needsFit = true;

  constructor(host: MobileAppHost) {
    this.h = host;
    this.root = el('div', 'm-app');
    this.root.setAttribute('aria-label', 'SignaVis');
    const body = el('div', 'm-screens');
    body.append(this.buildRecordings(), this.buildQueue(), this.buildReview(), this.buildAnalyse(), this.buildLive(), this.buildSpecies());
    const nav = el('nav', 'm-nav');
    nav.setAttribute('aria-label', 'Navigation');
    for (const [id, icon, label] of [['recordings', I.lib, 'Aufnahmen'], ['queue', I.check, 'Prüfen'],
      ['live', I.mic, 'Live'], ['species', I.bird, 'Arten']] as [Screen, string, string][]) {
      const b = el('button', 'm-nav-btn');
      b.type = 'button';
      b.innerHTML = `<span class="m-nav-pill">${icon}</span><span>${label}</span>`;
      b.addEventListener('click', () => this.show(id));
      this.navBtns.set(id, b);
      nav.appendChild(b);
    }
    this.navBadge = el('span', 'm-nav-badge');
    this.navBtns.get('queue')!.appendChild(this.navBadge);
    this.snack = el('div', 'm-snack');
    this.snack.hidden = true;
    this.root.append(body, this.snack, nav);
    document.body.appendChild(this.root);

    // A newly loaded recording starts with the phone time span.
    host.player?.on?.('ready', () => {
      this.needsFit = true;
      if (!this.active) return;
      setTimeout(() => this.fitTime(), 250);
      if (this.autoAnalyse) { this.autoAnalyse = false; setTimeout(() => this.analyseNow(), 300); }
    });

    this.mql = window.matchMedia(PHONE_QUERY);
    this.mql.addEventListener('change', () => this.applyMode());
    this.applyMode();
  }

  get isActive() { return this.active; }

  /** Re-render lists after labels or recordings changed. */
  refresh() {
    if (!this.active) return;
    this.renderRecordings();
    this.renderReview();
    this.renderQueue();
    if (this.screen === 'species') this.renderSpecies();
  }

  // ── Mode ────────────────────────────────────────────────────────────

  private applyMode() {
    const phone = this.mql.matches;
    if (phone === this.active) return;
    this.active = phone;
    document.documentElement.classList.toggle('is-mobile', phone);
    if (phone) {
      this.mountPlayer();
      this.startTicker();
      this.show(this.openTotal() ? 'queue' : 'recordings');
    } else {
      this.stopTicker();
      this.unmountPlayer();
    }
    this.h.onModeChange?.(phone);
    this.resizePlayer();
    if (phone) { this.needsFit = true; setTimeout(() => this.fitTime(), 250); }
  }

  /** Show VIEW_SEC seconds around the playhead (or all of a shorter recording). */
  private fitTime() {
    const p = this.h.player;
    const st = p?._state;
    const dur = Number(p?.duration) || 0;
    if (!st?._setPixelsPerSecond || !dur) return;
    const span = Math.min(VIEW_SEC, dur);
    const start = Math.max(0, Math.min(dur - span, (Number(p.currentTime) || 0) - span / 3));
    const w = st._getViewportWidth();
    if (w < 50) return;                       // player not visible yet — retried when Prüfen opens
    this.needsFit = false;
    st._setPixelsPerSecond(w / span, true, start, 0);
  }

  private mountPlayer() {
    const pr = this.h.playerRoot;
    if (!this.playerHome && pr.parentNode) this.playerHome = { parent: pr.parentNode, next: pr.nextSibling };
    this.playerSlot.appendChild(pr);
  }

  private unmountPlayer() {
    const home = this.playerHome;
    if (!home) return;
    home.parent.insertBefore(this.h.playerRoot, home.next && home.next.parentNode === home.parent ? home.next : null);
  }

  private resizePlayer() {
    requestAnimationFrame(() => { try { this.h.player?.resize?.(); } catch { /* ignore */ } });
  }

  show(screen: Screen) {
    this.screen = screen;
    for (const [id, s] of this.screens) s.hidden = id !== screen;
    const navOn = screen === 'analyse' ? (this.anBackTo === 'review' ? this.rvFrom : this.anBackTo)
      : screen === 'review' ? this.rvFrom : screen;
    for (const [id, b] of this.navBtns) b.classList.toggle('on', id === navOn);
    if (screen === 'analyse') this.renderAnalyse();
    if (screen === 'species') this.renderSpecies();
    if (screen === 'live') this.renderLive();
    if (screen === 'recordings') this.renderRecordings();
    if (screen === 'queue') this.renderQueue();
    if (screen === 'review') {
      this.renderReview();
      this.resizePlayer();
      if (this.needsFit) setTimeout(() => this.fitTime(), 120);
    }
  }

  // ── Recordings ──────────────────────────────────────────────────────

  private buildRecordings(): HTMLElement {
    const s = el('section', 'm-screen m-recordings');
    const bar = el('header', 'm-appbar');
    bar.appendChild(el('h1', '', 'Aufnahmen'));
    this.recList = el('div', 'm-scroll m-rec-list');
    const fab = button('m-fab', `${I.plus}<span>Neu</span>`, 'Aufnahme hinzufügen', () => {
      // The new file is analysed as soon as it is loaded (see the player 'ready' handler).
      this.autoAnalyse = !!this.h.analysis;
      this.h.addFile();
    });
    s.append(bar, this.recList, fab);
    this.screens.set('recordings', s);
    return s;
  }

  private renderRecordings() {
    const recs = this.h.getRecordings();
    this.recList.replaceChildren();
    if (!recs.length) {
      this.recList.appendChild(el('p', 'm-empty', 'Noch keine Aufnahmen. Mit „Neu“ eine Audiodatei öffnen.'));
      return;
    }
    for (const r of recs) {
      const card = el('button', `m-rec${r.active ? ' active' : ''}`);
      card.type = 'button';
      const { detections, open } = reviewState(r.labels, this.isOwn);
      const species = new Set(r.labels.map((l) => l.scientificName || l.label).filter(Boolean)).size;
      const main = el('div', 'm-rec-main');
      main.appendChild(el('div', 'm-rec-title', r.title));
      main.appendChild(el('div', 'm-rec-meta', [r.meta, species ? `${species} Arten` : ''].filter(Boolean).join(' · ')));
      const st = open.length
        ? el('span', 'm-status todo', `${open.length} offen`)
        : detections.length ? el('span', 'm-status done', '✓ geprüft')
        : r.labels.length ? el('span', 'm-status done', `${r.labels.length} Labels`) : el('span', 'm-status new', 'Nicht analysiert');
      card.append(main, st);
      card.addEventListener('click', async () => {
        this.autoAnalyse = false;
        if (!r.active) await this.h.openRecording(r.id);
        this.rvFrom = 'recordings';
        if (!r.labels.length && this.h.analysis) this.openAnalyse('recordings');
        else this.show('review');
      });
      this.recList.appendChild(card);
    }
  }

  // ── Queue („Prüfen“ tab) ────────────────────────────────────────────

  private get isOwn() { return this.h.isOwn ?? ((l: any) => !l.origin || l.origin === 'manual'); }

  /** Open detections over all recordings (nav badge). */
  private openTotal() {
    return this.h.getRecordings().reduce((n, r) => n + reviewState(r.labels, this.isOwn).open.length, 0);
  }

  private buildQueue(): HTMLElement {
    const s = el('section', 'm-screen m-queue');
    const bar = el('header', 'm-appbar');
    bar.appendChild(el('h1', '', 'Prüfen'));
    this.qHead = el('div', 'm-q-sum');
    this.qList = el('div', 'm-scroll m-q-list');
    s.append(bar, this.qHead, this.qList);
    this.screens.set('queue', s);
    return s;
  }

  /** Open detections grouped by recording, then species (most open first). */
  private renderQueue() {
    const total = this.openTotal();
    this.navBadge.textContent = total ? String(total) : '';
    this.navBadge.hidden = !total;
    if (!this.qList) return;
    const recs = this.h.getRecordings();
    this.qList.replaceChildren();
    let done = 0;
    let shown = 0;
    for (const rec of recs) {
      const { detections, open } = reviewState(rec.labels, this.isOwn);
      if (!open.length) { if (detections.length) done++; continue; }
      shown++;
      const group = el('div', 'm-q-rec');
      const head = el('button', 'm-q-rec-h');
      head.type = 'button';
      head.append(el('b', '', rec.title), el('span', 'm-status todo', `${open.length} offen`));
      head.addEventListener('click', () => this.openReview(rec, null));
      group.appendChild(head);
      const bySp = new Map<string, any[]>();
      for (const l of open) {
        const k = l.scientificName || l.label || '?';
        if (!bySp.has(k)) bySp.set(k, []);
        bySp.get(k)!.push(l);
      }
      const rows = [...bySp.values()].sort((a, b) => b.length - a.length);
      for (const ls of rows) {
        ls.sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0));
        const top = ls[0];
        const row = el('button', 'm-q-sp');
        row.type = 'button';
        row.append(this.speciesImg(top));
        const main = el('div', 'm-det-main');
        main.appendChild(el('div', 'm-det-name', this.h.resolveName(top)?.display || top.label || 'Unbekannt'));
        const lo = Math.round(Math.min(...ls.map((l) => Number(l.confidence) || 0)) * 100);
        const hi = Math.round((Number(top.confidence) || 0) * 100);
        main.appendChild(el('div', 'm-det-meta', `${ls.length}× · ${lo === hi ? `${hi}%` : `${lo}–${hi}%`} · ${sourceName(top)}`));
        row.append(main, el('span', 'm-q-go', ''));
        row.lastElementChild!.innerHTML = I.chevron;
        row.addEventListener('click', () => this.openReview(rec, top));
        group.appendChild(row);
      }
      this.qList.appendChild(group);
    }
    this.qHead.textContent = total
      ? `${total} offene Treffer in ${shown} ${shown === 1 ? 'Aufnahme' : 'Aufnahmen'}${done ? ` · ${done} fertig` : ''}`
      : '';
    if (!shown) {
      this.qList.appendChild(el('p', 'm-empty', recs.length
        ? (done ? 'Alles geprüft. ✓' : 'Noch nichts zu prüfen. Analysiere eine Aufnahme unter „Aufnahmen“.')
        : 'Noch keine Aufnahmen. Unter „Aufnahmen“ eine Datei öffnen oder mit „Live“ aufnehmen.'));
    }
  }

  /** Open a recording in the review screen, optionally at one detection. */
  private async openReview(rec: MobileRecording, lbl: any | null) {
    this.autoAnalyse = false;
    if (!rec.active) await this.h.openRecording(rec.id);
    this.rvFrom = 'queue';
    this.rvFilter = 'open';
    this.show('review');
    if (lbl) setTimeout(() => this.playLabel(lbl), rec.active ? 0 : 350);
  }

  private speciesImg(lbl: any) {
    const img = el('img');
    img.alt = '';
    img.loading = 'lazy';
    img.src = lbl.scientificName ? `${speciesImageBase()}${encodeURIComponent(lbl.scientificName)}.webp` : FALLBACK_IMG;
    img.addEventListener('error', () => { img.src = FALLBACK_IMG; }, { once: true });
    return img;
  }

  // ── Review ──────────────────────────────────────────────────────────

  private buildReview(): HTMLElement {
    const s = el('section', 'm-screen m-review');
    const bar = el('header', 'm-appbar');
    bar.appendChild(button('m-icon-btn', I.back, 'Zurück', () => this.show(this.rvFrom)));
    const t = el('div', 'm-appbar-title');
    this.rvTitle = el('h2', '', '');
    this.rvSub = el('small', '', '');
    t.append(this.rvTitle, this.rvSub);
    bar.appendChild(t);
    if (this.h.analysis) bar.appendChild(button('m-icon-btn', I.analyse, 'Analysieren', () => this.openAnalyse('review')));

    this.playerSlot = el('div', 'm-player');
    this.rvProgress = el('div', 'm-rv-progress');
    this.rvProgress.hidden = true;

    const time = el('div', 'm-time');
    this.timeCur = el('span', '', '00:00.0');
    this.timeDur = el('span', '', '00:00.0');
    time.append(this.timeCur, this.timeDur);

    const tr = el('div', 'm-transport');
    this.rateBtn = button('m-tbtn m-tbtn--txt', '1×', 'Wiedergabetempo', () => this.cycleRate());
    this.playBtn = button('m-play', I.play, 'Abspielen', () => this.togglePlay());
    this.loopBtn = button('m-tbtn m-tbtn--txt', 'Loop', 'Schleife', () => this.toggleLoop());
    tr.append(
      this.rateBtn,
      button('m-tbtn', I.rw, `${SKIP_SEC} s zurück`, () => this.skip(-SKIP_SEC)),
      this.playBtn,
      button('m-tbtn', I.fw, `${SKIP_SEC} s vor`, () => this.skip(SKIP_SEC)),
      this.loopBtn,
    );

    const sheet = el('div', 'm-sheet');
    sheet.appendChild(el('div', 'm-grip'));
    this.detHead = el('div', 'm-sheet-h', '');
    for (const [id, label] of [['open', 'Offen'], ['all', 'Alle']] as const) {
      const c = button('m-chip', label, label, () => { this.rvFilter = id; this.renderReview(); });
      c.dataset.label = label;
      this.rvChips.set(id, c);
    }
    this.detList = el('div', 'm-scroll m-det-list');
    sheet.append(this.detHead, this.detList);

    s.append(bar, this.rvProgress, this.playerSlot, time, tr, sheet);
    this.screens.set('review', s);
    return s;
  }

  private renderReview() {
    this.renderQueue();
    const rec = this.h.getRecordings().find((r) => r.active);
    this.rvTitle.textContent = rec?.title || 'Keine Aufnahme';
    const labels = [...this.h.getLabels()].sort((a, b) => (a.start - b.start) || (a.end - b.end));
    const { adopted, detections, open } = reviewState(labels, this.isOwn);
    this.rvSub.textContent = rec
      ? (detections.length ? `${detections.length} Treffer · ${open.length} offen` : `${labels.length} Labels`)
      : '';

    // Copies in „Meine Labels“ are shown on their detection (✓), not as a second card.
    const items = labels.filter((l) => !(this.isOwn(l) && l.adoptedFrom?.id != null));
    const openIds = new Set(open.map((l) => String(l.id)));
    if (this.rvFilter === 'open' && !open.length) this.rvFilter = 'all';
    const shown = this.rvFilter === 'open' ? items.filter((l) => openIds.has(String(l.id))) : items;

    const head = el('div', 'm-sheet-row');
    head.appendChild(el('b', '', 'Erkennungen'));
    if (detections.length) {
      const chips = el('div', 'm-rv-chips');
      for (const [id, c] of this.rvChips) {
        const n = id === 'open' ? open.length : items.length;
        c.replaceChildren(document.createTextNode(`${c.dataset.label} `), el('i', '', String(n)));
        c.classList.toggle('on', id === this.rvFilter);
        c.setAttribute('aria-pressed', String(id === this.rvFilter));
        chips.appendChild(c);
      }
      head.appendChild(chips);
    } else {
      head.firstElementChild!.textContent = `Erkennungen · ${labels.length}`;
    }
    this.detHead.replaceChildren(head);
    this.detList.replaceChildren();
    if (!rec) {
      this.detList.appendChild(el('p', 'm-empty', 'Wähle unter „Aufnahmen“ eine Aufnahme aus.'));
      return;
    }
    if (!labels.length) {
      this.detList.appendChild(el('p', 'm-empty', this.h.analysis
        ? 'Noch keine Erkennungen. Oben rechts analysieren.' : 'Noch keine Erkennungen.'));
      return;
    }
    if (!shown.length) {
      this.detList.appendChild(el('p', 'm-empty', 'Alles in dieser Aufnahme geprüft. ✓'));
      return;
    }
    for (const lbl of shown) this.detList.appendChild(this.detCard(lbl, adopted.has(String(lbl.id)), openIds.has(String(lbl.id))));
    this.markCurrent(true);
  }

  private detCard(lbl: any, confirmed: boolean, open: boolean): HTMLElement {
    // A div (not a button): the card holds the ✓/✕ buttons.
    const card = el('div', `m-det${confirmed ? ' ok' : ''}`);
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    card.dataset.id = String(lbl.id);
    card.dataset.start = String(lbl.start);
    card.dataset.end = String(lbl.end);

    const main = el('div', 'm-det-main');
    const { display } = this.h.resolveName(lbl) || { display: '' };
    main.appendChild(el('div', 'm-det-name', display || lbl.label || 'Unbekannt'));
    // Time windows (BirdNET) as a range; calls and boxes as start with tenths + length.
    const when = lbl.fullBand
      ? `${fmtClock(lbl.start, false)}–${fmtClock(lbl.end, false)}`
      : `${fmtClock(lbl.start)} · ${Math.max(0, lbl.end - lbl.start).toFixed(1)} s`;
    main.appendChild(el('div', 'm-det-meta', `${when} · ${confirmed ? 'bestätigt' : sourceName(lbl)}`));
    card.append(this.speciesImg(lbl), main);
    if (lbl.confidence != null) {
      const pct = Math.min(100, Math.round(Number(lbl.confidence) * 100));
      const bar = el('div', 'm-conf');
      const fill = el('i');
      fill.style.width = `${pct}%`;
      if (pct < 60) fill.classList.add('low');
      bar.appendChild(fill);
      main.appendChild(bar);
      card.appendChild(el('span', 'm-det-pct', `${pct}%`));
    }
    if ((open || confirmed) && this.h.acceptLabel) {
      const acts = el('div', 'm-det-acts');
      if (open) {
        acts.append(
          button('m-act no', I.x, 'Verwerfen', () => this.discard(lbl)),
          button('m-act yes', I.ok, 'Übernehmen', () => this.accept(lbl)),
        );
      } else {
        acts.appendChild(button('m-act yes on', I.ok, 'Bestätigt – tippen zum Zurücknehmen', () => this.unaccept(lbl)));
      }
      for (const b of acts.children) b.addEventListener('click', (e) => e.stopPropagation());
      card.appendChild(acts);
    }
    card.addEventListener('click', () => this.playLabel(lbl));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.playLabel(lbl); } });
    return card;
  }

  // ── Accept / discard ────────────────────────────────────────────────

  /** The open detection after `lbl` (by time), for „weiter zum nächsten“. */
  private nextOpen(lbl: any) {
    const { open } = reviewState(this.h.getLabels(), this.isOwn);
    const rest = open.filter((l) => String(l.id) !== String(lbl.id)).sort((a, b) => a.start - b.start);
    return rest.find((l) => l.start >= lbl.start) || rest[0] || null;
  }

  /** Re-render and go on with the next open detection (or stop when none is left). */
  private afterDecision(next: any) {
    this.renderReview();
    this.renderRecordings();
    if (next) this.playLabel(next);
    else this.h.player?.pause?.();
  }

  private accept(lbl: any) {
    const next = this.nextOpen(lbl);
    this.h.acceptLabel!(String(lbl.id));
    this.toast(`✓ ${this.h.resolveName(lbl)?.display || lbl.label} übernommen`, () => this.unaccept(lbl, true));
    this.afterDecision(next);
  }

  private unaccept(lbl: any, quiet = false) {
    const copy = this.h.getLabels().find((l) => this.isOwn(l) && String(l.adoptedFrom?.id) === String(lbl.id));
    if (!copy || !this.h.discardLabel) return;
    this.h.discardLabel(String(copy.id));
    if (!quiet) this.toast('Bestätigung zurückgenommen', () => this.h.restoreLabel?.(copy));
    this.renderReview();
    this.renderRecordings();
  }

  private discard(lbl: any) {
    if (!this.h.discardLabel) return;
    const next = this.nextOpen(lbl);
    const removed = this.h.discardLabel(String(lbl.id));
    this.toast(`${this.h.resolveName(lbl)?.display || lbl.label} verworfen`, removed && this.h.restoreLabel
      ? () => { this.h.restoreLabel!(removed); this.renderReview(); this.renderRecordings(); }
      : null);
    this.afterDecision(next);
  }

  /** Short message above the nav, with an optional „Rückgängig“. */
  private toast(msg: string, undo: (() => void) | null) {
    clearTimeout(this.snackTimer);
    this.snack.replaceChildren(el('span', '', msg));
    if (undo) {
      this.snack.appendChild(button('m-snack-btn', 'Rückgängig', 'Rückgängig', () => {
        this.snack.hidden = true;
        undo();
      }));
    }
    this.snack.hidden = false;
    this.snackTimer = window.setTimeout(() => { this.snack.hidden = true; }, 4000);
  }

  private playLabel(lbl: any) {
    const p = this.h.player;
    if (this.loopSeg) this.loopSeg = { start: lbl.start, end: lbl.end };
    p.playSegment(lbl.start, lbl.end, { labelId: lbl.id, loop: !!this.loopSeg });
    this.currentDetId = String(lbl.id);
    this.markCurrent(false);
  }

  /** Highlight the card under the playhead (or the last tapped one). */
  private markCurrent(scroll: boolean) {
    const t = Number(this.h.player?.currentTime) || 0;
    let cur: HTMLElement | null = null;
    for (const c of this.detList.querySelectorAll<HTMLElement>('.m-det')) {
      const inside = t >= Number(c.dataset.start) && t <= Number(c.dataset.end);
      if (c.dataset.id === this.currentDetId && inside) { cur = c; break; }
      if (!cur && inside) cur = c;
    }
    for (const c of this.detList.querySelectorAll<HTMLElement>('.m-det.cur')) if (c !== cur) c.classList.remove('cur');
    if (cur && !cur.classList.contains('cur')) {
      cur.classList.add('cur');
      if (scroll) cur.scrollIntoView({ block: 'nearest' });
    }
  }

  // ── Transport ───────────────────────────────────────────────────────

  private togglePlay() { this.h.player?.togglePlayPause?.(); }

  private skip(delta: number) { this.h.player?._state?._seekByDelta?.(delta); }

  private cycleRate() {
    const p = this.h.player;
    const cur = Number(p?.timeExpansion) || 1;
    const curRate = 1 / cur;
    const i = RATES.findIndex((r) => Math.abs(r - curRate) < 0.01);
    const next = RATES[(i + 1) % RATES.length];
    p?.setTimeExpansion?.(1 / next);
    this.rateBtn.textContent = next === 1 ? '1×' : `${next}×`;
    this.rateBtn.classList.toggle('on', next !== 1);
  }

  private toggleLoop() {
    // Loop the detection that is current; without one, loop is just a visual toggle for the next tap.
    if (this.loopSeg) {
      this.loopSeg = null;
      this.loopBtn.classList.remove('on');
      return;
    }
    const card = this.detList.querySelector<HTMLElement>('.m-det.cur');
    this.loopSeg = card ? { start: Number(card.dataset.start), end: Number(card.dataset.end) } : { start: 0, end: 0 };
    this.loopBtn.classList.add('on');
    if (card) this.h.player.playSegment(this.loopSeg.start, this.loopSeg.end, { labelId: card.dataset.id, loop: true });
  }

  private startTicker() {
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      this.tickAnalyse();
      if (this.screen !== 'review') return;
      const p = this.h.player;
      const playing = !!p?.isPlaying;
      if (this.playBtn.dataset.state !== String(playing)) {
        this.playBtn.dataset.state = String(playing);
        this.playBtn.innerHTML = playing ? I.pause : I.play;
        this.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Abspielen');
      }
      this.timeCur.textContent = fmtClock(p?.currentTime);
      this.timeDur.textContent = fmtClock(p?.duration);
      if (playing) this.markCurrent(true);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopTicker() { cancelAnimationFrame(this.raf); }

  // ── Species ─────────────────────────────────────────────────────────

  private buildSpecies(): HTMLElement {
    const s = el('section', 'm-screen m-species');
    const bar = el('header', 'm-appbar');
    bar.appendChild(el('h1', '', 'Arten'));

    const search = el('label', 'm-search');
    search.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>';
    this.spSearch = el('input');
    this.spSearch.type = 'search';
    this.spSearch.placeholder = 'Art suchen';
    this.spSearch.setAttribute('aria-label', 'Art suchen');
    this.spSearch.addEventListener('input', () => this.renderSpecies());
    search.appendChild(this.spSearch);

    const chips = el('div', 'm-chips');
    for (const [id, label] of [['all', 'Alle'], ['confirmed', 'Bestätigt'], ['detected', 'Nur erkannt']] as const) {
      const b = el('button', 'm-chip');
      b.type = 'button';
      b.addEventListener('click', () => { this.spFilter = id; this.renderSpecies(); });
      b.dataset.label = label;
      this.spChips.set(id, b);
      chips.appendChild(b);
    }

    const sortRow = el('div', 'm-sortrow');
    this.spSortBtn = el('button', 'm-sort');
    this.spSortBtn.type = 'button';
    this.spSortBtn.addEventListener('click', () => {
      this.spSort = this.spSort === 'count' ? 'conf' : this.spSort === 'conf' ? 'name' : 'count';
      this.renderSpecies();
    });
    this.spMeta = el('span', '', '');
    sortRow.append(this.spSortBtn, this.spMeta);

    this.spList = el('div', 'm-scroll m-sp-list');
    s.append(bar, search, chips, sortRow, this.spList);
    this.screens.set('species', s);
    return s;
  }

  /** Species across all recordings: confirmed (own labels) and detected (everything else). */
  private collectSpecies() {
    const isOwn = this.h.isOwn ?? ((l: any) => !l.origin || l.origin === 'manual');
    const map = new Map<string, {
      key: string; sci: string; sample: any; confirmed: number; detected: number;
      recs: Set<string>; best: number; examples: { lbl: any; rec: MobileRecording; score: number }[];
    }>();
    const recs = this.h.getRecordings();
    for (const rec of recs) {
      const { adopted } = reviewState(rec.labels, isOwn);
      for (const l of rec.labels) {
        const key = l.scientificName || '';
        if (adopted.has(String(l.id))) continue;  // counted through its copy in „Meine Labels“
        if (!key) continue;                   // species-less boxes (BirdBox "Bird") are no species
        let sp = map.get(key);
        if (!sp) {
          sp = { key, sci: key, sample: l, confirmed: 0, detected: 0, recs: new Set(), best: 0, examples: [] };
          map.set(key, sp);
        }
        if (isOwn(l)) sp.confirmed++; else sp.detected++;
        sp.recs.add(rec.id);
        const conf = l.confidence != null ? Number(l.confidence) : (isOwn(l) ? 1 : 0);
        sp.best = Math.max(sp.best, conf);
        sp.examples.push({ lbl: l, rec, score: conf + (isOwn(l) ? 0.001 : 0) });
      }
    }
    for (const sp of map.values()) sp.examples.sort((a, b) => b.score - a.score);
    return { list: [...map.values()], recCount: recs.length };
  }

  private renderSpecies() {
    if (!this.spList) return;
    const { list, recCount } = this.collectSpecies();
    const name = (sp: any) => this.h.resolveName(sp.sample)?.display || sp.sample.label || sp.sci;
    const counts = {
      all: list.length,
      confirmed: list.filter((x) => x.confirmed > 0).length,
      detected: list.filter((x) => x.confirmed === 0).length,
    };
    for (const [id, b] of this.spChips) {
      b.replaceChildren(document.createTextNode(`${b.dataset.label} `), el('i', '', String(counts[id as keyof typeof counts])));
      b.classList.toggle('on', id === this.spFilter);
      b.setAttribute('aria-pressed', String(id === this.spFilter));
    }
    this.spSortBtn.innerHTML = `Sortiert nach <b>${{ count: 'Anzahl', conf: 'Konfidenz', name: 'Name' }[this.spSort]} ▾</b>`;
    this.spMeta.textContent = `${recCount} Aufnahmen`;

    const q = this.spSearch.value.trim().toLowerCase();
    let items = list.filter((sp) => this.spFilter === 'all' || (this.spFilter === 'confirmed' ? sp.confirmed > 0 : sp.confirmed === 0));
    if (q) items = items.filter((sp) => name(sp).toLowerCase().includes(q) || sp.sci.toLowerCase().includes(q));
    items.sort((a, b) => this.spSort === 'name' ? name(a).localeCompare(name(b))
      : this.spSort === 'conf' ? b.best - a.best
      : (b.confirmed + b.detected) - (a.confirmed + a.detected) || name(a).localeCompare(name(b)));

    this.spList.replaceChildren();
    if (!items.length) {
      this.spList.appendChild(el('p', 'm-empty', list.length
        ? 'Keine Art passt zum Filter.'
        : 'Noch keine Arten. Analysiere eine Aufnahme, dann erscheinen die erkannten Arten hier.'));
      return;
    }
    for (const sp of items) {
      const open = this.spOpen.has(sp.key);
      const row = el('div', `m-sp${open ? ' open' : ''}`);
      const head = el('button', 'm-sp-head');
      head.type = 'button';
      head.setAttribute('aria-expanded', String(open));
      const img = el('img');
      img.alt = ''; img.loading = 'lazy';
      img.src = `${speciesImageBase()}${encodeURIComponent(sp.sci)}.webp`;
      img.addEventListener('error', () => { img.src = FALLBACK_IMG; }, { once: true });
      const main = el('div', 'm-sp-main');
      const n = el('div', 'm-sp-name', name(sp));
      n.appendChild(el('span', 'm-sp-sci', ` ${sp.sci}`));
      const meta = el('div', 'm-sp-meta');
      if (sp.confirmed) meta.appendChild(el('span', 'm-ok', `✓ ${sp.confirmed}`));
      meta.appendChild(document.createTextNode(`${sp.confirmed ? ' · ' : ''}${sp.detected} erkannt · ${sp.recs.size} Aufn.`));
      main.append(n, meta);
      head.append(img, main);
      head.addEventListener('click', () => {
        if (this.spOpen.has(sp.key)) this.spOpen.delete(sp.key); else this.spOpen.add(sp.key);
        this.renderSpecies();
      });
      const best = sp.examples[0];
      const play = button('m-sp-play', I.play, `Besten Beleg von ${name(sp)} abspielen`, () => this.playExample(best.rec, best.lbl));
      const top = el('div', 'm-sp-top');
      top.append(head, play);
      row.appendChild(top);

      if (open) {
        const ex = el('div', 'm-sp-ex');
        sp.examples.slice(0, 3).forEach((e, i) => {
          const b = el('button', `m-ex${i === 0 ? ' best' : ''}`);
          b.type = 'button';
          const pct = e.lbl.confidence != null ? `${Math.round(Number(e.lbl.confidence) * 100)}%` : '✓';
          b.innerHTML = `<span class="m-ex-play">${I.play}</span>`;
          const info = el('span', 'm-ex-info');
          info.append(el('b', '', pct), document.createTextNode(` · ${e.rec.title}`), el('br'),
            document.createTextNode(`${fmtClock(e.lbl.start)}${i === 0 ? ' · bester Beleg' : ''}`));
          b.appendChild(info);
          b.addEventListener('click', () => this.playExample(e.rec, e.lbl));
          ex.appendChild(b);
        });
        if (sp.examples.length > 3) ex.appendChild(el('div', 'm-ex-more', `+ ${sp.examples.length - 3} weitere`));
        row.appendChild(ex);
      }
      this.spList.appendChild(row);
    }
  }

  /** Play one example; opens its recording first if needed (stays on the species screen). */
  private async playExample(rec: MobileRecording, lbl: any) {
    if (!rec.active) {
      await this.h.openRecording(rec.id);
      await new Promise((r) => setTimeout(r, 300));
    }
    this.h.player?.playSegment?.(lbl.start, lbl.end, { labelId: lbl.id });
  }

  // ── Analyse ─────────────────────────────────────────────────────────

  openAnalyse(from: Screen) {
    this.anBackTo = from === 'analyse' ? 'review' : from;
    this.show('analyse');
  }

  private buildAnalyse(): HTMLElement {
    const s = el('section', 'm-screen m-analyse');
    const bar = el('header', 'm-appbar');
    bar.appendChild(button('m-icon-btn', I.back, 'Zurück', () => this.show(this.anBackTo)));
    const t = el('div', 'm-appbar-title');
    t.append(el('h2', '', 'Analysieren'), (this.anSub = el('small', '', '')));
    bar.appendChild(t);

    const body = el('div', 'm-scroll m-an-body');

    this.anProgress = el('div', 'm-an-progress');
    this.anProgressText = el('div', '', '');
    const track = el('div', 'm-an-bar');
    this.anProgressBar = el('i');
    track.appendChild(this.anProgressBar);
    this.anProgress.append(this.anProgressText, track);
    this.anProgress.hidden = true;

    const what = el('div', 'm-card');
    this.anBirdnet = this.toggleRow(what, 'Vogelarten (BirdNET)', 'Erkennt Arten in 3-s-Fenstern', true);
    this.anBirdbox = this.toggleRow(what, 'Rufe einzeln finden (BirdBox)', 'Box um jeden Ruf, ohne Art', false);
    if (!this.h.analysis?.birdboxBtn) this.anBirdbox.closest('.m-row')?.setAttribute('hidden', '');
    this.anGeoRow = el('div', 'm-row');
    const geoText = el('div', 'm-row-text');
    geoText.appendChild(el('span', '', 'Arten nach Ort filtern'));
    this.anLocation = el('small', '', '');
    geoText.appendChild(this.anLocation);
    this.anGeo = this.switchInput(false);
    this.anGeo.addEventListener('change', () => this.mirrorCheckbox(this.h.analysis?.geoCheckbox, this.anGeo.checked));
    this.anGeoRow.append(geoText, this.anGeo.parentElement!);
    what.appendChild(this.anGeoRow);

    const conf = el('div', 'm-card');
    const head = el('div', 'm-row m-row--plain');
    const ht = el('div', 'm-row-text');
    ht.append(el('span', '', 'Mindest-Konfidenz'), el('small', '', 'Niedriger = mehr Treffer, mehr zu prüfen'));
    this.anConfVal = el('span', 'm-row-val', '');
    head.append(ht, this.anConfVal);
    this.anConf = el('input', 'm-range');
    this.anConf.type = 'range';
    this.anConf.addEventListener('input', () => {
      const src = this.h.analysis?.confInput;
      if (!src) return;
      src.value = this.anConf.value;
      src.dispatchEvent(new Event('input', { bubbles: true }));
      src.dispatchEvent(new Event('change', { bubbles: true }));
      this.anConfVal.textContent = Number(this.anConf.value).toFixed(2);
    });
    conf.append(head, this.anConf);

    const expertCard = el('div', 'm-card');
    const expertBtn = el('button', 'm-row m-row--btn');
    expertBtn.type = 'button';
    expertBtn.innerHTML = `<span class="m-row-text"><span>Expertenoptionen</span></span><span class="m-chev">${I.chevron}</span>`;
    this.anExpert = el('div', 'm-expert');
    this.anExpert.hidden = true;
    expertBtn.addEventListener('click', () => {
      this.anExpert.hidden = !this.anExpert.hidden;
      expertBtn.classList.toggle('open', !this.anExpert.hidden);
    });
    this.buildExpert();
    expertCard.append(expertBtn, this.anExpert);

    body.append(this.anProgress, what, conf, expertCard);

    const foot = el('div', 'm-an-foot');
    this.anRun = el('button', 'm-cta', 'Analyse starten');
    this.anRun.type = 'button';
    this.anRun.addEventListener('click', () => this.runAnalysis());
    foot.appendChild(this.anRun);

    s.append(bar, body, foot);
    this.screens.set('analyse', s);
    return s;
  }

  private buildExpert() {
    const a = this.h.analysis;
    if (a?.overlapSelect) {
      const row = el('div', 'm-row');
      row.appendChild(el('div', 'm-row-text', 'Überlappung der Fenster'));
      const sel = el('select', 'm-select');
      for (const o of Array.from(a.overlapSelect.options)) sel.appendChild(new Option(o.text, o.value));
      sel.addEventListener('change', () => {
        a.overlapSelect!.value = sel.value;
        a.overlapSelect!.dispatchEvent(new Event('change', { bubbles: true }));
      });
      sel.dataset.mirror = 'overlap';
      row.appendChild(sel);
      this.anExpert.appendChild(row);
    }
    if (a?.mergeCheckbox) {
      const cb = this.toggleRow(this.anExpert, 'Überlappende Treffer zusammenfassen', '', a.mergeCheckbox.checked);
      cb.dataset.mirror = 'merge';
      cb.addEventListener('change', () => this.mirrorCheckbox(a.mergeCheckbox, cb.checked));
    }
    this.anExpert.appendChild(el('p', 'm-hint', 'Modell und Analyse-Backend werden in der Desktop-Ansicht eingestellt.'));
  }

  private toggleRow(parent: HTMLElement, label: string, hint: string, checked: boolean): HTMLInputElement {
    const row = el('label', 'm-row');
    const text = el('div', 'm-row-text');
    text.appendChild(el('span', '', label));
    if (hint) text.appendChild(el('small', '', hint));
    const input = this.switchInput(checked);
    row.append(text, input.parentElement!);
    parent.appendChild(row);
    return input;
  }

  private switchInput(checked: boolean): HTMLInputElement {
    const wrap = el('span', 'm-switch');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = checked;
    wrap.append(input, el('i'));
    return input;
  }

  private mirrorCheckbox(target: HTMLInputElement | null | undefined, checked: boolean) {
    if (!target || target.disabled || target.checked === checked) return;
    target.checked = checked;
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** Pull the current values from the desktop controls into the phone screen. */
  private renderAnalyse() {
    const a = this.h.analysis;
    const rec = this.h.getRecordings().find((r) => r.active);
    const dur = Number(this.h.player?.duration) || 0;
    this.anSub.textContent = rec ? `${rec.title}${dur ? ` · ${fmtClock(dur, false)}` : ''}` : 'Keine Aufnahme';
    if (!a) return;
    const c = a.confInput;
    this.anConf.min = c.min; this.anConf.max = c.max; this.anConf.step = c.step; this.anConf.value = c.value;
    this.anConfVal.textContent = Number(c.value).toFixed(2);
    const geo = a.geoCheckbox;
    this.anGeo.checked = !!geo?.checked;
    this.anGeo.disabled = !geo || geo.disabled;
    const loc = (a.locationLine?.textContent || '').trim();
    this.anLocation.textContent = this.anGeo.disabled ? 'Braucht das Gebietsmodell von BirdNET' : (loc || 'Kein Ort gesetzt');
    const ov = this.anExpert.querySelector<HTMLSelectElement>('[data-mirror="overlap"]');
    if (ov && a.overlapSelect) ov.value = a.overlapSelect.value;
    const mg = this.anExpert.querySelector<HTMLInputElement>('[data-mirror="merge"]');
    if (mg && a.mergeCheckbox) mg.checked = a.mergeCheckbox.checked;
    this.anRun.disabled = !rec || this.anJob !== 'idle';
  }

  /** Analyse the active recording with the current settings and show it in the review screen. */
  private analyseNow() {
    if (!this.h.analysis || this.anJob !== 'idle') return;
    this.renderAnalyse();
    this.rvFrom = 'queue';
    this.show('review');
    this.runAnalysis();
  }

  private runAnalysis() {
    const a = this.h.analysis;
    if (!a || this.anJob !== 'idle') return;
    if (this.anBirdnet.checked) this.startJob('birdnet');
    else if (this.anBirdbox.checked) this.startJob('birdbox');
  }

  private startJob(job: 'birdnet' | 'birdbox') {
    const a = this.h.analysis!;
    const btn = job === 'birdnet' ? a.analyzeBtn : a.birdboxBtn;
    if (!btn || btn.disabled) { this.anJob = 'idle'; return; }
    this.anJob = job;
    this.anJobStarted = false;
    this.anJobAt = performance.now();
    this.anRun.disabled = true;
    this.anProgress.hidden = false;
    btn.click();
  }

  private jobRunning(job: 'birdnet' | 'birdbox'): boolean {
    const a = this.h.analysis!;
    if (job === 'birdnet') return a.analyzeBtn.disabled;
    const w = a.birdboxProgressWrap;
    return !!w && w.style.display !== 'none';
  }

  /** Follow the running job (called from the ticker). */
  private tickAnalyse() {
    if (this.anJob === 'idle' || !this.h.analysis) return;
    const a = this.h.analysis;
    const job = this.anJob;
    const running = this.jobRunning(job);
    if (running) this.anJobStarted = true;
    const status = (job === 'birdnet' ? a.status : a.birdboxStatus)?.textContent?.trim() || '';
    const bar = job === 'birdnet' ? a.progressBar : a.birdboxProgressBar;
    this.anProgressText.textContent = `${job === 'birdnet' ? 'BirdNET' : 'BirdBox'} läuft …${status ? ` ${status}` : ''}`;
    this.anProgressBar.style.width = bar?.style.width || '0%';
    this.rvProgress.hidden = false;
    this.rvProgress.textContent = this.anProgressText.textContent;
    this.rvProgress.style.setProperty('--p', bar?.style.width || '0%');
    if (running) return;
    if (!this.anJobStarted) {
      // The click did not start a run (no audio, model failed…): give up after a few seconds.
      if (performance.now() - this.anJobAt < 4000) return;
      this.anJob = 'idle';
      this.anProgressText.textContent = status || 'Analyse konnte nicht starten';
      this.anRun.disabled = false;
      this.rvProgress.hidden = true;
      return;
    }

    // Finished: chain BirdBox after BirdNET if asked, else show the results.
    if (job === 'birdnet' && this.anBirdbox.checked && a.birdboxBtn) { this.startJob('birdbox'); return; }
    this.anJob = 'idle';
    this.anProgressText.textContent = status || 'Fertig';
    this.anProgressBar.style.width = '100%';
    this.anRun.disabled = false;
    setTimeout(() => { this.anProgress.hidden = true; this.rvProgress.hidden = true; }, 1500);
    this.rvFilter = 'open';
    if (this.screen === 'analyse') this.show('review');
    else if (this.screen === 'review') this.renderReview();
  }

  // ── Live ────────────────────────────────────────────────────────────

  private buildLive(): HTMLElement {
    const s = el('section', 'm-screen m-live');
    const bar = el('header', 'm-appbar');
    bar.appendChild(el('h1', '', 'Live'));
    const top = el('div', 'm-live-top');
    const meter = el('div', 'm-live-meter');
    meter.innerHTML = '<span>Pegel</span><i><b></b></i>';
    this.lvMeter = meter.querySelector('b')!;
    this.lvInfo = el('span', 'm-live-info');
    top.append(meter, this.lvInfo);
    this.lvSpec = el('div', 'm-live-spec');
    this.lvSpec.appendChild(el('span', 'm-live-hint', 'Aufnahme starten – das Spektrogramm läuft hier von rechts nach links.'));
    this.lvList = el('div', 'm-scroll m-live-list');
    const foot = el('div', 'm-live-foot');
    this.lvTime = el('div', 'm-live-time', '00:00');
    this.lvDiscard = button('m-live-discard', 'Verwerfen', 'Aufnahme verwerfen', () => this.stopLive(false));
    this.lvBtn = button('m-live-rec', '<i></i>', 'Aufnahme starten', () => {
      if (this.lvRec) void this.stopLive(true); else void this.startLive();
    });
    const spacer = el('span', 'm-live-discard-spacer');
    foot.append(this.lvDiscard, this.lvBtn, spacer);
    s.append(bar, top, this.lvSpec, this.lvList, this.lvTime, foot);
    this.screens.set('live', s);
    return s;
  }

  private renderLive() {
    const on = !!this.lvRec;
    this.lvBtn.classList.toggle('on', on);
    this.lvBtn.setAttribute('aria-label', on ? 'Stoppen und speichern' : 'Aufnahme starten');
    this.lvDiscard.hidden = !on;
    this.lvTime.classList.toggle('on', on);
    if (!on && !this.lvInfo.textContent) this.lvInfo.textContent = this.h.live?.describe?.() || 'BirdNET · alle 3 s';
    const rows = [...this.lvSpecies.values()].sort((a, b) => b.last - a.last || b.max - a.max);
    this.lvList.replaceChildren();
    if (!rows.length) {
      this.lvList.appendChild(el('p', 'm-empty', on ? 'Noch keine Art erkannt …'
        : this.h.live ? 'Erkannte Arten erscheinen hier, während aufgenommen wird.' : 'Live-Erkennung ist hier nicht verfügbar.'));
      return;
    }
    const now = this.lvRec?.elapsed ?? Infinity;
    for (const r of rows) {
      const row = el('div', `m-live-row${on && now - r.last < 6 ? ' new' : ''}`);
      const img = el('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = `${speciesImageBase()}${encodeURIComponent(r.sci)}.webp`;
      img.addEventListener('error', () => { img.src = FALLBACK_IMG; }, { once: true });
      const txt = el('div', 'm-live-row-txt');
      txt.append(el('div', 'm-live-row-name', r.common || r.sci),
        el('div', 'm-live-row-sub', `${on ? this.ago(now - r.last) : fmtClock(r.last, false)} · ${r.count}×`));
      const c = el('div', 'm-live-row-conf', `${Math.round(r.max * 100)}%`);
      c.appendChild(el('small', '', 'max'));
      row.append(img, txt, c);
      this.lvList.appendChild(row);
    }
  }

  private ago(sec: number) {
    if (sec < 6) return 'gerade eben';
    if (sec < 60) return `vor ${Math.round(sec / 5) * 5} s`;
    return `vor ${Math.floor(sec / 60)} min`;
  }

  private async startLive() {
    const live = this.h.live;
    if (!live || this.lvRec) return;
    if (!LiveRecorder.supported) { this.lvInfo.textContent = 'Mikrofon wird hier nicht unterstützt.'; return; }
    try { this.h.player?.pause?.(); } catch { /* ignore */ }
    this.lvBtn.disabled = true;
    let classify: Awaited<ReturnType<LiveHost['prepare']>>;
    try {
      classify = await live.prepare((msg) => { this.lvInfo.textContent = msg; });
    } catch (err: any) {
      this.lvInfo.textContent = `BirdNET: ${err?.message || err}`;
      this.lvBtn.disabled = false;
      return;
    }
    const rec = new LiveRecorder({ maxSeconds: 60 * 60 });
    this.lvSpecies.clear();
    // 3 s chunks at the device rate; BirdNET resamples. A slow phone drops chunks instead of lagging.
    let buf: Float32Array | null = null, n = 0, chunkStart = 0;
    const queue: { pcm: Float32Array; at: number }[] = [];
    const pump = async () => {
      if (this.lvBusy) return;
      this.lvBusy = true;
      while (queue.length && this.lvRec === rec) {
        const { pcm, at } = queue.shift()!;
        try {
          const preds = await classify.analyze(pcm, rec.sampleRate);
          for (const p of preds) {
            const e = this.lvSpecies.get(p.scientific);
            if (e) { e.count++; e.max = Math.max(e.max, p.confidence); e.last = at; }
            else this.lvSpecies.set(p.scientific, { sci: p.scientific, common: p.common, count: 1, max: p.confidence, last: at });
          }
          if (preds.length && this.screen === 'live') this.renderLive();
        } catch (err) { console.warn('Live BirdNET:', err); }
      }
      this.lvBusy = false;
    };
    rec.ondata = (c) => {
      const size = rec.sampleRate * 3;
      if (!buf) buf = new Float32Array(size);
      let i = 0;
      while (i < c.length) {
        const k = Math.min(size - n, c.length - i);
        buf.set(c.subarray(i, i + k), n);
        n += k; i += k;
        if (n === size) {
          queue.push({ pcm: buf, at: chunkStart });
          if (queue.length > 2) queue.shift();
          chunkStart += 3;
          buf = new Float32Array(size); n = 0;
          void pump();
        }
      }
    };
    rec.addEventListener('stop', (e) => {
      // Limit reached or microphone gone: keep what was recorded.
      const reason = (e as CustomEvent).detail?.reason;
      if (reason !== 'user' && this.lvRec === rec) void this.stopLive(true);
    });
    try {
      await rec.start();
    } catch (err: any) {
      this.lvInfo.textContent = err?.name === 'NotAllowedError' ? 'Kein Zugriff aufs Mikrofon.' : `Mikrofon: ${err?.message || err}`;
      this.lvBtn.disabled = false;
      return;
    }
    this.lvRec = rec;
    this.lvBtn.disabled = false;
    this.lvInfo.textContent = live.describe?.() || 'BirdNET · alle 3 s';
    this.lvSpec.querySelector('.m-live-hint')?.remove();
    const view = new LiveSpectrogramView(this.lvSpec, { spanSeconds: 15, getMaxFreq: () => 12000 });
    view.attach(rec);
    this.lvView = view;
    const level = new Float32Array(1024);
    const loop = () => {
      const an = rec.analyser;
      if (an) {
        an.getFloatTimeDomainData(level);
        let peak = 0;
        for (let i = 0; i < level.length; i++) peak = Math.max(peak, Math.abs(level[i]));
        const db = 20 * Math.log10(peak || 1e-6);
        this.lvMeter.style.width = `${Math.max(0, Math.min(100, (db + 60) / 60 * 100))}%`;
        this.lvMeter.classList.toggle('clip', peak > 0.98);
      }
      this.lvTime.textContent = fmtClock(rec.elapsed, false);
      this.lvRaf = requestAnimationFrame(loop);
    };
    this.lvRaf = requestAnimationFrame(loop);
    this.lvTick = window.setInterval(() => { if (this.screen === 'live') this.renderLive(); }, 5000);
    this.renderLive();
  }

  /** Ends the live recording; `keep` adds it to the project and opens it. */
  private async stopLive(keep: boolean) {
    const rec = this.lvRec;
    if (!rec) return;
    this.lvRec = null;
    cancelAnimationFrame(this.lvRaf);
    clearInterval(this.lvTick);
    this.lvMeter.style.width = '0%';
    rec.ondata = null;
    if (!keep) rec.cancel();
    const recording = keep ? await rec.stop('user') : null;
    this.lvView?.detach();
    this.lvView = null;
    this.lvSpec.replaceChildren(el('span', 'm-live-hint', keep ? 'Aufnahme gespeichert.' : 'Aufnahme verworfen.'));
    this.renderLive();
    if (recording && this.h.live) {
      this.lvInfo.textContent = 'Wird gespeichert …';
      try {
        // The saved recording opens in „Prüfen“ and is analysed there (player 'ready' handler).
        this.autoAnalyse = !!this.h.analysis;
        await this.h.live.save(recording.file);
        this.lvInfo.textContent = `Gespeichert: ${recording.file.name}`;
      } catch (err: any) {
        this.lvInfo.textContent = `Speichern fehlgeschlagen: ${err?.message || err}`;
      }
    }
  }
}
