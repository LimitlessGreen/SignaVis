/**
 * Review list — the phone view of the Labels tab (plans/mobile-ui-plan.md, phase 3).
 *
 * One card per label, sorted by start time:
 *   - tap the card            → play that segment (tap again to stop)
 *   - swipe right / ✓ button  → accept: copy a detection into "My labels"
 *   - swipe left  / ✕ button  → discard: remove the label (undo via snackbar)
 *
 * Filter chips: "To review" (detections not yet accepted) · "Mine" · "All".
 * Accept/discard write straight into the project (decided in the plan).
 * The component holds no label state; the host passes the current labels to render().
 */

export interface ReviewListOptions {
  container: HTMLElement;
  resolveName: (lbl: any) => { display: string; scientific?: string };
  /** True for labels in "My labels". */
  isOwn: (lbl: any) => boolean;
  /** True if a detection already has a copy in "My labels". */
  isAccepted: (lbl: any) => boolean;
  /** True if the label must not be removed (locked / imported set). */
  isLocked: (lbl: any) => boolean;
  onPlay: (lbl: any) => void;
  onAccept: (lbl: any) => void;
  /** Remove the label; return a function that undoes it. */
  onDiscard: (lbl: any) => (() => void) | void;
}

type Filter = 'todo' | 'own' | 'all';
const FILTER_KEY = 'signavis.review.filter.v1';
const SWIPE_THRESHOLD = 90;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function fmtTime(sec: number) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

function originBadge(lbl: any, own: boolean) {
  if (own) return { text: 'Mine', cls: 'me' };
  const o = String(lbl.origin || '');
  if (o === 'BirdNET') return { text: 'BirdNET', cls: 'bn' };
  if (o === 'BirdBox') return { text: 'BirdBox', cls: 'bb' };
  if (o === 'xeno-canto') return { text: 'XC', cls: 'xc' };
  return { text: o || 'Imported', cls: 'xc' };
}

export class ReviewList {
  private o: ReviewListOptions;
  private root: HTMLElement;
  private listEl: HTMLElement;
  private chips = new Map<Filter, HTMLButtonElement>();
  private snack: HTMLElement;
  private snackTimer = 0;
  private filter: Filter;
  private labels: any[] = [];
  private playingId: string | null = null;

  constructor(opts: ReviewListOptions) {
    this.o = opts;
    let f: Filter = 'todo';
    try { const s = localStorage.getItem(FILTER_KEY); if (s === 'own' || s === 'all') f = s; } catch { /* ignore */ }
    this.filter = f;

    this.root = el('div', 'review');
    const bar = el('div', 'review-chips');
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Show');
    for (const [id, text] of [['todo', 'To review'], ['own', 'Mine'], ['all', 'All']] as [Filter, string][]) {
      const b = el('button', 'review-chip', text);
      b.type = 'button';
      b.addEventListener('click', () => this.setFilter(id));
      this.chips.set(id, b);
      bar.appendChild(b);
    }
    this.listEl = el('div', 'review-list');
    this.snack = el('div', 'review-snack');
    this.snack.setAttribute('role', 'status');
    this.root.append(bar, this.listEl, this.snack);
    opts.container.appendChild(this.root);
  }

  render(labels: any[]) {
    this.labels = labels || [];
    this.draw();
  }

  /** Mark the card whose segment is playing (null: none). */
  setPlaying(id: string | null) {
    this.playingId = id;
    for (const c of this.listEl.querySelectorAll<HTMLElement>('.review-card')) {
      c.classList.toggle('playing', c.dataset.id === id);
    }
  }

  private setFilter(f: Filter) {
    this.filter = f;
    try { localStorage.setItem(FILTER_KEY, f); } catch { /* ignore */ }
    this.draw();
  }

  private visible(): any[] {
    const { isOwn, isAccepted } = this.o;
    const list = this.labels.filter((l) => {
      if (this.filter === 'own') return isOwn(l);
      if (this.filter === 'todo') return !isOwn(l) && !isAccepted(l);
      return true;
    });
    return list.sort((a, b) => (a.start - b.start) || (a.end - b.end));
  }

  private draw() {
    for (const [id, b] of this.chips) b.setAttribute('aria-pressed', String(id === this.filter));
    this.listEl.replaceChildren();
    const items = this.visible();
    if (!items.length) {
      const msg = this.labels.length === 0
        ? 'No labels yet. Run an analysis in the Analyse tab to get detections to review.'
        : this.filter === 'todo' ? 'Everything reviewed.' : 'Nothing here.';
      this.listEl.appendChild(el('div', 'review-empty', msg));
      return;
    }
    for (const lbl of items) this.listEl.appendChild(this.card(lbl));
  }

