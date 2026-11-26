/**
 * Phone „Details“ screen: the recording's properties as cards instead of the desktop attribute table.
 * Hero (species, quality, Xeno-canto), when & where (editable date/time/place, mini map, locate),
 * light charts, recording notes from Xeno-canto, the file, and a label summary.
 * Strings: i18n.ts (`det.*`).
 */

import { formatCoords, type ContextField, type ContextValues, type Coords, type ResolvedContext } from '../../app/recording-context.ts';
import { buildMiniMap } from '../panels/recording-context-block.ts';
import { SunCharts } from '../../../packages/sun-charts/src/index.ts';
import { prefs } from '../../infrastructure/storage/prefs.ts';
import { openMapModal } from '../components/geo-map-modal/geo-map-modal.ts';
import type { MetadataGroup } from '../../domain/fileMetadata.ts';
import { speciesImageUrl } from '../../infrastructure/tauri/runtime.ts';
import { t, getLang, type MKey } from './i18n.ts';

export interface MobileDetails {
  title: string;
  /** Xeno-canto number (without "XC"), if the recording comes from there. */
  xcId?: string | null;
  scientific?: string | null;
  common?: string | null;
  imageUrl?: string | null;
  /** Normalized Xeno-canto metadata (recordist, quality, license, method, remarks, …). */
  meta?: Record<string, any> | null;
  file: { filename?: string | null; sampleRate?: number | null; duration?: number | null; channels?: number | null };
  /** Metadata chunks of the file (GUANO, BWF, WAV INFO, AudioMoth, iXML). */
  fileMetadata?: MetadataGroup[];
  context: ResolvedContext;
  labels: { total: number; own: number; detections: number; species: number };
}

