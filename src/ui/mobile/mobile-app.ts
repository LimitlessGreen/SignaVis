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
}

type Screen = 'recordings' | 'review' | 'live' | 'species';

const FALLBACK_IMG = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Crect width='40' height='40' fill='%23252525'/%3E%3Cpath d='M20 9c-4 0-7 3-8 6l-4-2c-1-1-2 0-1 1l3 5c-1 1-2 3-2 5 0 6 5 10 12 10s12-4 12-10c0-2-1-3-1-4l3-5c1-1-1-2-2-1l-4 3c-1-4-4-8-8-8z' fill='%23444'/%3E%3C/svg%3E`;

const I = {
  lib: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5"/></svg>',
  bird: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M16 7h.01"/><path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20"/><path d="m20 7 2 .5-2 .5"/><path d="M10 18v3M14 17.75V21M7 18a6 6 0 0 0 3.84-10.61"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l12-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  rw: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  fw: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
};

const SKIP_SEC = 5;
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

  // Where the player root lives on the desktop
  private playerHome: { parent: Node; next: Node | null } | null = null;
  private raf = 0;

  constructor(host: MobileAppHost) {
    this.h = host;
    this.root = el('div', 'm-app');
    this.root.setAttribute('aria-label', 'SignaVis');
    const body = el('div', 'm-screens');
    body.append(this.buildRecordings(), this.buildReview(), this.buildPlaceholder('live', 'Live',
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
    for (const [id, b] of this.navBtns) b.classList.toggle('on', id === screen);
    if (screen === 'recordings') this.renderRecordings();
    if (screen === 'review') { this.renderReview(); this.resizePlayer(); }
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
        this.show('review');
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
    main.appendChild(el('div', 'm-det-meta', `${fmtClock(lbl.start, false)}–${fmtClock(lbl.end, false)} · ${sourceName(lbl)}`));
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
