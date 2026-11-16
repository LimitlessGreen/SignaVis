/**
 * SignaVis mobile — its own UI for phones (plans/mobile-ui-plan.md, design: plans/mobile-design/mockup.html).
 *
 * On phones (PHONE_QUERY) the desktop shell is hidden and this app is shown instead.
 * It reuses the app's data and the one BirdNETPlayer instance: the player root is moved
 * into the review screen while the phone UI is active and moved back afterwards; CSS
 * (`html.is-mobile`) hides the player's desktop chrome (toolbar, waveform, zoom strip).
 *
 * Screens (bottom nav): Aufnahmen · Prüfen · Live · Arten. Live and Arten are placeholders
 * for now. Review is view-and-listen only; accept/discard is planned but not built yet.
 */
import { speciesImageBase } from '../../infrastructure/tauri/runtime.ts';

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
  /** Open the file picker to add audio. */
  addFile(): void;
  /** Called when phone mode is entered (true) or left (false). */
  onModeChange?(phone: boolean): void;
  /**
   * The app's analysis controls (desktop Analyse panel). The phone screen drives these
   * elements, so BirdNET / BirdBox keep one implementation.
   */
  analysis?: AnalysisControls;
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

type Screen = 'recordings' | 'review' | 'analyse' | 'live' | 'species';