  private card(lbl: any): HTMLElement {
    const { isOwn, isAccepted, isLocked } = this.o;
    const own = isOwn(lbl);
    const accepted = !own && isAccepted(lbl);
    const canAccept = !own && !accepted;
    const canDiscard = !isLocked(lbl);

    const card = el('div', 'review-card');
    card.dataset.id = String(lbl.id);
    if (lbl.id === this.playingId) card.classList.add('playing');
    if (accepted) card.classList.add('accepted');

    const body = el('div', 'review-card-body');
    body.setAttribute('role', 'button');
    body.tabIndex = 0;

    const play = el('span', 'review-play');
    play.setAttribute('aria-hidden', 'true');
    play.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5 3.5v9l7-4.5z"/></svg>';

    const main = el('div', 'review-main');
    const { display, scientific } = this.o.resolveName(lbl) || { display: '' };
    const name = display || lbl.label || 'Unknown';
    const nameEl = el('div', 'review-name', name);
    if (scientific && scientific !== name) nameEl.appendChild(el('span', 'review-sci', ` ${scientific}`));
    main.appendChild(nameEl);
    const meta = el('div', 'review-meta');
    const badge = originBadge(lbl, own);
    meta.appendChild(el('span', `review-badge review-badge--${badge.cls}`, badge.text));
    meta.appendChild(el('span', '', `${fmtTime(lbl.start)} · ${Math.max(0, lbl.end - lbl.start).toFixed(1)} s`));
    if (accepted) meta.appendChild(el('span', 'review-accepted', '✓ in my labels'));
    main.appendChild(meta);

    body.append(play, main);
    if (lbl.confidence != null) {
      const pct = Math.min(100, Math.round(Number(lbl.confidence) * 100));
      body.appendChild(el('span', `review-conf${pct >= 60 ? ' hi' : ''}`, `${pct}%`));
    }
    body.title = `Play ${name}`;
    body.setAttribute('aria-label', `${name}, ${fmtTime(lbl.start)}. Tap to play.`);

    const acts = el('div', 'review-acts');
    if (canDiscard) {
      const no = el('button', 'review-btn review-btn--no', '✕');
      no.type = 'button';
      no.setAttribute('aria-label', 'Discard');
      no.addEventListener('click', () => this.discard(lbl));
      acts.appendChild(no);
    }
    if (canAccept) {
      const yes = el('button', 'review-btn review-btn--yes', '✓');
      yes.type = 'button';
      yes.setAttribute('aria-label', 'Accept into my labels');
      yes.addEventListener('click', () => this.accept(lbl));
      acts.appendChild(yes);
    }

    card.append(body, acts);
    this.attachSwipe(card, body, lbl, canAccept, canDiscard);
    body.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.o.onPlay(lbl); }
    });
    return card;
  }

  /** Horizontal swipe on the card body; a tap without movement plays. */
  private attachSwipe(card: HTMLElement, body: HTMLElement, lbl: any, canAccept: boolean, canDiscard: boolean) {
    let x0 = 0, y0 = 0, dx = 0, id = -1;
    let mode: 'idle' | 'pending' | 'swipe' | 'scroll' = 'idle';

    body.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      x0 = e.clientX; y0 = e.clientY; dx = 0; id = e.pointerId; mode = 'pending';
    });
    body.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id || mode === 'idle' || mode === 'scroll') return;
      const mx = e.clientX - x0, my = e.clientY - y0;
      if (mode === 'pending') {
        if (Math.abs(my) > 10 && Math.abs(my) > Math.abs(mx)) { mode = 'scroll'; return; }
        if (Math.abs(mx) > 10) { mode = 'swipe'; body.setPointerCapture(id); card.classList.add('swiping'); }
        else return;
      }
      dx = mx;
      if ((dx > 0 && !canAccept) || (dx < 0 && !canDiscard)) dx = dx / 4;   // resist: action not available
      body.style.transform = `translateX(${dx}px)`;
      card.dataset.swipe = dx > 30 ? 'yes' : dx < -30 ? 'no' : '';
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      const was = mode;
      mode = 'idle';
      card.classList.remove('swiping');
      card.dataset.swipe = '';
      body.style.transform = '';
      if (was === 'pending' && e.type === 'pointerup') { this.o.onPlay(lbl); return; }
      if (was !== 'swipe') return;
      if (dx > SWIPE_THRESHOLD && canAccept) this.accept(lbl);
      else if (dx < -SWIPE_THRESHOLD && canDiscard) this.discard(lbl);
    };
    body.addEventListener('pointerup', end);
    body.addEventListener('pointercancel', end);
  }

  private accept(lbl: any) {
    this.o.onAccept(lbl);
    this.toast('Added to my labels');
  }

  private discard(lbl: any) {
    const undo = this.o.onDiscard(lbl);
    this.toast('Label discarded', typeof undo === 'function' ? undo : undefined);
  }

  private toast(text: string, undo?: () => void) {
    clearTimeout(this.snackTimer);
    this.snack.replaceChildren(el('span', '', text));
    if (undo) {
      const b = el('button', 'review-snack-undo', 'Undo');
      b.type = 'button';
      b.addEventListener('click', () => { undo(); this.snack.classList.remove('show'); });
      this.snack.appendChild(b);
    }
    this.snack.classList.add('show');
    this.snackTimer = window.setTimeout(() => this.snack.classList.remove('show'), undo ? 6000 : 2000);
  }
}