export interface DetailsHost {
  getDetails(): MobileDetails | null;
  /** Store a manual value (null clears it, back to the automatic source). */
  setContext?(field: ContextField, value: ContextValues[ContextField] | null): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

/** „1:05:03“, „3:07“, „12.4 s“. */
export function fmtDuration(sec: number | null | undefined) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return '';
  if (s < 60) return `${s.toFixed(1)} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** „48 kHz“, „22.05 kHz“. */
export function fmtRate(hz: number | null | undefined) {
  const v = Number(hz);
  if (!Number.isFinite(v) || v <= 0) return '';
  return `${Math.round(v / 10) / 100} kHz`;
}

/** Xeno-canto quality letter (A best … E), or '' for anything else ("no score"). */
export function qualityLetter(q: any) {
  const s = String(q ?? '').trim().toUpperCase();
  return /^[A-E]$/.test(s) ? s : '';
}

/** XC yes/no fields ("yes", "no", "unknown", "?") → 'yes' | 'no' | ''. */
export function yesNo(v: any): 'yes' | 'no' | '' {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'yes' || s === 'y' || s === 'true') return 'yes';
  if (s === 'no' || s === 'n' || s === 'false') return 'no';
  return '';
}

/** Background species, from a list or a comma-separated string. */
export function splitSpecies(v: any): string[] {
  const arr = Array.isArray(v) ? v : String(v ?? '').split(',');
  return arr.map((x) => String(x).trim()).filter(Boolean);
}

/** „Sunday, 12 May 2024“ in the app language; the raw value if it is not a full date. */
export function fmtLongDate(date: string | null | undefined, lang = getLang()) {
  if (!date) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.toLocaleDateString(lang, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

const SOURCE_KEY: Record<string, MKey> = { manual: 'det.src.manual', xc: 'det.src.xc', guano: 'det.src.guano', header: 'det.src.header', filename: 'det.src.filename' };

export class MobileDetailsView {
  readonly body: HTMLElement;
  private h: DetailsHost;
  private sun = new SunCharts({ storage: prefs, moon: true });

  constructor(host: DetailsHost) {
    this.h = host;
    this.body = el('div', 'm-scroll m-det-body');
  }

  render() {
    const b = this.body;
    b.replaceChildren();
    const d = this.h.getDetails();
    if (!d) { b.appendChild(el('p', 'm-empty', t('det.none'))); return; }
    b.append(this.hero(d), this.whenWhere(d));
    const ctx = d.context;
    const light = this.sun.render(ctx.coords.value, ctx.date.value, ctx.time.value, d.file.duration || 0);
    if (!light.hidden) {
      // The charts bring their own heading (with the view and zone pickers).
      const c = el('section', 'm-dcard m-dcard--light');
      c.appendChild(light);
      b.appendChild(c);
    }
    const notes = this.notes(d);
    if (notes) b.appendChild(notes);
    b.append(this.file(d));
    const fm = this.fileMeta(d);
    if (fm) b.appendChild(fm);
    b.appendChild(this.labels(d));
  }

  private card(title: string, content?: HTMLElement | null, cls = '') {
    const c = el('section', `m-dcard ${cls}`.trim());
    c.appendChild(el('h3', '', title));
    if (content) c.appendChild(content);
    return c;
  }

  /** Key/value rows; empty values are left out. Returns null when nothing is left. */
  private rows(items: [string, string | HTMLElement | null | undefined][]) {
    const dl = el('dl', 'm-dl');
    for (const [k, v] of items) {
      if (v == null || v === '') continue;
      dl.appendChild(el('dt', '', k));
      const dd = el('dd');
      if (typeof v === 'string') dd.textContent = v; else dd.appendChild(v);
      dl.appendChild(dd);
    }
    return dl.childElementCount ? dl : null;
  }

  private hero(d: MobileDetails) {
    const s = el('section', 'm-dhero');
    const src = d.imageUrl ?? (d.scientific ? speciesImageUrl(d.scientific) : null);
    if (src) {
      const img = el('img', 'm-dhero-img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = src;
      img.addEventListener('error', () => img.remove(), { once: true });
      s.appendChild(img);
    }
    const tx = el('div', 'm-dhero-tx');
    tx.appendChild(el('h2', '', d.common || d.title));
    if (d.scientific) tx.appendChild(el('i', 'm-dhero-sci', d.scientific));
    if (d.common && d.title && d.title !== d.common) tx.appendChild(el('small', 'm-dhero-file', d.title));
    const chips = el('div', 'm-dhero-chips');
    const q = qualityLetter(d.meta?.quality);
    if (q) {
      const c = el('span', `m-qual m-qual--${q.toLowerCase()}`, q);
      c.title = t('det.quality');
      c.setAttribute('aria-label', `${t('det.quality')} ${q}`);
      chips.appendChild(c);
    }
    if (d.xcId) {
      const a = el('a', 'm-dchip', `XC${d.xcId}`);
      a.href = `https://xeno-canto.org/${encodeURIComponent(d.xcId)}`;
      a.target = '_blank';
      a.rel = 'noopener';
      chips.appendChild(a);
    }
    const dur = fmtDuration(d.file.duration);
    if (dur) chips.appendChild(el('span', 'm-dchip', dur));
    if (chips.childElementCount) tx.appendChild(chips);
    s.appendChild(tx);
    return s;
  }

  private sourceTag(src: string | null) {
    return src ? el('span', 'm-dsrc', t(SOURCE_KEY[src] ?? 'det.src.manual')) : null;
  }

  /** One editable line: label, value (native input), where it comes from, ↺ for manual values. */
  private editRow(label: string, field: ContextField, input: HTMLInputElement, src: string | null) {
    const row = el('div', 'm-drow');
    const lab = el('label', 'm-drow-k', label);
    input.id = `m-det-${field}`;
    lab.htmlFor = input.id;
    input.addEventListener('change', () => this.h.setContext?.(field, input.value.trim() || null));
    input.disabled = !this.h.setContext;
    const v = el('div', 'm-drow-v');
    v.appendChild(input);
    const tag = this.sourceTag(src);
    if (tag) v.appendChild(tag);
    if (src === 'manual' && this.h.setContext) {
      const r = el('button', 'm-dreset', '↺');
      r.type = 'button';
      r.setAttribute('aria-label', t('det.reset'));
      r.addEventListener('click', () => this.h.setContext?.(field, null));
      v.appendChild(r);
    }
    row.append(lab, v);
    return row;
  }

  private input(type: string, value: string | null, placeholder = '') {
    const i = el('input', 'm-dinput');
    i.type = type;
    i.value = value ?? '';
    i.placeholder = placeholder;
    return i;
  }

  private whenWhere(d: MobileDetails) {
    const ctx = d.context;
    const c = this.card(t('det.whenWhere'));
    if (ctx.date.value) c.appendChild(el('div', 'm-dbig', fmtLongDate(ctx.date.value)));
    c.appendChild(this.editRow(t('det.date'), 'date', this.input('date', ctx.date.value), ctx.date.source));
    c.appendChild(this.editRow(t('det.time'), 'time', this.input('time', ctx.time.value), ctx.time.source));
    c.appendChild(this.editRow(t('det.place'), 'locality', this.input('text', ctx.locality.value, t('det.placeHint')), ctx.locality.source));

    const coords = ctx.coords.value as Coords | null;
    const pos = el('div', 'm-drow');
    pos.appendChild(el('span', 'm-drow-k', t('det.coords')));
    const pv = el('div', 'm-drow-v');
    pv.appendChild(el('span', 'm-dmono', coords ? formatCoords(coords) : t('det.noCoords')));
    const tag = this.sourceTag(ctx.coords.source);
    if (tag) pv.appendChild(tag);
    if (ctx.coords.source === 'manual' && this.h.setContext) {
      const r = el('button', 'm-dreset', '↺');
      r.type = 'button';
      r.setAttribute('aria-label', t('det.reset'));
      r.addEventListener('click', () => this.h.setContext?.('coords', null));
      pv.appendChild(r);
    }
    pos.appendChild(pv);
    c.appendChild(pos);
    if (d.meta?.alt) c.appendChild(this.rows([[t('det.alt'), `${d.meta.alt} m`]])!);

    if (coords) c.appendChild(buildMiniMap(coords, () => this.openMap(coords)));
    if (this.h.setContext) {
      const acts = el('div', 'm-dacts');
      const here = el('button', 'm-set-btn', t('det.locate'));
      here.type = 'button';
      here.addEventListener('click', () => this.locate(here));
      const map = el('button', 'm-set-btn', t('det.pickMap'));
      map.type = 'button';
      map.addEventListener('click', () => this.openMap(coords));
      acts.append(here, map);
      c.appendChild(acts);
    }
    if (ctx.device.value) c.appendChild(this.rows([[t('det.device'), ctx.device.value]])!);
    return c;
  }

  private openMap(c: Coords | null) {
    openMapModal({
      lat: c?.lat ?? 51, lon: c?.lon ?? 10, zoom: c ? 10 : 5,
      onConfirm: ({ lat, lon }: any) => this.h.setContext?.('coords', { lat, lon }),
    });
  }

  private locate(btn: HTMLButtonElement) {
    if (!navigator.geolocation) { btn.textContent = t('det.noGeo'); return; }
    btn.disabled = true;
    navigator.geolocation.getCurrentPosition(
      (p) => { btn.disabled = false; this.h.setContext?.('coords', { lat: p.coords.latitude, lon: p.coords.longitude }); },
      (err) => { btn.disabled = false; btn.textContent = err.code === 1 ? t('det.geoDenied') : t('det.geoFailed'); },
      { timeout: 8000, maximumAge: 60000 },
    );
  }

  /** Recordist's notes (Xeno-canto): who, how, background species, remarks. */
  private notes(d: MobileDetails) {
    const m = d.meta || {};
    const yn = (v: any) => { const x = yesNo(v); return x ? t(x === 'yes' ? 'det.yes' : 'det.no') : ''; };
    const dl = this.rows([
      [t('det.recordist'), m.recordist],
      [t('det.soundType'), m.soundType],
      [t('det.sex'), m.sex],
      [t('det.stage'), m.stage],
      [t('det.method'), m.method],
      [t('det.temp'), m.temperature],
      [t('det.seen'), yn(m.animalSeen)],
      [t('det.playback'), yn(m.playbackUsed)],
      [t('det.license'), this.license(m.license)],
    ]);
    const also = splitSpecies(m.backgroundSpecies ?? m.also);
    if (!dl && !also.length && !m.remarks) return null;
    const c = this.card(t('det.notes'), dl);
    if (also.length) {
      c.appendChild(el('div', 'm-dsub', t('det.background')));
      const chips = el('div', 'm-dtags');
      for (const sp of also) chips.appendChild(el('span', 'm-dchip', sp));
      c.appendChild(chips);
    }
    if (m.remarks) c.appendChild(el('blockquote', 'm-dquote', String(m.remarks)));
    return c;
  }

  private license(lic: any) {
    const s = String(lic ?? '').trim();
    if (!s) return null;
    if (!/^(https?:)?\/\//.test(s)) return s;
    const a = el('a', '', s.replace(/^(https?:)?\/\/(www\.)?/, '').replace(/\/$/, ''));
    a.href = s.startsWith('//') ? `https:${s}` : s;
    a.target = '_blank';
    a.rel = 'noopener';
    return a;
  }

  /** Every metadata chunk of the file, one collapsible group per source (GUANO first: usually the richest). */
  private fileMeta(d: MobileDetails) {
    const groups = (d.fileMetadata || []).filter((g) => g.entries.length);
    if (!groups.length) return null;
    const c = this.card(t('det.fileMeta'));
    groups.forEach((g, i) => {
      const box = el('details', 'm-dgroup');
      box.open = i === 0;
      const sum = el('summary');
      sum.append(el('span', '', g.source), el('span', 'm-dcount', String(g.entries.length)));
      box.appendChild(sum);
      const dl = this.rows(g.entries.map(([k, v]) => [k.split('|').join(' · '), v]));
      if (dl) box.appendChild(dl);
      c.appendChild(box);
    });
    return c;
  }

  private file(d: MobileDetails) {
    const f = d.file;
    return this.card(t('det.file'), this.rows([
      [t('det.filename'), f.filename || ''],
      [t('det.duration'), fmtDuration(f.duration)],
      [t('det.rate'), fmtRate(f.sampleRate)],
      [t('det.channels'), f.channels ? String(f.channels) : ''],
    ]) ?? el('p', 'm-dmuted', t('common.unknown')));
  }

  private labels(d: MobileDetails) {
    const g = el('div', 'm-dstats');
    for (const [n, key] of [[d.labels.species, 'det.nSpecies'], [d.labels.detections, 'det.nDetections'], [d.labels.own, 'det.nOwn']] as [number, MKey][]) {
      const s = el('div', 'm-dstat');
      s.append(el('b', '', String(n)), el('span', '', t(key)));
      g.appendChild(s);
    }
    return this.card(t('det.labels'), g);
  }
}