const FALLBACK_IMG = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Crect width='40' height='40' fill='%23252525'/%3E%3Cpath d='M20 9c-4 0-7 3-8 6l-4-2c-1-1-2 0-1 1l3 5c-1 1-2 3-2 5 0 6 5 10 12 10s12-4 12-10c0-2-1-3-1-4l3-5c1-1-1-2-2-1l-4 3c-1-4-4-8-8-8z' fill='%23444'/%3E%3C/svg%3E`;

const I = {
  lib: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5"/></svg>',
  bird: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M16 7h.01"/><path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20"/><path d="m20 7 2 .5-2 .5"/><path d="M10 18v3M14 17.75V21M7 18a6 6 0 0 0 3.84-10.61"/></svg>',
  analyse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h3l3-8 4 16 3-8h5"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
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
  private loopSeg: { start: number; end: number } | null = null;

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
    body.append(this.buildRecordings(), this.buildReview(), this.buildAnalyse(), this.buildPlaceholder('live', 'Live',
      'Live-Erkennung mit dem Mikrofon kommt hier hin.'), this.buildPlaceholder('species', 'Arten',
      'Hier entsteht die Artenliste über alle Aufnahmen.'));
    const nav = el('nav', 'm-nav');
    nav.setAttribute('aria-label', 'Navigation');
    for (const [id, icon, label] of [['recordings', I.lib, 'Aufnahmen'], ['review', I.check, 'Prüfen'],
      ['live', I.mic, 'Live'], ['species', I.bird, 'Arten']] as [Screen, string, string][]) {
      const b = el('button', 'm-nav-btn');
      b.type = 'button';
      b.innerHTML = `<span class="m-nav-pill">${icon}</span><span>${label}</span>`;
      b.addEventListener('click', () => this.show(id));
      this.navBtns.set(id, b);
      nav.appendChild(b);
    }
    this.navBadge = el('span', 'm-nav-badge');
    this.navBtns.get('review')!.appendChild(this.navBadge);
    this.root.append(body, nav);
    document.body.appendChild(this.root);

    // A newly loaded recording starts with the phone time span.
    host.player?.on?.('ready', () => { this.needsFit = true; if (this.active) setTimeout(() => this.fitTime(), 250); });

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
      this.show(this.h.getRecordings().some((r) => r.active) ? 'review' : 'recordings');
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
    const navOn = screen === 'analyse' ? this.anBackTo : screen;
    for (const [id, b] of this.navBtns) b.classList.toggle('on', id === navOn);
    if (screen === 'analyse') this.renderAnalyse();
    if (screen === 'recordings') this.renderRecordings();
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
    const fab = button('m-fab', `${I.plus}<span>Neu</span>`, 'Aufnahme hinzufügen', () => this.h.addFile());
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
      const detections = r.labels.filter((l) => l.origin && l.origin !== 'manual').length;
      const species = new Set(r.labels.map((l) => l.scientificName || l.label).filter(Boolean)).size;
      const main = el('div', 'm-rec-main');
      main.appendChild(el('div', 'm-rec-title', r.title));
      main.appendChild(el('div', 'm-rec-meta', [r.meta, species ? `${species} Arten` : ''].filter(Boolean).join(' · ')));
      const st = detections
        ? el('span', 'm-status todo', `${detections} Treffer`)
        : r.labels.length ? el('span', 'm-status done', `${r.labels.length} Labels`) : el('span', 'm-status new', 'Nicht analysiert');
      card.append(main, st);
      card.addEventListener('click', async () => {
        if (!r.active) await this.h.openRecording(r.id);
        if (!r.labels.length && this.h.analysis) this.openAnalyse('recordings');
        else this.show('review');
      });
      this.recList.appendChild(card);
    }
  }

  // ── Review ──────────────────────────────────────────────────────────

  private buildReview(): HTMLElement {
    const s = el('section', 'm-screen m-review');
    const bar = el('header', 'm-appbar');
    bar.appendChild(button('m-icon-btn', I.back, 'Zurück zu den Aufnahmen', () => this.show('recordings')));
    const t = el('div', 'm-appbar-title');
    this.rvTitle = el('h2', '', '');
    this.rvSub = el('small', '', '');
    t.append(this.rvTitle, this.rvSub);
    bar.appendChild(t);
    if (this.h.analysis) bar.appendChild(button('m-icon-btn', I.analyse, 'Analysieren', () => this.openAnalyse('review')));

    this.playerSlot = el('div', 'm-player');

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
    this.detList = el('div', 'm-scroll m-det-list');
    sheet.append(this.detHead, this.detList);

    s.append(bar, this.playerSlot, time, tr, sheet);
    this.screens.set('review', s);
    return s;
  }

  private renderReview() {
    const rec = this.h.getRecordings().find((r) => r.active);
    this.rvTitle.textContent = rec?.title || 'Keine Aufnahme';
    const labels = [...this.h.getLabels()].sort((a, b) => (a.start - b.start) || (a.end - b.end));
    const det = labels.filter((l) => l.origin && l.origin !== 'manual').length;
    this.rvSub.textContent = rec ? `${labels.length} Labels${det ? ` · ${det} Treffer` : ''}` : '';
    this.navBadge.textContent = det ? String(det) : '';
    this.navBadge.hidden = !det;

    this.detHead.replaceChildren(el('b', '', `Erkennungen · ${labels.length}`));
    this.detList.replaceChildren();
    if (!rec) {
      this.detList.appendChild(el('p', 'm-empty', 'Wähle unter „Aufnahmen“ eine Aufnahme aus.'));
      return;
    }
    if (!labels.length) {
      this.detList.appendChild(el('p', 'm-empty', 'Noch keine Erkennungen. Die Analyse kommt als Nächstes in die mobile Version.'));
      return;
    }
    for (const lbl of labels) this.detList.appendChild(this.detCard(lbl));
    this.markCurrent(true);
  }

  private detCard(lbl: any): HTMLElement {
    const card = el('button', 'm-det');
    card.type = 'button';
    card.dataset.id = String(lbl.id);
    card.dataset.start = String(lbl.start);
    card.dataset.end = String(lbl.end);

    const img = el('img');
    img.alt = '';
    img.loading = 'lazy';
    img.src = lbl.scientificName ? `${speciesImageBase()}${encodeURIComponent(lbl.scientificName)}.webp` : FALLBACK_IMG;
    img.addEventListener('error', () => { img.src = FALLBACK_IMG; }, { once: true });

    const main = el('div', 'm-det-main');
    const { display } = this.h.resolveName(lbl) || { display: '' };
    main.appendChild(el('div', 'm-det-name', display || lbl.label || 'Unbekannt'));
    // Time windows (BirdNET) as a range; calls and boxes as start with tenths + length.
    const when = lbl.fullBand
      ? `${fmtClock(lbl.start, false)}–${fmtClock(lbl.end, false)}`
      : `${fmtClock(lbl.start)} · ${Math.max(0, lbl.end - lbl.start).toFixed(1)} s`;
    main.appendChild(el('div', 'm-det-meta', `${when} · ${sourceName(lbl)}`));
    if (lbl.confidence != null) {
      const pct = Math.min(100, Math.round(Number(lbl.confidence) * 100));
      const bar = el('div', 'm-conf');
      const fill = el('i');
      fill.style.width = `${pct}%`;
      if (pct < 60) fill.classList.add('low');
      bar.appendChild(fill);
      main.appendChild(bar);
      card.append(img, main, el('span', 'm-det-pct', `${pct}%`));
    } else {
      card.append(img, main);
    }
    card.addEventListener('click', () => this.playLabel(lbl));
    return card;
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
    if (running) return;
    if (!this.anJobStarted) {
      // The click did not start a run (no audio, model failed…): give up after a few seconds.
      if (performance.now() - this.anJobAt < 4000) return;
      this.anJob = 'idle';
      this.anProgressText.textContent = status || 'Analyse konnte nicht starten';
      this.anRun.disabled = false;
      return;
    }

    // Finished: chain BirdBox after BirdNET if asked, else show the results.
    if (job === 'birdnet' && this.anBirdbox.checked && a.birdboxBtn) { this.startJob('birdbox'); return; }
    this.anJob = 'idle';
    this.anProgressText.textContent = status || 'Fertig';
    this.anProgressBar.style.width = '100%';
    this.anRun.disabled = false;
    setTimeout(() => { this.anProgress.hidden = true; }, 1500);
    if (this.screen === 'analyse') this.show('review');
  }

  // ── Placeholders ────────────────────────────────────────────────────

  private buildPlaceholder(id: Screen, title: string, text: string): HTMLElement {
    const s = el('section', 'm-screen');
    const bar = el('header', 'm-appbar');
    bar.appendChild(el('h1', '', title));
    s.append(bar, el('p', 'm-empty', text));
    this.screens.set(id, s);
    return s;
  }
}
