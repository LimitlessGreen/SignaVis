/**
 * SignaVis mobile — its own UI for phones (mobile ui plan).
 *
 * On phones (PHONE_QUERY) the desktop shell is hidden and this app is shown instead.
 * It reuses the app's data and the one BirdNETPlayer instance: the player root is moved
 * into the review screen while the phone UI is active and moved back afterwards; CSS
 * (`html.is-mobile`) hides the player's desktop chrome (toolbar, waveform, zoom strip).
 *
 * The phone is a viewer (Xeno-canto recordings first): Aufnahmen · Player · Live · Arten.
 * The review workflow below (queue, ✓/✕, swipe) is kept but switched off (REVIEW_WORKFLOW).
 * Screens with the review workflow: Aufnahmen · Prüfen · Live · Arten.
 * „Prüfen“ is a queue of open detections over all recordings; a tap opens the recording (review screen)
 * where ✓ copies a detection into „Meine Labels“ and ✕ removes it (both with undo).
 * New files and Live recordings are analysed right away with the current analysis settings.
 */
import { speciesImageUrl } from '../../infrastructure/tauri/runtime.ts';
import { normalizeSearch, matchTier, MATCH } from '../components/taxonomy-ui/species-ranking.ts';
import { LiveRecorder } from '../../infrastructure/audio/LiveRecorder.ts';
import { LiveSpectrogramView } from '../components/live-view/live-spectrogram-view.ts';
import { t, getLang, setLang } from './i18n.ts';
import { renderThumb, thumbFromUrl } from './thumb.ts';
import { SpectrogramGestures } from './gestures.ts';
import { getSpectrogramColor } from '../../domain/spectrogram.ts';
import { MobileDetailsView, type MobileDetails } from './details.ts';
import type { ContextField, ContextValues } from '../../app/recording-context.ts';

export const PHONE_QUERY = '(max-width: 600px), (pointer: coarse) and (max-height: 500px)';

export interface MobileRecording {
  id: string;
  title: string;
  /** Short line under the title, e.g. "Xeno-canto" or "48 kHz". */
  meta: string;
  labels: any[];
  active: boolean;
  /** Length in seconds, once known. */
  duration?: number | null;
  /** Mini spectrogram (data URL), once rendered. */
  thumb?: string | null;
  /** Audio source, used to render the thumbnail of a recording that is not open. */
  audioUrl?: string | null;
  /** Recording date (YYYY-MM-DD) and time (HH:MM), if known. */
  date?: string | null;
  time?: string | null;
  /** When it was added to the project (ISO); shown when the recording date is unknown. */
  addedAt?: string | null;
  /** Place name or coordinates. */
  place?: string | null;
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
  /** Common names in all languages, so the species filter also finds other-language names. */
  altNames?(scientificName: string): string[];
  /** True for labels in "My labels" (confirmed by the user). */
  isOwn?(lbl: any): boolean;
  /** Open the file picker to add audio. */
  addFile(): void;
  /** Load a Xeno-canto recording (number or URL) into the project and open it. */
  addXenoCanto?(raw: string): Promise<boolean | void> | boolean | void;
  /** Remember thumbnail / duration on the recording (so they survive a reload). */
  setRecordingInfo?(id: string, info: { thumb?: string | null; duration?: number }): void;
  /** ✓: copy a detection of the active recording into "My labels" (desktop: spectrogramlabeladopt). */
  acceptLabel?(id: string): void;
  /** ✕: remove a label of the active recording; returns the removed label (for undo). */
  discardLabel?(id: string): any;
  /** Undo for ✕: put a removed label back into the active recording. */
  restoreLabel?(lbl: any): void;
  /** Called when phone mode is entered (true) or left (false). */
  onModeChange?(phone: boolean): void;
  /** Xeno-canto API key (shared with the desktop XC panel); setting it imports the open recording's labels + metadata. */
  xcKey?: { get(): string; set(key: string): void | Promise<void> };
  /**
   * The app's analysis controls (desktop Analyse panel). The phone screen drives these
   * elements, so BirdNET / BirdBox keep one implementation.
   */
  analysis?: AnalysisControls;
  /** Live screen: microphone + BirdNET every 3 s; the recording is added to the project. */
  live?: LiveHost;
  /** Properties of the active recording for the Details screen (null: none open). */
  getDetails?(): MobileDetails | null;
  /** Store a manual date/time/place/position of the active recording (null: back to automatic). */
  setContext?(field: ContextField, value: ContextValues[ContextField] | null): void;
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
  /** Desktop model picker (`.seg-btn[data-value]` buttons); the phone clicks them, so one picker stays the truth. */
  modelSeg?: HTMLElement | null;
  /** BirdBox sliders: minimum confidence and the gap that fuses neighbouring boxes. */
  birdboxConf?: HTMLInputElement | null;
  birdboxGap?: HTMLInputElement | null;
  /** Start an analysis (same as the desktop buttons). */
  run(job: 'birdnet' | 'birdbox'): void;
}

type Screen = 'recordings' | 'queue' | 'review' | 'analyse' | 'live' | 'species' | 'settings' | 'details';

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
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M10 17v-5l4-1v5"/><circle cx="9" cy="17" r="1.2"/><circle cx="13" cy="16" r="1.2"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  zoomIn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  zoomOut: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14"/></svg>',
  fit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4H4v4M16 4h4v4M8 20H4v-4M16 20h4v-4"/></svg>',
  tune: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>',
  loop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/></svg>',
  wave: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4 10v4M8 6v12M12 9v6M16 4v16M20 10v4"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l12-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  rw: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  fw: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
};

const SKIP_SEC = 5;
/** Upper frequency on the phone when the recording has no clear top. */
const PHONE_MAX_HZ = 12000;
/** Queue, ✓/✕ and swiping on the phone. Off: the phone is a viewer; labeling stays on the desktop. */
const REVIEW_WORKFLOW = false;

/** Phone texts for the desktop model picker's notes (the desktop ones are English only). */
const MODEL_NOTES: Record<string, 'an.note.v3' | 'an.note.v3full' | 'an.note.v24' | 'an.note.anura' | 'an.note.custom'> = {
  'v3.0': 'an.note.v3', 'v3.0-12k': 'an.note.v3full', 'v2.4': 'an.note.v24', anurapam: 'an.note.anura', custom: 'an.note.custom',
};
/** Species colours on the spectrogram and in the species strip; picked to stand out on the inferno palette. */
const PALETTE = ['#22d3ee', '#a3e635', '#f472b6', '#a78bfa', '#60a5fa', '#facc15', '#2dd4bf', '#fb923c', '#e879f9', '#f87171'];
/** Phone-only viewer settings (the spectrogram settings live in the player and are stored there). */
interface PhoneSettings { freq: 'auto' | 'full' | number; minConf: number; autoAnalyse: boolean }
const SETTINGS_KEY = 'signavis.mobile.settings.v1';
function loadSettings(): PhoneSettings {
  try {
    const v = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return { freq: v.freq ?? 'auto', minConf: Number(v.minConf) || 0, autoAnalyse: v.autoAnalyse === true };
  } catch { return { freq: 'auto', minConf: 0, autoAnalyse: false }; }
}
const speciesKey = (l: any) => String(l.scientificName || l.label || '?');
/** Live recordings are held in memory until Stop: keep them short enough for a phone tab. */
const LIVE_MAX_SEC = 15 * 60;
/** Seconds visible in the spectrogram on phones (the desktop default is far too zoomed in there). */
const VIEW_SEC = 10;
/** Seconds shown in the live spectrogram. */
const LIVE_SPAN_SEC = 15;
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

/** „today 05:42“, „yesterday 20:15“, „14 Nov 06:10“ (older years with the year). */
export function fmtWhen(r: { date?: string | null; time?: string | null; addedAt?: string | null }, now = new Date()) {
  let d: Date | null = null;
  let time = r.time || '';
  if (r.date) d = new Date(`${r.date}T${time || '12:00'}:00`);
  else if (r.addedAt) {
    d = new Date(r.addedAt);
    time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  if (!d || Number.isNaN(d.getTime())) return '';
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  const lang = getLang();
  const label = diff === 0 ? t('date.today') : diff === 1 ? t('date.yesterday')
    : d.toLocaleDateString(lang, d.getFullYear() === now.getFullYear()
      ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
  return time ? `${label} ${time}` : label;
}

function sourceName(lbl: any) {
  const o = String(lbl.origin || '');
  if (o === 'BirdNET') return 'BirdNET';
  if (o === 'BirdBox') return 'BirdBox';
  if (o === 'xeno-canto') return 'Xeno-canto';
  return o && o !== 'manual' ? o : t('source.own');
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
  private rvFrom: Screen = REVIEW_WORKFLOW ? 'queue' : 'recordings';
  private qList!: HTMLElement;
  private qHead!: HTMLElement;
  private snack!: HTMLElement;
  private newMenu!: HTMLElement;
  private xcInput!: HTMLInputElement;
  /** Thumbnails being rendered in the background (ids), and ones that failed. */
  private thumbBusy = false;
  private swipedAt = 0;
  private thumbFailed = new Set<string>();
  private snackTimer = 0;
  private rvProgress!: HTMLElement;
  /** Analyse the next recording that gets loaded (after „Neu“ or Live). */
  private autoAnalyse = false;
  private loopSeg: { start: number; end: number } | null = null;
  // Viewer: species strip and colours
  private strip!: HTMLElement;
  private colorOf = new Map<string, string>();
  private keyOfId = new Map<string, string>();
  private focusKey: string | null = null;
  private stripCur = '';
  private paintRaf = 0;
  private gestures: SpectrogramGestures | null = null;
  /** Changes whenever the shown detections change (overview marks are rebuilt then). */
  private labelRev = 0;
  private cfg: PhoneSettings = loadSettings();
  private setBackTo: Screen = 'recordings';
  private setBody!: HTMLElement;
  private details: MobileDetailsView | null = null;
  private detBackTo: Screen = 'review';
  // Own overview strip under the spectrogram
  private ov!: HTMLElement;
  private ovWin!: HTMLElement;
  private ovHead!: HTMLElement;
  private ovMarks!: HTMLElement;
  private ovSig = '';
  private tune!: HTMLElement;
  private tuneBtn!: HTMLButtonElement;

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
  private anDetectors!: HTMLElement;
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
  private lvMarksEl!: HTMLElement;
  private lvMarks: { el: HTMLElement; at: number }[] = [];
  private lvColors = new Map<string, string>();

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
    body.append(this.buildRecordings(), this.buildQueue(), this.buildReview(), this.buildAnalyse(), this.buildLive(), this.buildSpecies(), this.buildSettings(), this.buildDetails());
    const nav = el('nav', 'm-nav');
    nav.setAttribute('aria-label', t('nav.label'));
    const second: [Screen, string, string] = REVIEW_WORKFLOW ? ['queue', I.check, t('nav.review')] : ['review', I.wave, t('nav.player')];
    for (const [id, icon, label] of [['recordings', I.lib, t('nav.recordings')], second,
      ['live', I.mic, t('nav.live')], ['species', I.bird, t('nav.species')]] as [Screen, string, string][]) {
      const b = el('button', 'm-nav-btn');
      b.type = 'button';
      b.innerHTML = `<span class="m-nav-pill">${icon}</span><span>${label}</span>`;
      b.addEventListener('click', () => this.show(id));
      this.navBtns.set(id, b);
      nav.appendChild(b);
    }
    this.navBadge = el('span', 'm-nav-badge');
    this.navBadge.hidden = true;
    this.navBtns.get('queue')?.appendChild(this.navBadge);
    this.snack = el('div', 'm-snack');
    this.snack.hidden = true;
    this.root.append(body, this.snack, nav);
    document.body.appendChild(this.root);

    // Touch gestures on the spectrogram, and species colours on its labels.
    const spec = host.playerRoot.querySelector<HTMLElement>('[data-aw="spectrogramContainer"]');
    if (spec) {
      this.gestures = new SpectrogramGestures(spec, {
        player: () => this.h.player,
        onLabelTap: (id) => { const l = this.screen === 'review' && this.labelById(id); if (l) this.playLabel(l); },
        onLabelHold: (id) => { const l = this.screen === 'review' && this.labelById(id); if (l) this.loopLabel(l); },
        onEmptyTap: (time) => { if (this.screen !== 'review') return; this.stopLoop(); this.h.player?._state?._seekToTime?.(time, false); },
        onDoubleTap: () => this.togglePlay(),
      });
    }
    new MutationObserver(() => this.schedulePaint())
      .observe(host.playerRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-id'] });

    // A newly loaded recording starts with the phone time span.
    host.player?.on?.('ready', () => {
      this.needsFit = true;
      this.thumbActive();
      if (!this.active) return;
      setTimeout(() => this.fitTime(), 250);
      // Only when asked for (Settings): the phone is a viewer, analysing is a button in the player.
      this.gestures?.cancel();
      if (this.autoAnalyse && this.cfg.autoAnalyse) {
        const recId = this.activeRecId();
        setTimeout(() => {
          // Only the recording that became ready, still open, still in phone mode and still wanted.
          if (this.active && this.cfg.autoAnalyse && recId != null && this.activeRecId() === recId) this.analyseNow();
        }, 300);
      }
      this.autoAnalyse = false;
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
    if (this.screen === 'details') this.details?.render();
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
      if (REVIEW_WORKFLOW) this.show(this.openTotal() ? 'queue' : 'recordings');
      else this.show(this.h.getRecordings().some((r) => r.active) ? 'review' : 'recordings');
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
    // Frequency range fitted to where the calls are (most birds stay far below Nyquist).
    setTimeout(() => this.applyFreq(), 150);
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
    if (screen !== this.screen) this.gestures?.cancel();
    this.screen = screen;
    for (const [id, s] of this.screens) s.hidden = id !== screen;
    const navOn = screen === 'analyse' ? (this.anBackTo === 'review' ? this.rvFrom : this.anBackTo)
      : screen === 'review' && REVIEW_WORKFLOW ? this.rvFrom
      : screen === 'settings' ? this.setBackTo : screen === 'details' ? (this.detBackTo === 'review' && REVIEW_WORKFLOW ? this.rvFrom : this.detBackTo) : screen;
    for (const [id, b] of this.navBtns) b.classList.toggle('on', id === navOn);
    if (screen === 'analyse') this.renderAnalyse();
    if (screen === 'species') this.renderSpecies();
    if (screen === 'settings') this.renderSettings();
    if (screen === 'details') this.details?.render();
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
    bar.appendChild(el('h1', '', t('nav.recordings')));
    bar.appendChild(button('m-icon-btn', I.gear, t('set.title'), () => this.openSettings('recordings')));
    this.recList = el('div', 'm-scroll m-rec-list');
    s.append(bar);
    // Viewer first: open a Xeno-canto recording straight from here (number or link).
    if (this.h.addXenoCanto) {
      const form = el('form', 'm-xc');
      const ic = el('span', 'm-xc-ic');
      ic.innerHTML = I.globe;
      const input = el('input', 'm-xc-input');
      input.placeholder = t('new.xcPlaceholder');
      input.setAttribute('aria-label', t('new.xc'));
      input.inputMode = 'url';
      input.autocapitalize = 'off';
      input.enterKeyHint = 'go';
      const go = el('button', 'm-xc-go', t('new.load'));
      go.type = 'submit';
      form.append(ic, input, go);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const raw = input.value.trim();
        if (!raw) return;
        input.blur();
        this.autoAnalyse = !!this.h.analysis;
        this.toast(t('new.xcLoading'), null);
        let ok = false;
        try { ok = (await this.h.addXenoCanto!(raw)) !== false; } catch { ok = false; }
        if (!ok) {
          // Keep what was typed, say so, and stay here to try again.
          this.autoAnalyse = false;
          input.value = raw;
          this.toast(t('new.xcFailed'), null, { label: t('new.retry'), run: () => form.requestSubmit() });
          return;
        }
        if (!REVIEW_WORKFLOW) this.show('review');
      });
      s.append(form);
    }
    const fab = button('m-fab', `${I.plus}<span>${t('rec.new')}</span>`, t('rec.add'), () => this.toggleNewMenu());
    s.append(this.recList, this.buildNewMenu(), fab);
    this.screens.set('recordings', s);
    return s;
  }

  /** „New“: audio file, Xeno-canto or microphone (Live). */
  private buildNewMenu(): HTMLElement {
    const m = el('div', 'm-new');
    m.hidden = true;
    const scrim = el('div', 'm-new-scrim');
    scrim.addEventListener('click', () => this.toggleNewMenu(false));
    const sheet = el('div', 'm-new-sheet');
    sheet.appendChild(el('div', 'm-new-h', t('rec.add')));
    const item = (icon: string, title: string, hint: string, onClick: () => void) => {
      const b = button('m-new-item', `<span class="m-new-ic">${icon}</span><span class="m-new-tx"><b></b><small></small></span>`, title, onClick);
      b.querySelector('b')!.textContent = title;
      b.querySelector('small')!.textContent = hint;
      sheet.appendChild(b);
      return b;
    };
    item(I.file, t('new.file'), t('new.fileHint'), () => {
      this.toggleNewMenu(false);
      // The new file is analysed as soon as it is loaded (see the player 'ready' handler).
      this.autoAnalyse = !!this.h.analysis;
      this.h.addFile();
    });
    if (this.h.addXenoCanto) {
      const xcBtn = item(I.globe, t('new.xc'), t('new.xcHint'), () => {
        xcRow.hidden = !xcRow.hidden;
        if (!xcRow.hidden) this.xcInput.focus();
      });
      const xcRow = el('form', 'm-new-xc');
      xcRow.hidden = true;
      this.xcInput = el('input', 'm-input');
      this.xcInput.placeholder = t('new.xcPlaceholder');
      this.xcInput.setAttribute('aria-label', t('new.xc'));
      this.xcInput.inputMode = 'url';
      this.xcInput.autocapitalize = 'off';
      const go = el('button', 'm-cta m-cta--sm', t('new.load'));
      go.type = 'submit';
      xcRow.append(this.xcInput, go);
      xcRow.addEventListener('submit', async (e) => {
        e.preventDefault();
        const raw = this.xcInput.value.trim();
        if (!raw) return;
        this.toggleNewMenu(false);
        this.xcInput.value = '';
        this.autoAnalyse = !!this.h.analysis;
        this.toast(t('new.xcLoading'), null);
        try { await this.h.addXenoCanto!(raw); } catch { this.autoAnalyse = false; }
      });
      xcBtn.after(xcRow);
    }
    if (this.h.live) item(I.mic, t('new.mic'), t('new.micHint'), () => { this.toggleNewMenu(false); this.show('live'); });
    m.append(scrim, sheet);
    this.newMenu = m;
    return m;
  }

  private toggleNewMenu(open = this.newMenu.hidden) {
    this.newMenu.hidden = !open;
    if (!open) this.newMenu.querySelector<HTMLElement>('.m-new-xc')?.setAttribute('hidden', '');
  }

  private renderRecordings() {
    const recs = this.h.getRecordings();
    this.recList.replaceChildren();
    if (!recs.length) {
      this.recList.appendChild(el('p', 'm-empty', t('rec.empty')));
      return;
    }
    for (const r of recs) {
      const card = el('button', `m-rec${r.active ? ' active' : ''}`);
      card.type = 'button';
      const { adopted, detections, open } = reviewState(r.labels, this.isOwn);
      const species = new Set(r.labels.map((l) => l.scientificName).filter(Boolean)).size;

      // Mini spectrogram with a tick per detection (open = orange, confirmed = green).
      const thumb = el('div', 'm-rec-thumb');
      if (r.thumb) thumb.style.backgroundImage = `url("${r.thumb}")`;
      const dur = Number(r.duration) || 0;
      if (dur > 0) {
        const marks = el('div', 'm-rec-marks');
        for (const l of detections) {
          const i = el('i', adopted.has(String(l.id)) ? 'ok' : '');
          i.style.left = `${Math.min(100, (l.start / dur) * 100)}%`;
          i.style.width = `${Math.max(0.6, ((l.end - l.start) / dur) * 100)}%`;
          marks.appendChild(i);
        }
        thumb.appendChild(marks);
      }

      const body = el('div', 'm-rec-body');
      const main = el('div', 'm-rec-main');
      main.appendChild(el('div', 'm-rec-title', r.title));
      const when = fmtWhen(r);
      main.appendChild(el('div', 'm-rec-meta', [when || r.meta, dur ? fmtClock(dur, false) : '', species ? t('rec.species', { n: species }) : '']
        .filter(Boolean).join(' · ')));
      // Source (Xeno-canto) and place on a second line when there is something to say.
      const where = [when && r.meta === 'Xeno-canto' ? r.meta : '', r.place || ''].filter(Boolean).join(' · ');
      if (where) main.appendChild(el('div', 'm-rec-meta m-rec-place', where));
      const st = !REVIEW_WORKFLOW
        ? (species ? el('span', 'm-status done', t('rv.species', { n: species }))
          : r.labels.length ? el('span', 'm-status done', t('common.labels', { n: r.labels.length })) : el('span', 'm-status new', t('rec.notAnalysed')))
        : open.length
        ? el('span', 'm-status todo', t('rec.open', { n: open.length }))
        : detections.length ? el('span', 'm-status done', t('rec.reviewed'))
        : r.labels.length ? el('span', 'm-status done', t('common.labels', { n: r.labels.length })) : el('span', 'm-status new', t('rec.notAnalysed'));
      body.append(main, st);
      card.append(thumb, body);
      card.addEventListener('click', async () => {
        this.autoAnalyse = false;
        const fresh = !r.labels.length && !!this.h.analysis;
        if (!r.active) {
          // Not analysed yet: analyse right away once it is loaded.
          this.autoAnalyse = fresh;
          await this.h.openRecording(r.id);
        }
        this.rvFrom = 'recordings';
        this.show('review');
        if (fresh && r.active && this.cfg.autoAnalyse) this.analyseNow();
      });
      this.recList.appendChild(card);
    }
    this.thumbNext();
  }

  /** Render the thumbnail of the open recording from the player's decoded audio. */
  private thumbActive() {
    const rec = this.h.getRecordings().find((r) => r.active);
    const buf = this.h.player?._state?.audioBuffer;
    if (!rec || !buf || !this.h.setRecordingInfo) return;
    if (rec.thumb && rec.duration) return;
    setTimeout(() => {
      const thumb = rec.thumb || renderThumb(buf);
      this.h.setRecordingInfo!(rec.id, { thumb, duration: buf.duration });
    }, 50);
  }

  /** Background: render one missing thumbnail at a time (recordings that were never opened here). */
  private thumbNext() {
    if (this.thumbBusy || !this.active || !this.h.setRecordingInfo) return;
    const r = this.h.getRecordings().find((x) => !x.active && !x.thumb && x.audioUrl && !this.thumbFailed.has(x.id));
    if (!r) return;
    this.thumbBusy = true;
    thumbFromUrl(r.audioUrl!)
      .then((res) => {
        if (res?.thumb) this.h.setRecordingInfo!(r.id, { thumb: res.thumb, duration: res.duration });
        else this.thumbFailed.add(r.id);
      })
      .catch(() => this.thumbFailed.add(r.id))
      .finally(() => { this.thumbBusy = false; setTimeout(() => this.thumbNext(), 100); });
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
    bar.appendChild(el('h1', '', t('queue.title')));
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
      head.append(el('b', '', rec.title), el('span', 'm-status todo', t('rec.open', { n: open.length })));
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
        main.appendChild(el('div', 'm-det-name', this.h.resolveName(top)?.display || top.label || t('common.unknown')));
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
      ? t('queue.summary', { total, recs: shown, done })
      : '';
    if (!shown) {
      this.qList.appendChild(el('p', 'm-empty', recs.length
        ? (done ? t('queue.allDone') : t('queue.nothing'))
        : t('queue.noRecs')));
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
    img.src = lbl.scientificName ? speciesImageUrl(lbl.scientificName) : FALLBACK_IMG;
    img.addEventListener('error', () => { img.src = FALLBACK_IMG; }, { once: true });
    return img;
  }

  // ── Review ──────────────────────────────────────────────────────────

  private buildReview(): HTMLElement {
    const s = el('section', 'm-screen m-review');
    const bar = el('header', 'm-appbar');
    bar.appendChild(button('m-icon-btn', I.back, t('common.back'), () => this.show(this.rvFrom)));
    const titleBox = el('div', 'm-appbar-title');
    this.rvTitle = el('h2', '', '');
    this.rvSub = el('small', '', '');
    titleBox.append(this.rvTitle, this.rvSub);
    bar.appendChild(titleBox);
    if (this.h.getDetails) bar.appendChild(button('m-icon-btn', I.info, t('det.open'), () => this.openDetails('review')));
    if (this.h.analysis) bar.appendChild(button('m-icon-btn', I.analyse, t('rv.analyse'), () => this.openAnalyse('review')));
    if (!REVIEW_WORKFLOW) bar.appendChild(button('m-icon-btn', I.gear, t('set.title'), () => this.openSettings('review')));

    this.playerSlot = el('div', 'm-player');
    this.playerSlot.id = 'm-player-slot';
    this.rvProgress = el('div', 'm-rv-progress');
    this.rvProgress.hidden = true;

    const time = el('div', 'm-time');
    this.timeCur = el('span', '', '00:00.0');
    this.timeDur = el('span', '', '00:00.0');
    time.append(this.timeCur, this.timeDur);

    const tr = el('div', 'm-transport');
    this.rateBtn = button('m-tbtn m-tbtn--txt m-rate', '1×', t('rv.rate'), () => this.cycleRate());
    this.playBtn = button('m-play', I.play, t('rv.play'), () => this.togglePlay());
    this.loopBtn = REVIEW_WORKFLOW
      ? button('m-tbtn m-tbtn--txt', t('rv.loop'), t('rv.loopLabel'), () => this.toggleLoop())
      : button('m-tbtn', I.loop, t('rv.loopLabel'), () => this.toggleLoop());
    tr.append(
      this.rateBtn,
      button('m-tbtn m-skip', `${I.rw}<b>${SKIP_SEC}</b>`, t('rv.skipBack', { s: SKIP_SEC }), () => this.skip(-SKIP_SEC)),
      this.playBtn,
      button('m-tbtn m-skip', `${I.fw}<b>${SKIP_SEC}</b>`, t('rv.skipFwd', { s: SKIP_SEC }), () => this.skip(SKIP_SEC)),
      this.loopBtn,
    );

    if (!REVIEW_WORKFLOW) {
      // Viewer: spectrogram as large as possible, one slim transport bar, species strip at the bottom.
      // Time on a slim line, then the transport with a large play button in the middle.
      const tbar = el('div', 'm-tbar');
      const tm = el('div', 'm-tbar-time');
      tm.append(this.timeCur, this.timeDur);
      tbar.append(tm, tr);
      this.strip = el('div', 'm-strip');
      this.strip.setAttribute('role', 'list');
      const zoom = el('div', 'm-zoom');
      zoom.append(
        button('m-zoom-btn', I.zoomOut, t('rv.zoomOut'), () => this.zoomBy(1 / 1.8)),
        button('m-zoom-btn', I.zoomIn, t('rv.zoomIn'), () => this.zoomBy(1.8)),
        button('m-zoom-btn', I.fit, t('rv.zoomFit'), () => { try { this.h.player?._state?._fitEntireTrackInView?.(); this.applyFreq(); } catch { /* ignore */ } }),
      );
      this.tuneBtn = button('m-zoom-btn m-tune-btn', I.tune, t('set.view'), () => this.toggleTune());
      const tuneBox = el('div', 'm-zoom m-zoom--top');
      tuneBox.appendChild(this.tuneBtn);
      this.tune = el('div', 'm-tune');
      this.tune.hidden = true;
      const th = el('div', 'm-tune-h');
      th.append(el('b', '', t('set.view')), button('m-icon-btn', I.x, t('common.close'), () => this.toggleTune(false)));
      this.tune.append(th, el('div', 'm-tune-body'));
      const stage = el('div', 'm-stage');
      stage.append(this.playerSlot, zoom, tuneBox, this.tune);
      // „Now playing“ deck: overview as the progress bar, times, transport, species.
      const deck = el('div', 'm-deck');
      deck.append(this.buildOverview(), tbar, this.strip);
      s.classList.add('m-review--viewer');
      s.append(bar, this.rvProgress, stage, deck);
      this.screens.set('review', s);
      return s;
    }

    const sheet = el('div', 'm-sheet');
    sheet.appendChild(el('div', 'm-grip'));
    this.detHead = el('div', 'm-sheet-h', '');
    for (const [id, label] of [['open', t('rv.open')], ['all', t('common.all')]] as const) {
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
    this.rvTitle.textContent = rec?.title || t('common.noRecording');
    const labels = [...this.h.getLabels()].sort((a, b) => (a.start - b.start) || (a.end - b.end));
    const { adopted, detections, open } = reviewState(labels, this.isOwn);
    this.assignColors(labels);
    if (!REVIEW_WORKFLOW) {
      this.rvSub.textContent = rec ? [rec.meta, rec.place].filter(Boolean).join(' · ') : '';
      this.renderStrip(labels, !!rec);
      this.schedulePaint();
      return;
    }
    this.rvSub.textContent = rec
      ? (detections.length ? t('rv.sub', { det: detections.length, open: open.length }) : t('common.labels', { n: labels.length }))
      : '';

    // Copies in „Meine Labels“ are shown on their detection (✓), not as a second card.
    const items = labels.filter((l) => !(this.isOwn(l) && l.adoptedFrom?.id != null));
    const openIds = new Set(open.map((l) => String(l.id)));
    if (this.rvFilter === 'open' && !open.length) this.rvFilter = 'all';
    const shown = this.rvFilter === 'open' ? items.filter((l) => openIds.has(String(l.id))) : items;

    const head = el('div', 'm-sheet-row');
    head.appendChild(el('b', '', t('rv.detections')));
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
      head.firstElementChild!.textContent = `${t('rv.detections')} · ${labels.length}`;
    }
    this.detHead.replaceChildren(head);
    this.detList.replaceChildren();
    if (!rec) {
      this.detList.appendChild(el('p', 'm-empty', t('rv.pickRecording')));
      return;
    }
    if (!labels.length) {
      this.detList.appendChild(el('p', 'm-empty', this.h.analysis
        ? t('rv.noDetectionsAnalyse') : t('rv.noDetections')));
      return;
    }
    if (!shown.length) {
      this.detList.appendChild(el('p', 'm-empty', t('rv.allDone')));
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
    main.appendChild(el('div', 'm-det-name', display || lbl.label || t('common.unknown')));
    // Time windows (BirdNET) as a range; calls and boxes as start with tenths + length.
    const when = lbl.fullBand
      ? `${fmtClock(lbl.start, false)}–${fmtClock(lbl.end, false)}`
      : `${fmtClock(lbl.start)} · ${Math.max(0, lbl.end - lbl.start).toFixed(1)} s`;
    main.appendChild(el('div', 'm-det-meta', `${when} · ${confirmed ? t('rv.confirmed') : sourceName(lbl)}`));
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
          button('m-act no', I.x, t('rv.discard'), () => this.discard(lbl)),
          button('m-act yes', I.ok, t('rv.accept'), () => this.accept(lbl)),
        );
      } else {
        acts.appendChild(button('m-act yes on', I.ok, t('rv.unaccept'), () => this.unaccept(lbl)));
      }
      for (const b of acts.children) b.addEventListener('click', (e) => e.stopPropagation());
      card.appendChild(acts);
    }
    if (open && this.h.acceptLabel) this.swipeable(card, () => this.accept(lbl), () => this.discard(lbl));
    card.addEventListener('click', () => { if (performance.now() - this.swipedAt > 350) this.playLabel(lbl); });
    card.addEventListener('keydown', (e) => {
      if (e.target !== card) return;   // ✓/✕ keep their own keyboard activation
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.playLabel(lbl); }
    });
    return card;
  }

  // ── Viewer: species colours and strip ──────────────────────────────

  /** One colour per species, in order of first appearance in the recording. */
  private belowMin = new Set<string>();

  private shown(l: any) {
    return l.confidence == null || Number(l.confidence) >= this.cfg.minConf;
  }

  private assignColors(labels: any[]) {
    this.colorOf.clear();
    this.keyOfId.clear();
    this.belowMin.clear();
    this.labelRev++;
    for (const l of labels) {
      if (!this.shown(l)) { this.belowMin.add(String(l.id)); continue; }
      const k = speciesKey(l);
      if (!this.colorOf.has(k)) this.colorOf.set(k, PALETTE[this.colorOf.size % PALETTE.length]);
      this.keyOfId.set(String(l.id), k);
    }
    if (this.focusKey && !this.colorOf.has(this.focusKey)) this.focusKey = null;
  }

  private labelById(id: string) { return this.h.getLabels().find((l) => String(l.id) === id) || null; }

  /** Labels under time `t`, best first. */
  private labelsAt(time: number) {
    return this.h.getLabels()
      .filter((l) => time >= l.start && time <= l.end && this.shown(l) && !(this.isOwn(l) && l.adoptedFrom?.id != null))
      .sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0));
  }

  private schedulePaint() {
    if (this.paintRaf || !this.active) return;
    this.paintRaf = requestAnimationFrame(() => { this.paintRaf = 0; this.paint(); });
  }

  /** Species colour on every label region; with a species picked, the others fade. */
  private paint() {
    const root = this.h.playerRoot;
    root.classList.toggle('m-has-focus', !!this.focusKey);
    for (const r of root.querySelectorAll<HTMLElement>('.spectrogram-label-region')) {
      r.classList.toggle('m-hide', this.belowMin.has(r.dataset.id || ''));
      const k = this.keyOfId.get(r.dataset.id || '');
      const c = k ? this.colorOf.get(k) : undefined;
      if (c) { if (r.style.getPropertyValue('--m-c') !== c) r.style.setProperty('--m-c', c); }
      else r.style.removeProperty('--m-c');
      r.classList.toggle('m-dim', !!this.focusKey && k !== this.focusKey);
    }
  }

  private renderStrip(labels: any[], hasRec: boolean) {
    const groups = new Map<string, { key: string; list: any[]; best: any }>();
    for (const l of labels) {
      if (this.isOwn(l) && l.adoptedFrom?.id != null) continue;
      if (!this.shown(l)) continue;
      const k = speciesKey(l);
      const g = groups.get(k) || { key: k, list: [], best: l };
      g.list.push(l);
      if ((Number(l.confidence) || 0) > (Number(g.best.confidence) || 0)) g.best = l;
      groups.set(k, g);
    }
    this.strip.replaceChildren();
    this.stripCur = '';
    if (!groups.size) {
      const busy = !this.rvProgress.hidden || this.anJob !== 'idle';
      if (hasRec && !busy && this.h.analysis) {
        const row = el('div', 'm-strip-empty m-strip-cta');
        row.append(el('span', '', t('rv.noSpecies')),
          button('m-cta m-cta--sm', `${I.analyse}<span>${t('rv.analyseNow')}</span>`, t('rv.analyseNow'), () => this.analyseBirdNET()));
        this.strip.appendChild(row);
        return;
      }
      this.strip.appendChild(el('p', 'm-strip-empty', !hasRec ? t('rv.pickRecording')
        : busy ? t('rv.analysing') : t('rv.noSpecies')));
      return;
    }
    for (const g of groups.values()) {
      const name = this.h.resolveName(g.best)?.display || g.best.label || t('common.unknown');
      const chip = el('button', `m-spc${this.focusKey === g.key ? ' on' : ''}${this.focusKey && this.focusKey !== g.key ? ' off' : ''}`);
      chip.type = 'button';
      chip.dataset.key = g.key;
      chip.style.setProperty('--m-c', this.colorOf.get(g.key) || PALETTE[0]);
      const tx = el('span', 'm-spc-tx');
      tx.append(el('b', '', name));
      const pct = g.best.confidence != null ? `${Math.round(Number(g.best.confidence) * 100)}%` : '';
      tx.append(el('small', '', [`${g.list.length}×`, pct].filter(Boolean).join(' · ')));
      chip.append(this.speciesImg(g.best), tx);
      chip.setAttribute('aria-pressed', String(this.focusKey === g.key));
      chip.addEventListener('click', () => {
        if (this.focusKey === g.key) {
          this.focusKey = null;
        } else {
          this.focusKey = g.key;
          this.playLabel(g.best);
        }
        this.renderReview();
        // The strip was rebuilt: keep focus on this species, so it can be pressed again to clear.
        this.strip.querySelector<HTMLElement>(`.m-spc[data-key="${CSS.escape(g.key)}"]`)?.focus();
      });
      // The list item is a wrapper, so the chip keeps its button role.
      const item = el('div', 'm-spc-item');
      item.setAttribute('role', 'listitem');
      item.appendChild(chip);
      this.strip.appendChild(item);
    }
  }

  /** Highlight the chips of the species under the playhead. */
  private markStrip() {
    if (!this.strip) return;
    const keys = [...new Set(this.labelsAt(Number(this.h.player?.currentTime) || 0).map(speciesKey))];
    const sig = keys.join('|');
    if (sig === this.stripCur) return;
    this.stripCur = sig;
    let first: HTMLElement | null = null;
    for (const c of this.strip.querySelectorAll<HTMLElement>('.m-spc')) {
      const on = keys.includes(c.dataset.key || '');
      c.classList.toggle('cur', on);
      if (on && !first) first = c;
    }
    first?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }

  private loopLabel(lbl: any) {
    this.loopSeg = { start: lbl.start, end: lbl.end };
    this.loopBtn.classList.add('on');
    this.playLabel(lbl);
  }

  private stopLoop() {
    if (!this.loopSeg) return;
    this.loopSeg = null;
    this.loopBtn.classList.remove('on');
    // Keep playing, just without the loop.
    const p = this.h.player;
    const was = !!p?.isPlaying;
    p?._state?._stopCustomSegmentPlayback?.('stopped', Number(p.currentTime) || 0);
    if (was) p.play?.();
  }

  // ── Viewer: zoom and overview ───────────────────────────────────────

  private zoomBy(scale: number) {
    const st = this.h.player?._state;
    const w = st?.d?.canvasWrapper as HTMLElement | undefined;
    if (!st || !w) return;
    const r = w.getBoundingClientRect();
    // Zoom around the playhead when it is in view, else around the middle.
    const pps = Number(st.pixelsPerSecond) || 1;
    const px = (Number(this.h.player.currentTime) || 0) * pps - w.scrollLeft;
    const x = px >= 0 && px <= r.width ? r.left + px : r.left + r.width / 2;
    st._zoomByScale(scale, x);
  }

  /** Frequency range from the settings: fitted to the calls, a fixed top, or everything. */
  private applyFreq() {
    const st = this.h.player?._state;
    if (!st) return;
    try {
      const f = this.cfg.freq;
      if (f === 'full') { st._freqZoom?.reset(); return; }
      if (typeof f === 'number') { st._freqZoom?.set(0, f); return; }
      // Auto: fit to the activity; if that still reaches far up (noise, high sample rates), 0–12 kHz.
      st.applyAutoFreqView?.();
      const top = Number(st._freqZoom?.max) || Number(st.coords?.boundedMaxFreq) || 0;
      if (top > PHONE_MAX_HZ * 1.4) st._freqZoom?.set(0, PHONE_MAX_HZ);
    } catch { /* ignore */ }
  }

  /**
   * Overview of the whole recording: mini spectrogram, detections in their colours, the visible
   * part as a frame. Tap or drag anywhere moves the view there (no small handles to hit).
   */
  private buildOverview(): HTMLElement {
    const ov = el('div', 'm-ov');
    ov.setAttribute('role', 'scrollbar');
    ov.setAttribute('aria-label', t('rv.overview'));
    ov.setAttribute('aria-orientation', 'horizontal');
    ov.setAttribute('aria-controls', 'm-player-slot');
    ov.setAttribute('aria-valuemin', '0');
    ov.setAttribute('aria-valuemax', '100');
    ov.setAttribute('aria-valuenow', '0');
    ov.tabIndex = 0;
    // Keyboard: arrows move by half a view, Page keys by a whole one, Home / End to the ends.
    ov.addEventListener('keydown', (e) => {
      const v = this.visibleRange();
      const dur = Number(this.h.player?.duration) || 0;
      if (!v || !dur) return;
      const span = v.end - v.start;
      const centre = (v.start + v.end) / 2;
      const to = e.key === 'ArrowLeft' ? centre - span / 2 : e.key === 'ArrowRight' ? centre + span / 2
        : e.key === 'PageUp' ? centre - span : e.key === 'PageDown' ? centre + span
        : e.key === 'Home' ? 0 : e.key === 'End' ? dur : null;
      if (to == null) return;
      e.preventDefault();
      try { this.h.player?._state?._centerViewportAtTime?.(to); } catch { /* ignore */ }
    });
    this.ovMarks = el('div', 'm-ov-marks');
    this.ovWin = el('div', 'm-ov-win');
    this.ovHead = el('div', 'm-ov-head');
    ov.append(this.ovMarks, this.ovWin, this.ovHead);
    let grab = 0;   // where in the frame the finger holds it (seconds from its centre)
    const timeAt = (x: number) => {
      const r = ov.getBoundingClientRect();
      return Math.max(0, Math.min(1, (x - r.left) / r.width)) * (Number(this.h.player?.duration) || 0);
    };
    const move = (x: number) => {
      try { this.h.player?._state?._centerViewportAtTime?.(timeAt(x) - grab); } catch { /* ignore */ }
    };
    ov.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      ov.setPointerCapture(e.pointerId);
      const v = this.visibleRange();
      const t0 = timeAt(e.clientX);
      // Inside the frame: drag it from where it was grabbed; outside: jump there.
      grab = v && t0 >= v.start && t0 <= v.end ? t0 - (v.start + v.end) / 2 : 0;
      ov.classList.add('drag');
      move(e.clientX);
    });
    ov.addEventListener('pointermove', (e) => { if (ov.hasPointerCapture(e.pointerId)) move(e.clientX); });
    const end = () => ov.classList.remove('drag');
    ov.addEventListener('pointerup', end);
    ov.addEventListener('pointercancel', end);
    this.ov = ov;
    return ov;
  }

  private visibleRange() {
    const st = this.h.player?._state;
    const pps = Number(st?.pixelsPerSecond) || 0;
    if (!pps) return null;
    const start = (Number(st._getPrimaryScrollLeft?.()) || 0) / pps;
    return { start, end: start + (Number(st._getViewportWidth?.()) || 0) / pps };
  }

  private updateOverview() {
    if (!this.ov || this.screen !== 'review') return;
    const dur = Number(this.h.player?.duration) || 0;
    const rec = this.h.getRecordings().find((r) => r.active);
    const v = this.visibleRange();
    if (!dur || !v) return;
    const pct = (x: number) => `${Math.max(0, Math.min(100, (x / dur) * 100))}%`;
    this.ovWin.style.left = pct(v.start);
    this.ovWin.style.width = `calc(${pct(Math.min(dur, v.end) - v.start)} - 0px)`;
    this.ovHead.style.left = pct(Number(this.h.player.currentTime) || 0);
    const now = String(Math.round((v.start / Math.max(1e-6, dur - (v.end - v.start))) * 100) || 0);
    if (this.ov.getAttribute('aria-valuenow') !== now) this.ov.setAttribute('aria-valuenow', now);
    // Thumbnail + marks only when the recording or its labels changed.
    const sig = `${rec?.id}|${rec?.thumb ? 1 : 0}|${this.labelRev}`;
    if (sig === this.ovSig) return;
    this.ovSig = sig;
    this.ov.style.backgroundImage = rec?.thumb ? `url("${rec.thumb}")` : '';
    this.ovMarks.replaceChildren();
    for (const l of this.h.getLabels()) {
      const k = this.keyOfId.get(String(l.id));
      if (!k) continue;
      const i = el('i');
      i.style.left = pct(l.start);
      i.style.width = `max(2px, ${pct(l.end - l.start)})`;
      i.style.background = this.colorOf.get(k) || '';
      this.ovMarks.appendChild(i);
    }
  }

  // ── Settings ───────────────────────────────────────────────────────

  openSettings(from: Screen) {
    this.setBackTo = from;
    this.show('settings');
  }

  private buildSettings(): HTMLElement {
    const s = el('section', 'm-screen m-settings');
    const bar = el('header', 'm-appbar');
    bar.appendChild(button('m-icon-btn', I.back, t('common.back'), () => this.show(this.setBackTo)));
    bar.appendChild(el('h1', '', t('set.title')));
    this.setBody = el('div', 'm-scroll m-set-body');
    s.append(bar, this.setBody);
    this.screens.set('settings', s);
    return s;
  }

  // ── Details (properties of the active recording) ──────────────────

  openDetails(from: Screen) {
    this.detBackTo = from;
    this.show('details');
  }

  private buildDetails(): HTMLElement {
    const s = el('section', 'm-screen m-details');
    const bar = el('header', 'm-appbar');
    bar.appendChild(button('m-icon-btn', I.back, t('common.back'), () => this.show(this.detBackTo)));
    bar.appendChild(el('h1', '', t('det.title')));
    s.appendChild(bar);
    if (this.h.getDetails) {
      const host = this.h;
      this.details = new MobileDetailsView({
        getDetails: () => host.getDetails!(),
        setContext: host.setContext ? (f, v) => { host.setContext!(f, v); this.details?.render(); } : undefined,
      });
      s.appendChild(this.details.body);
    }
    this.screens.set('details', s);
    return s;
  }

  private saveCfg() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.cfg)); } catch { /* ignore */ }
  }

  /** The player's own control (settings panel); changing it there keeps one implementation + storage. */
  private ctl<T extends HTMLElement>(aw: string) {
    // The settings panel may have been moved out of the player root (desktop drawer): use the player's refs.
    return (this.h.player?._state?.d?.[aw] as T | null) ?? document.querySelector<T>(`[data-aw="${aw}"]`);
  }

  private renderSettings() {
    const b = this.setBody;
    b.replaceChildren();
    const group = (title: string) => {
      const g = el('div', 'm-set-group');
      g.appendChild(el('h3', '', title));
      b.appendChild(g);
      return g;
    };
    const seg = <V extends string | number>(g: HTMLElement, label: string, opts: [V, string][], cur: V, pick: (v: V) => void) =>
      this.segRow(g, label, opts, cur, (v) => { pick(v); this.renderSettings(); });

    const view = group(t('set.view'));
    this.specControls(view, () => this.renderSettings());
    seg(view, t('set.freq'), [['auto', t('set.auto')], [8000, '8 kHz'], [12000, '12 kHz'], [16000, '16 kHz'], ['full', t('set.full')]],
      this.cfg.freq, (v) => { this.cfg.freq = v; this.saveCfg(); this.applyFreq(); });

    const det = group(t('set.detections'));
    this.switchRow(det, t('set.autoAnalyse'), t('set.autoAnalyseHint'), this.cfg.autoAnalyse, (v) => { this.cfg.autoAnalyse = v; this.saveCfg(); });
    seg(det, t('set.minConf'), [[0, t('common.all')], [0.25, '25%'], [0.5, '50%'], [0.75, '75%']],
      this.cfg.minConf, (v) => { this.cfg.minConf = v; this.saveCfg(); this.renderReview(); });

    const gen = group(t('set.general'));
    seg(gen, t('set.lang'), [['en', 'English'], ['de', 'Deutsch']], getLang(), (v) => {
      if (v === getLang()) return;
      setLang(v);
      // Strings are built once, so the new language needs a reload. Not automatic: a local file
      // only lives as a blob URL of this page and would have to be picked again.
      this.toast(t('set.langReload'), null, { label: t('set.reload'), run: () => {
        const u = new URL(location.href);
        u.searchParams.delete('lang');
        location.replace(u.toString());
      } });
    });

    if (this.h.xcKey) {
      const xk = this.h.xcKey;
      const xc = group('Xeno-canto');
      const row = el('form', 'm-set-row m-set-col m-xckey');
      row.appendChild(el('span', 'm-set-label', t('set.xcKey')));
      const line = el('div', 'm-xckey-line');
      const inp = el('input', 'm-xckey-input');
      inp.type = 'password';
      inp.autocomplete = 'off';
      inp.spellcheck = false;
      inp.value = xk.get();
      inp.placeholder = t('set.xcKeyPh');
      inp.setAttribute('aria-label', t('set.xcKey'));
      const eye = button('m-set-btn m-xckey-eye', '', t('set.xcKeyShow'), () => {
        inp.type = inp.type === 'password' ? 'text' : 'password';
      });
      eye.textContent = '👁';
      const save = el('button', 'm-set-btn', t('set.xcKeySave'));
      save.type = 'submit';
      line.append(inp, eye, save);
      row.append(line, el('small', 'm-hint', t(xk.get() ? 'set.xcKeySet' : 'set.xcKeyHint')));
      row.addEventListener('submit', async (e) => {
        e.preventDefault();
        save.disabled = true;
        try { await xk.set(inp.value.trim()); this.toast(t(inp.value.trim() ? 'set.xcKeySaved' : 'set.xcKeyCleared'), null); }
        finally { save.disabled = false; this.renderSettings(); }
      });
      xc.appendChild(row);
      const a = el('a', 'm-hint m-xckey-link', t('set.xcKeyWhere'));
      a.href = 'https://xeno-canto.org/account';
      a.target = '_blank';
      a.rel = 'noopener';
      xc.appendChild(a);
    }

    const help = group(t('set.gestures'));
    const ul = el('ul', 'm-set-help');
    for (const k of ['set.g.pinch', 'set.g.drag', 'set.g.tap', 'set.g.double', 'set.g.hold', 'set.g.overview'] as const) ul.appendChild(el('li', '', t(k)));
    help.appendChild(ul);
  }

  // ── Spectrogram controls (settings screen + quick panel on the player) ──

  private static poke(elm: HTMLElement, type: 'change' | 'input' | 'click') {
    if (type === 'click') (elm as HTMLButtonElement).click();
    else elm.dispatchEvent(new Event(type, { bubbles: true }));
  }

  private segRow<V extends string | number>(g: HTMLElement, label: string, opts: [V, string][], cur: V, pick: (v: V) => void) {
    const row = el('div', 'm-set-row');
    row.appendChild(el('span', 'm-set-label', label));
    const box = el('div', 'm-seg');
    box.setAttribute('role', 'radiogroup');
    box.setAttribute('aria-label', label);
    // Picking re-renders the panel: put focus back on the chosen option afterwards.
    const choose = (v: V) => {
      pick(v);
      document.querySelector<HTMLElement>(`[data-fkey="${CSS.escape(`${label}:${v}`)}"]`)?.focus();
    };
    for (const [v, text] of opts) {
      const o = button(`m-seg-btn${v === cur ? ' on' : ''}`, '', text, () => choose(v));
      o.textContent = text;
      o.setAttribute('role', 'radio');
      o.setAttribute('aria-checked', String(v === cur));
      o.tabIndex = v === cur ? 0 : -1;   // one tab stop per group, arrows move within it
      o.dataset.fkey = `${label}:${v}`;
      box.appendChild(o);
    }
    if (!opts.some(([v]) => v === cur) && box.firstElementChild) (box.firstElementChild as HTMLElement).tabIndex = 0;
    box.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const i = Math.max(0, opts.findIndex(([v]) => v === cur));
      choose(opts[(i + step + opts.length) % opts.length][0]);
    });
    row.appendChild(box);
    g.appendChild(row);
  }

  private switchRow(g: HTMLElement, label: string, hint: string, on: boolean, set: (v: boolean) => void) {
    const row = el('label', 'm-set-row m-set-toggle');
    const tx = el('span', 'm-set-tx');
    tx.append(el('span', 'm-set-label', label), el('small', '', hint));
    const sw = el('span', 'm-switch');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = on;
    input.addEventListener('change', () => set(input.checked));
    sw.append(input, el('i'));
    row.append(tx, sw);
    g.appendChild(row);
  }

  /** A slider bound to one of the player's range inputs (live while dragging). */
  private sliderRow(g: HTMLElement, label: string, src: HTMLInputElement, ends: [string, string] | null, readout: () => string, onMove?: () => void) {
    const row = el('div', 'm-set-row m-set-col');
    const head = el('div', 'm-set-head');
    const val = el('span', 'm-set-val', readout());
    head.append(el('span', 'm-set-label', label), val);
    const r = el('input', 'm-slider');
    r.type = 'range';
    r.min = src.min; r.max = src.max; r.step = src.step || '1';
    r.value = src.value;
    r.setAttribute('aria-label', label);
    r.addEventListener('input', () => {
      onMove?.();
      src.value = r.value;
      MobileApp.poke(src, 'input');
      val.textContent = readout();
    });
    row.append(head);
    if (ends) {
      const line = el('div', 'm-slider-line');
      line.append(el('small', '', ends[0]), r, el('small', '', ends[1]));
      row.append(line);
    } else row.append(r);
    g.appendChild(row);
  }

  /** Colours, contrast, frequency scale, resolution, noise — the player's own controls. */
  private specControls(g: HTMLElement, rerender: () => void) {
    const d = this.h.player?._state?.d || {};
    const scheme = this.ctl<HTMLSelectElement>('colorSchemeSelect');
    if (scheme) {
      const nice: Record<string, string> = { grayscale: t('set.bw'), grayscaleInv: t('set.wb'), spectroflare: 'SpectroFlare' };
      const row = el('div', 'm-set-row m-set-col');
      row.appendChild(el('span', 'm-set-label', t('set.colors')));
      const box = el('div', 'm-swatches');
      for (const o of scheme.options) {
        const v = o.value;
        const text = nice[v] || o.textContent?.replace(/\s*\(.*\)\s*$/, '').trim() || v;
        const b = button(`m-swatch m-swatch--${v}${scheme.value === v ? ' on' : ''}`, '<i></i><span></span>', text, () => {
          scheme.value = v;
          MobileApp.poke(scheme, 'change');
          rerender();
        });
        b.querySelector('span')!.textContent = text;
        b.querySelector('i')!.style.background = `linear-gradient(90deg, ${[0, 0.2, 0.4, 0.6, 0.8, 1]
          .map((x) => { const c = getSpectrogramColor(x, v); return `rgb(${c.r},${c.g},${c.b})`; }).join(', ')})`;
        b.setAttribute('aria-pressed', String(scheme.value === v));
        box.appendChild(b);
      }
      row.appendChild(box);
      g.appendChild(row);
    }

    const mode = d.gainModeSelect as HTMLSelectElement | undefined;
    const floor = d.floorSlider as HTMLInputElement | undefined;
    const ceil = d.ceilSlider as HTMLInputElement | undefined;
    if (mode) {
      this.segRow(g, t('set.contrastMode'), [['auto', t('set.auto')], ['fixed', t('set.manual')]], mode.value, (v) => {
        mode.value = v;
        MobileApp.poke(mode, 'change');
        rerender();
      });
    }
    // Moving a slider means „manual“: switch the mode so the values stick.
    const manual = () => { if (mode && mode.value !== 'fixed') { mode.value = 'fixed'; MobileApp.poke(mode, 'change'); } };
    const txt = (e: unknown) => ((e as HTMLElement | undefined)?.textContent || '').trim();
    if (floor) this.sliderRow(g, t('set.floor'), floor, null, () => txt(d.floorValue) || `${floor.value}`, manual);
    if (ceil) this.sliderRow(g, t('set.ceil'), ceil, null, () => txt(d.ceilValue) || `${ceil.value}`, manual);
    if (d.autoContrastBtn) {
      const row = el('div', 'm-set-row');
      row.appendChild(button('m-set-btn', '', t('set.autoContrast'), () => { MobileApp.poke(d.autoContrastBtn, 'click'); rerender(); }));
      (row.firstChild as HTMLElement).textContent = t('set.autoContrast');
      g.appendChild(row);
    }

    const scale = d.scaleSelect as HTMLSelectElement | undefined;
    if (scale) {
      const opts = [...scale.options].map((o) => [o.value, o.value === 'mel' ? 'Mel' : o.value === 'linear' ? t('set.linear') : t('set.log')] as [string, string]);
      this.segRow(g, t('set.scale'), opts, scale.value, (v) => { scale.value = v; MobileApp.poke(scale, 'change'); rerender(); });
    }
    const q = d.qualitySlider as HTMLInputElement | undefined;
    if (q) this.sliderRow(g, t('set.resolution'), q, [t('set.resTime'), t('set.resFreq')], () => txt(d.qualityLevelDisplay));

    const nr = d.noiseReductionCheck as HTMLInputElement | undefined;
    if (nr) this.switchRow(g, t('set.noise'), t('set.noiseHint'), nr.checked, (v) => { nr.checked = v; MobileApp.poke(nr, 'change'); });
    const clahe = d.claheCheck as HTMLInputElement | undefined;
    if (clahe) this.switchRow(g, t('set.contrast'), t('set.contrastHint'), clahe.checked, (v) => { clahe.checked = v; MobileApp.poke(clahe, 'change'); });
  }

  /** Quick panel over the player: change the picture and see it right away. */
  private toggleTune(open: boolean = this.tune.hidden === true) {
    this.tune.hidden = !open;
    this.tuneBtn.classList.toggle('on', open);
    if (open) this.renderTune();
  }

  private renderTune() {
    const body = this.tune.querySelector<HTMLElement>('.m-tune-body')!;
    body.replaceChildren();
    const g = el('div', 'm-set-group');
    this.specControls(g, () => this.renderTune());
    body.appendChild(g);
  }

  // ── Accept / discard ────────────────────────────────────────────────

  /** Swipe right = accept, left = discard (horizontal drags only; vertical scrolling stays). */
  private swipeable(card: HTMLElement, onRight: () => void, onLeft: () => void) {
    let x0 = 0, y0 = 0, dx = 0, id = -1, mode: 'idle' | 'maybe' | 'drag' = 'idle';
    const reset = () => {
      card.style.transform = '';
      card.classList.remove('sw-yes', 'sw-no', 'sw-drag');
      mode = 'idle';
    };
    card.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || (e.target as HTMLElement).closest('.m-det-acts')) return;
      x0 = e.clientX; y0 = e.clientY; dx = 0; id = e.pointerId; mode = 'maybe';
    });
    card.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id || mode === 'idle') return;
      const mx = e.clientX - x0, my = e.clientY - y0;
      if (mode === 'maybe') {
        if (Math.abs(my) > 10 && Math.abs(my) > Math.abs(mx)) { mode = 'idle'; return; }   // scrolling
        if (Math.abs(mx) < 12) return;
        mode = 'drag';
        card.setPointerCapture(id);
        card.classList.add('sw-drag');
      }
      dx = mx;
      card.style.transform = `translateX(${dx}px)`;
      const far = Math.abs(dx) > card.offsetWidth * 0.3;
      card.classList.toggle('sw-yes', far && dx > 0);
      card.classList.toggle('sw-no', far && dx < 0);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      const was = mode;
      const far = Math.abs(dx) > card.offsetWidth * 0.3;
      reset();
      if (was !== 'drag') return;
      // The click after a drag must not play the label.
      this.swipedAt = performance.now();
      if (far) (dx > 0 ? onRight : onLeft)();
    };
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', (e) => { if (e.pointerId === id) reset(); });
  }

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
    this.toast(t('rv.accepted', { name: this.h.resolveName(lbl)?.display || lbl.label }), () => this.unaccept(lbl, true));
    this.afterDecision(next);
  }

  private unaccept(lbl: any, quiet = false) {
    const copy = this.h.getLabels().find((l) => this.isOwn(l) && String(l.adoptedFrom?.id) === String(lbl.id));
    if (!copy || !this.h.discardLabel) return;
    this.h.discardLabel(String(copy.id));
    if (!quiet) this.toast(t('rv.unaccepted'), () => this.h.restoreLabel?.(copy));
    this.renderReview();
    this.renderRecordings();
  }

  private discard(lbl: any) {
    if (!this.h.discardLabel) return;
    const next = this.nextOpen(lbl);
    const removed = this.h.discardLabel(String(lbl.id));
    this.toast(t('rv.discarded', { name: this.h.resolveName(lbl)?.display || lbl.label }), removed && this.h.restoreLabel
      ? () => { this.h.restoreLabel!(removed); this.renderReview(); this.renderRecordings(); }
      : null);
    this.afterDecision(next);
  }

  private activeRecId() { return this.h.getRecordings().find((r) => r.active)?.id ?? null; }

  /** Short message above the nav, with an optional undo; the undo only applies to the recording it was made in. */
  private toast(msg: string, undo: (() => void) | null, action?: { label: string; run: () => void }) {
    if (undo) {
      const recId = this.activeRecId();
      const inner = undo;
      undo = () => { if (this.activeRecId() === recId) inner(); };
    }
    clearTimeout(this.snackTimer);
    this.snack.replaceChildren(el('span', '', msg));
    if (undo) {
      this.snack.appendChild(button('m-snack-btn', t('common.undo'), t('common.undo'), () => {
        this.snack.hidden = true;
        undo();
      }));
    }
    if (action) {
      this.snack.appendChild(button('m-snack-btn', action.label, action.label, () => { this.snack.hidden = true; action.run(); }));
    }
    this.snack.hidden = false;
    this.snackTimer = window.setTimeout(() => { this.snack.hidden = true; }, action ? 8000 : 4000);
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
    if (!REVIEW_WORKFLOW) return;
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
      this.stopLoop();
      return;
    }
    if (!REVIEW_WORKFLOW) {
      const cur = this.labelsAt(Number(this.h.player?.currentTime) || 0)[0];
      if (cur) this.loopLabel(cur);
      else { this.loopSeg = { start: 0, end: 0 }; this.loopBtn.classList.add('on'); }
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
        this.playBtn.setAttribute('aria-label', playing ? t('rv.pause') : t('rv.play'));
      }
      this.timeCur.textContent = fmtClock(p?.currentTime);
      this.timeDur.textContent = fmtClock(p?.duration);
      if (REVIEW_WORKFLOW) { if (playing) this.markCurrent(true); }
      else { this.markStrip(); this.updateOverview(); }
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopTicker() { cancelAnimationFrame(this.raf); }

  // ── Species ─────────────────────────────────────────────────────────

  private buildSpecies(): HTMLElement {
    const s = el('section', 'm-screen m-species');
    const bar = el('header', 'm-appbar');
    bar.appendChild(el('h1', '', t('sp.title')));

    const search = el('label', 'm-search');
    search.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>';
    this.spSearch = el('input');
    this.spSearch.type = 'search';
    this.spSearch.placeholder = t('sp.search');
    this.spSearch.setAttribute('aria-label', t('sp.search'));
    this.spSearch.addEventListener('input', () => this.renderSpecies());
    search.appendChild(this.spSearch);

    const chips = el('div', 'm-chips');
    for (const [id, label] of [['all', t('common.all')], ['confirmed', t('sp.confirmed')], ['detected', t('sp.detected')]] as const) {
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
    this.spSortBtn.innerHTML = `${t('sp.sortBy')} <b>${t(`sp.sort.${this.spSort}` as const)} ▾</b>`;
    this.spMeta.textContent = t('sp.recs', { n: recCount });

    // Same matching as the desktop species search: diacritics, word starts, 4/6-letter codes, other languages.
    const q = normalizeSearch(this.spSearch.value).trim();
    const tier = new Map<string, number>();
    let items = list.filter((sp) => this.spFilter === 'all' || (this.spFilter === 'confirmed' ? sp.confirmed > 0 : sp.confirmed === 0));
    if (q) {
      for (const sp of items) tier.set(sp.key, matchTier(q, name(sp), sp.sci, this.h.altNames?.(sp.sci) || []));
      items = items.filter((sp) => tier.get(sp.key)! !== MATCH.NONE);
    }
    // While searching, better matches first; the chosen sort order breaks ties.
    const byTier = (a: any, b: any) => (q ? (tier.get(a.key)! <= MATCH.CODE ? 0 : 1) - (tier.get(b.key)! <= MATCH.CODE ? 0 : 1) : 0);
    items.sort((a, b) => byTier(a, b) || (this.spSort === 'name' ? name(a).localeCompare(name(b))
      : this.spSort === 'conf' ? b.best - a.best
      : (b.confirmed + b.detected) - (a.confirmed + a.detected) || name(a).localeCompare(name(b))));

    this.spList.replaceChildren();
    if (!items.length) {
      this.spList.appendChild(el('p', 'm-empty', list.length
        ? t('sp.noMatch')
        : t('sp.empty')));
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
      img.src = speciesImageUrl(sp.sci);
      img.addEventListener('error', () => { img.src = FALLBACK_IMG; }, { once: true });
      const main = el('div', 'm-sp-main');
      const n = el('div', 'm-sp-name', name(sp));
      n.appendChild(el('span', 'm-sp-sci', ` ${sp.sci}`));
      const meta = el('div', 'm-sp-meta');
      if (sp.confirmed) meta.appendChild(el('span', 'm-ok', `✓ ${sp.confirmed}`));
      meta.appendChild(document.createTextNode(`${sp.confirmed ? ' · ' : ''}${t('sp.meta', { det: sp.detected, recs: sp.recs.size })}`));
      main.append(n, meta);
      head.append(img, main);
      head.addEventListener('click', () => {
        if (this.spOpen.has(sp.key)) this.spOpen.delete(sp.key); else this.spOpen.add(sp.key);
        this.renderSpecies();
      });
      const best = sp.examples[0];
      const play = button('m-sp-play', I.play, t('sp.playBest', { name: name(sp) }), () => this.playExample(best.rec, best.lbl));
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
            document.createTextNode(`${fmtClock(e.lbl.start)}${i === 0 ? ` · ${t('sp.best')}` : ''}`));
          b.appendChild(info);
          b.addEventListener('click', () => this.playExample(e.rec, e.lbl));
          ex.appendChild(b);
        });
        if (sp.examples.length > 3) ex.appendChild(el('div', 'm-ex-more', t('sp.more', { n: sp.examples.length - 3 })));
        row.appendChild(ex);
      }
      this.spList.appendChild(row);
    }
  }

  /** Play one example; opens its recording first if needed (stays on the species screen). */
  private async playExample(rec: MobileRecording, lbl: any) {
    this.autoAnalyse = false;
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
    bar.appendChild(button('m-icon-btn', I.back, t('common.back'), () => this.show(this.anBackTo)));
    const titleBox = el('div', 'm-appbar-title');
    titleBox.append(el('h2', '', t('an.title')), (this.anSub = el('small', '', '')));
    bar.appendChild(titleBox);

    const body = el('div', 'm-scroll m-an-body');

    this.anProgress = el('div', 'm-an-progress');
    this.anProgressText = el('div', '', '');
    const track = el('div', 'm-an-bar');
    this.anProgressBar = el('i');
    track.appendChild(this.anProgressBar);
    this.anProgress.append(this.anProgressText, track);
    this.anProgress.hidden = true;

    const what = el('div', 'm-card');
    this.anBirdnet = this.toggleRow(what, t('an.birdnet'), t('an.birdnetHint'), true);
    this.anBirdbox = this.toggleRow(what, t('an.birdbox'), t('an.birdboxHint'), false);
    if (!this.h.analysis?.birdboxBtn) this.anBirdbox.closest('.m-row')?.setAttribute('hidden', '');
    this.anGeoRow = el('div', 'm-row');
    const geoText = el('div', 'm-row-text');
    geoText.appendChild(el('span', '', t('an.geo')));
    this.anLocation = el('small', '', '');
    geoText.appendChild(this.anLocation);
    this.anGeo = this.switchInput(false);
    this.anGeo.addEventListener('change', () => this.mirrorCheckbox(this.h.analysis?.geoCheckbox, this.anGeo.checked));
    this.anGeoRow.append(geoText, this.anGeo.parentElement!);
    what.appendChild(this.anGeoRow);

    const conf = el('div', 'm-card');
    const head = el('div', 'm-row m-row--plain');
    const ht = el('div', 'm-row-text');
    ht.append(el('span', '', t('an.minConf')), el('small', '', t('an.minConfHint')));
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
    expertBtn.innerHTML = `<span class="m-row-text"><span>${t('an.expert')}</span></span><span class="m-chev">${I.chevron}</span>`;
    this.anExpert = el('div', 'm-expert');
    this.anExpert.hidden = true;
    expertBtn.addEventListener('click', () => {
      this.anExpert.hidden = !this.anExpert.hidden;
      expertBtn.classList.toggle('open', !this.anExpert.hidden);
    });
    this.buildExpert();
    expertCard.append(expertBtn, this.anExpert);

    this.anDetectors = el('div', 'm-an-detectors');
    body.append(this.anProgress, what, conf, this.anDetectors, expertCard);

    const foot = el('div', 'm-an-foot');
    this.anRun = el('button', 'm-cta', t('an.run'));
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
      row.appendChild(el('div', 'm-row-text', t('an.overlap')));
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
      const cb = this.toggleRow(this.anExpert, t('an.merge'), '', a.mergeCheckbox.checked);
      cb.dataset.mirror = 'merge';
      cb.addEventListener('change', () => this.mirrorCheckbox(a.mergeCheckbox, cb.checked));
    }
    this.anExpert.appendChild(el('p', 'm-hint', t('an.desktopHint')));
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
    this.anSub.textContent = rec ? `${rec.title}${dur ? ` · ${fmtClock(dur, false)}` : ''}` : t('common.noRecording');
    if (!a) return;
    const c = a.confInput;
    this.anConf.min = c.min; this.anConf.max = c.max; this.anConf.step = c.step; this.anConf.value = c.value;
    this.anConfVal.textContent = Number(c.value).toFixed(2);
    const geo = a.geoCheckbox;
    this.anGeo.checked = !!geo?.checked;
    this.anGeo.disabled = !geo || geo.disabled;
    const loc = (a.locationLine?.textContent || '').trim();
    this.anLocation.textContent = this.anGeo.disabled ? t('an.geoNeedsModel') : (loc || t('an.noLocation'));
    const ov = this.anExpert.querySelector<HTMLSelectElement>('[data-mirror="overlap"]');
    if (ov && a.overlapSelect) ov.value = a.overlapSelect.value;
    const mg = this.anExpert.querySelector<HTMLInputElement>('[data-mirror="merge"]');
    if (mg && a.mergeCheckbox) mg.checked = a.mergeCheckbox.checked;
    this.anRun.disabled = !rec || this.anJob !== 'idle';
    this.renderDetectors();
  }

  /** BirdNET model and BirdBox sliders, read fresh from the desktop controls each time. */
  private renderDetectors() {
    const a = this.h.analysis;
    const box = this.anDetectors;
    box.replaceChildren();
    if (!a) return;
    const btns = [...(a.modelSeg?.querySelectorAll<HTMLButtonElement>('.seg-btn[data-value]') || [])];
    // „Custom“ needs a folder URL: that stays a desktop thing (shown only if it is the current pick).
    const shown = btns.filter((b) => b.dataset.value !== 'custom' || b.getAttribute('aria-checked') === 'true');
    if (shown.length) {
      const g = el('div', 'm-set-group');
      g.appendChild(el('h3', '', t('an.model')));
      const cur = shown.find((b) => b.getAttribute('aria-checked') === 'true');
      this.segRow(g, t('an.modelLabel'), shown.map((b) => [b.dataset.value!, (b.textContent || '').trim()] as [string, string]),
        cur?.dataset.value ?? '', (v) => {
          if (this.anJob !== 'idle') return;
          shown.find((b) => b.dataset.value === v)?.click();
          this.renderDetectors();
        });
      const note = cur ? MODEL_NOTES[cur.dataset.value!] : undefined;
      box.appendChild(g);
      if (note || cur?.dataset.note) box.appendChild(el('p', 'm-hint m-an-note', note ? t(note) : cur!.dataset.note!));
    }
    if (a.birdboxBtn && (a.birdboxConf || a.birdboxGap)) {
      const g = el('div', 'm-set-group');
      g.appendChild(el('h3', '', t('an.birdboxSet')));
      if (a.birdboxConf) {
        const c = a.birdboxConf;
        this.sliderRow(g, t('an.minConf'), c, null, () => Number(c.value).toFixed(2));
      }
      if (a.birdboxGap) {
        const gp = a.birdboxGap;
        this.sliderRow(g, t('an.bbGap'), gp, null, () => `${Number(gp.value).toFixed(2)} s`);
      }
      box.appendChild(g);
      box.appendChild(el('p', 'm-hint m-an-note', t('an.bbHint')));
    }
  }

  /** Analyse the active recording with the current settings and show it in the review screen. */
  /** „Analyse with BirdNET“: BirdNET, whatever is ticked on the Analyse screen. */
  private analyseBirdNET() {
    if (!this.h.analysis || this.anJob !== 'idle') return;
    this.renderAnalyse();
    this.startJob('birdnet');
    if (this.anJob === 'idle') this.renderReview();   // could not start: keep the button
  }

  private analyseNow() {
    if (!this.h.analysis || this.anJob !== 'idle') return;
    this.renderAnalyse();
    if (REVIEW_WORKFLOW) this.rvFrom = 'queue';
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
    a.run(job);
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
    this.anProgressText.textContent = `${t('an.running', { job: job === 'birdnet' ? 'BirdNET' : 'BirdBox' })}${status ? ` ${status}` : ''}`;
    this.anProgressBar.style.width = bar?.style.width || '0%';
    if (this.rvProgress.hidden && !REVIEW_WORKFLOW) {
      this.rvProgress.hidden = false;
      this.renderReview();   // strip: „Analysing …“ instead of „no detections“
    }
    this.rvProgress.hidden = false;
    this.rvProgress.textContent = this.anProgressText.textContent;
    this.rvProgress.style.setProperty('--p', bar?.style.width || '0%');
    if (running) return;
    if (!this.anJobStarted) {
      // The click did not start a run (no audio, model failed…): give up after a few seconds.
      if (performance.now() - this.anJobAt < 4000) return;
      this.anJob = 'idle';
      this.anProgressText.textContent = status || t('an.failed');
      this.anRun.disabled = false;
      this.rvProgress.hidden = true;
      this.renderReview();   // the strip shows the analyse button again
      return;
    }

    // Finished: chain BirdBox after BirdNET if asked, else show the results.
    if (job === 'birdnet' && this.anBirdbox.checked && a.birdboxBtn) { this.startJob('birdbox'); return; }
    this.anJob = 'idle';
    this.anProgressText.textContent = status || t('an.done');
    this.anProgressBar.style.width = '100%';
    this.anRun.disabled = false;
    setTimeout(() => { this.anProgress.hidden = true; this.rvProgress.hidden = true; this.renderReview(); }, 1500);
    this.rvFilter = 'open';
    if (this.screen === 'analyse') this.show('review');
    else if (this.screen === 'review') this.renderReview();
  }

  // ── Live ────────────────────────────────────────────────────────────

  private buildLive(): HTMLElement {
    const s = el('section', 'm-screen m-live');
    const bar = el('header', 'm-appbar');
    bar.appendChild(el('h1', '', t('live.title')));
    this.lvInfo = el('span', 'm-live-info');
    bar.appendChild(this.lvInfo);
    // Spectrogram with the detected species as marks that scroll along, level along the bottom edge.
    this.lvSpec = el('div', 'm-live-spec');
    this.lvSpec.appendChild(el('span', 'm-live-hint', t('live.hint')));
    this.lvMarksEl = el('div', 'm-live-marks');
    const meter = el('div', 'm-live-level');
    meter.setAttribute('aria-label', t('live.level'));
    this.lvMeter = el('b');
    meter.appendChild(this.lvMeter);
    const specWrap = el('div', 'm-live-specwrap');
    specWrap.append(this.lvSpec, this.lvMarksEl, meter);
    this.lvList = el('div', 'm-scroll m-live-list');
    const foot = el('div', 'm-live-foot');
    this.lvTime = el('div', 'm-live-time', '00:00');
    this.lvDiscard = button('m-live-discard', t('live.discard'), t('live.discardLabel'), () => this.stopLive(false));
    this.lvBtn = button('m-live-rec', '<i></i>', t('live.start'), () => {
      if (this.lvRec) void this.stopLive(true); else void this.startLive();
    });
    const spacer = el('span', 'm-live-discard-spacer');
    foot.append(this.lvDiscard, this.lvBtn, spacer);
    s.append(bar, specWrap, this.lvList, this.lvTime, foot);
    this.screens.set('live', s);
    return s;
  }

  private renderLive() {
    const on = !!this.lvRec;
    this.lvBtn.classList.toggle('on', on);
    this.lvBtn.setAttribute('aria-label', on ? t('live.stop') : t('live.start'));
    this.lvDiscard.hidden = !on;
    this.lvTime.classList.toggle('on', on);
    if (!on && !this.lvInfo.textContent) this.lvInfo.textContent = this.h.live?.describe?.() || t('live.every3s');
    const rows = [...this.lvSpecies.values()].sort((a, b) => b.last - a.last || b.max - a.max);
    this.lvList.replaceChildren();
    if (!rows.length) {
      this.lvList.appendChild(el('p', 'm-empty', on ? t('live.noneYet')
        : this.h.live ? t('live.emptyHint') : t('live.unavailable')));
      return;
    }
    const now = this.lvRec?.elapsed ?? Infinity;
    for (const r of rows) {
      const row = el('div', `m-live-row${on && now - r.last < 6 ? ' new' : ''}`);
      row.style.setProperty('--m-c', this.lvColor(r.sci));
      const img = el('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = speciesImageUrl(r.sci);
      img.addEventListener('error', () => { img.src = FALLBACK_IMG; }, { once: true });
      const txt = el('div', 'm-live-row-txt');
      txt.append(el('div', 'm-live-row-name', r.common || r.sci),
        el('div', 'm-live-row-sub', `${on ? this.ago(now - r.last) : fmtClock(r.last, false)} · ${r.count}×`));
      const c = el('div', 'm-live-row-conf', `${Math.round(r.max * 100)}%`);
      c.appendChild(el('small', '', t('live.max')));
      row.append(img, txt, c);
      this.lvList.appendChild(row);
    }
  }

  private lvColor(sci: string) {
    let c = this.lvColors.get(sci);
    if (!c) { c = PALETTE[this.lvColors.size % PALETTE.length]; this.lvColors.set(sci, c); }
    return c;
  }

  /** A detection on the live spectrogram: a bar over its 3 s window with the name. */
  private addLiveMark(p: LivePrediction, at: number, lane: number) {
    const m = el('div', 'm-live-mark');
    m.style.setProperty('--m-c', this.lvColor(p.scientific));
    m.style.top = `${4 + lane * 22}px`;
    const tag = el('span', 'm-live-tag');
    tag.append(el('b', '', p.common || p.scientific), el('span', '', `${Math.round(p.confidence * 100)}%`));
    m.appendChild(tag);
    this.lvMarksEl.appendChild(m);
    this.lvMarks.push({ el: m, at });
  }

  /** Marks follow the spectrogram (right edge = now); gone once they scrolled out. */
  private placeLiveMarks(now: number) {
    const w = this.lvMarksEl.clientWidth;
    if (!w) return;
    const pxs = w / LIVE_SPAN_SEC;
    this.lvMarks = this.lvMarks.filter((m) => {
      const x = w - (now - m.at) * pxs;
      if (x + 3 * pxs < 0) { m.el.remove(); return false; }
      m.el.style.width = `${3 * pxs}px`;
      m.el.style.transform = `translateX(${x}px)`;
      return true;
    });
  }

  private ago(sec: number) {
    if (sec < 6) return t('live.justNow');
    if (sec < 60) return t('live.agoS', { n: Math.round(sec / 5) * 5 });
    return t('live.agoMin', { n: Math.floor(sec / 60) });
  }

  private async startLive() {
    const live = this.h.live;
    if (!live || this.lvRec) return;
    if (!LiveRecorder.supported) { this.lvInfo.textContent = t('live.noMic'); return; }
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
    const rec = new LiveRecorder({ maxSeconds: LIVE_MAX_SEC });
    this.lvSpecies.clear();
    this.lvColors.clear();
    this.lvMarks = [];
    this.lvMarksEl.replaceChildren();
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
          if (this.lvRec !== rec) break;   // stopped or discarded meanwhile: drop late results
          preds.slice(0, 3).forEach((p, lane) => this.addLiveMark(p, at, lane));
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
      this.lvInfo.textContent = err?.name === 'NotAllowedError' ? t('live.micDenied') : t('live.mic', { msg: err?.message || err });
      this.lvBtn.disabled = false;
      return;
    }
    this.lvRec = rec;
    this.lvBtn.disabled = false;
    this.lvInfo.textContent = live.describe?.() || t('live.every3s');
    this.lvSpec.querySelector('.m-live-hint')?.remove();
    const view = new LiveSpectrogramView(this.lvSpec, { spanSeconds: LIVE_SPAN_SEC, getMaxFreq: () => PHONE_MAX_HZ });
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
      this.placeLiveMarks(rec.elapsed);
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
    this.lvSpec.replaceChildren(el('span', 'm-live-hint', keep ? t('live.saved') : t('live.discarded')));
    this.lvMarks = [];
    this.lvMarksEl.replaceChildren();
    this.renderLive();
    if (recording && this.h.live) {
      this.lvInfo.textContent = t('live.saving');
      try {
        // The saved recording opens in „Prüfen“ and is analysed there (player 'ready' handler).
        this.autoAnalyse = !!this.h.analysis;
        await this.h.live.save(recording.file);
        this.lvInfo.textContent = t('live.savedAs', { name: recording.file.name });
      } catch (err: any) {
        this.lvInfo.textContent = t('live.saveFailed', { msg: err?.message || err });
      }
    }
  }
}
