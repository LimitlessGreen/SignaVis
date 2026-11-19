// Touch gestures on the phone spectrogram (src/ui/mobile/mobile-app.ts).
//
//   one finger drag   → scroll in time (with a short fling); also up / down when the frequency is zoomed
//   two fingers       → spread sideways = zoom in time, spread up/down = zoom in frequency, move = scroll
//   tap               → on a detection: play it; elsewhere: move the playhead there
//   double tap        → play / pause
//   long press        → on a detection: play it as a loop
//
// Touch pointers are taken in the capture phase, so the desktop handlers (drawing boxes,
// selecting, dragging the playhead) never see them. Mouse and pen keep the desktop behaviour.

export interface GestureHost {
  /** The player (BirdNETPlayer); uses its PlayerState helpers. */
  player: () => any;
  /** Tap on a label region: its id. */
  onLabelTap: (id: string) => void;
  onLabelHold: (id: string) => void;
  /** Tap on the empty spectrogram: the time (s) under the finger when it was tapped. */
  onEmptyTap: (time: number) => void;
  onDoubleTap: () => void;
}

const TAP_SLOP = 10;        // px a tap may move
const HOLD_MS = 480;
const DOUBLE_MS = 280;
const FLING_IDLE_MS = 90;   // a finger that rested this long before lifting does not fling
const MIN_PPS = 2;
const MAX_PPS = 4000;

type Axis = '' | 'x' | 'y' | 'xy';

export class SpectrogramGestures {
  private pts = new Map<number, { x: number; y: number }>();
  private mode: 'idle' | 'tap' | 'pan' | 'pinch' = 'idle';
  private x0 = 0;
  private y0 = 0;
  private t0 = 0;
  private scroll0 = 0;
  /** Frequency view at the start of a drag, in the renderer's bin domain. */
  private f0 = { lo: 0, hi: 1, zoomed: false };
  private pinch0 = { distX: 1, distY: 1, midX: 0, midY: 0, pps: 1, scroll: 0, lo: 0, hi: 1, axis: '' as Axis };
  private holdTimer = 0;
  private held = false;
  private lastTap = 0;
  private tapTimer = 0;
  private vel = 0;
  private lastMove = { x: 0, t: 0 };
  private fling = 0;
  private raf = 0;
  private pending: (() => void) | null = null;
  private lastTouch = -1e9;

  constructor(private target: HTMLElement, private h: GestureHost) {
    target.style.touchAction = 'none';
    const opt = { capture: true, passive: false } as AddEventListenerOptions;
    target.addEventListener('pointerdown', this.down, opt);
    target.addEventListener('pointermove', this.move, opt);
    target.addEventListener('pointerup', this.up, opt);
    target.addEventListener('pointercancel', this.cancelPointer, opt);
    // The browser follows a touch with emulated mouse events and click / dblclick; the desktop
    // handlers would seek or zoom on those, so swallow them right after a touch.
    const swallow = (e: Event) => {
      if (performance.now() - this.lastTouch < 800) { e.stopPropagation(); e.preventDefault(); }
    };
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick']) target.addEventListener(type, swallow, { capture: true });
    // The player's own touch recogniser (components/gestures) would zoom / scroll as well: on the phone
    // this class handles touch alone (it works on pointer events, which these don't affect).
    const block = (e: Event) => { if (this.active) e.stopPropagation(); };
    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) target.addEventListener(type, block, { capture: true });
    // Long press would open the browser's context menu / text selection otherwise.
    target.addEventListener('contextmenu', (e) => { if (this.pts.size || this.held) e.preventDefault(); });
  }

  /** Drop pending taps, holds and flings (the player screen was left, a new recording opened…). */
  cancel() {
    clearTimeout(this.tapTimer);
    clearTimeout(this.holdTimer);
    cancelAnimationFrame(this.fling);
    this.lastTap = 0;
    this.pts.clear();
    this.mode = 'idle';
  }

  private get active() { return document.documentElement.classList.contains('is-mobile'); }
  private get st() { return this.h.player()?._state; }

  private take(e: PointerEvent) {
    e.stopPropagation();
    e.preventDefault();
  }

  private down = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || !this.active) return;
    this.take(e);
    this.lastTouch = performance.now();
    cancelAnimationFrame(this.fling);
    try { this.target.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    this.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pts.size === 1) {
      this.mode = 'tap';
      this.x0 = e.clientX; this.y0 = e.clientY; this.t0 = performance.now();
      this.startPan(e.clientX, e.clientY);
      this.held = false;
      clearTimeout(this.holdTimer);
      const id = this.labelAt(e.clientX, e.clientY);
      if (id) {
        this.holdTimer = window.setTimeout(() => {
          if (this.mode !== 'tap') return;
          this.held = true;
          navigator.vibrate?.(12);
          this.h.onLabelHold(id);
        }, HOLD_MS);
      }
    } else if (this.pts.size === 2) {
      clearTimeout(this.holdTimer);
      clearTimeout(this.tapTimer);   // a second finger: not a (double) tap
      this.mode = 'pinch';
      this.startPinch();
    }
  };

  /** Sample the view a one-finger drag starts from (after applying a queued update). */
  private startPan(x: number, y: number) {
    this.flush();
    this.x0 = x; this.y0 = y;
    this.scroll0 = this.st?._getPrimaryScrollLeft?.() ?? 0;
    this.f0 = this.freqBins();
    this.vel = 0;
    this.lastMove = { x, t: performance.now() };
  }

  private startPinch() {
    this.flush();
    const st = this.st;
    const [a, b] = [...this.pts.values()];
    const f = this.freqBins();
    this.pinch0 = {
      distX: Math.max(20, Math.abs(a.x - b.x)),
      distY: Math.max(20, Math.abs(a.y - b.y)),
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
      pps: Number(st?.pixelsPerSecond) || 1,
      scroll: st?._getPrimaryScrollLeft?.() ?? 0,
      lo: f.lo, hi: f.hi,
      axis: '',
    };
  }

  private move = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || !this.pts.has(e.pointerId)) return;
    this.take(e);
    this.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const st = this.st;
    if (!st) return;
    if (this.mode === 'tap') {
      if (Math.hypot(e.clientX - this.x0, e.clientY - this.y0) < TAP_SLOP) return;
      clearTimeout(this.holdTimer);
      if (this.held) return;
      this.mode = 'pan';
    }
    if (this.mode === 'pan') {
      const now = performance.now();
      const dt = now - this.lastMove.t;
      if (dt > 0) this.vel = 0.8 * ((e.clientX - this.lastMove.x) / dt) + 0.2 * this.vel;
      this.lastMove = { x: e.clientX, t: now };
      const left = this.scroll0 - (e.clientX - this.x0);
      const dy = e.clientY - this.y0;
      const f0 = this.f0;
      this.schedule(() => {
        st._setLinkedScrollLeft(left);
        if (f0.zoomed) this.setFreqBins(f0.lo, f0.hi, dy);
      });
    } else if (this.mode === 'pinch' && this.pts.size >= 2) {
      const [a, b] = [...this.pts.values()];
      const p0 = this.pinch0;
      const distX = Math.max(20, Math.abs(a.x - b.x));
      const distY = Math.max(20, Math.abs(a.y - b.y));
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      // Which way do the fingers spread? Decided once per pinch: sideways = time, up/down = frequency,
      // diagonal = both. Keeps an up/down pinch from also zooming time by a few per cent.
      if (!p0.axis) {
        const gx = Math.abs(Math.log(distX / p0.distX)), gy = Math.abs(Math.log(distY / p0.distY));
        if (Math.max(gx, gy) > 0.06) p0.axis = gx > gy * 2 ? 'x' : gy > gx * 2 ? 'y' : 'xy';
      }
      const rect = st.d?.canvasWrapper?.getBoundingClientRect?.() ?? this.target.getBoundingClientRect();
      this.schedule(() => {
        // Time: zoom only on a sideways spread; moving both fingers always scrolls.
        const zoomX = p0.axis === 'x' || p0.axis === 'xy';
        const pps = zoomX ? Math.max(MIN_PPS, Math.min(MAX_PPS, p0.pps * (distX / p0.distX))) : p0.pps;
        // The time under the starting midpoint stays under the fingers' midpoint now.
        const anchorTime = (p0.scroll + (p0.midX - rect.left)) / p0.pps;
        const local = Math.max(0, Math.min(rect.width, midX - rect.left));
        if (zoomX) st._setPixelsPerSecond(pps, true, anchorTime, local);
        else st._setLinkedScrollLeft(anchorTime * pps - local);
        // Frequency: zoom only on an up/down spread; moving both fingers scrolls when zoomed.
        const zoomY = p0.axis === 'y' || p0.axis === 'xy';
        const span = p0.hi - p0.lo;
        const frac = 1 - Math.max(0, Math.min(1, (p0.midY - rect.top) / rect.height));
        const anchor = p0.lo + frac * span;   // bin under the starting midpoint
        const nextSpan = zoomY ? span * (p0.distY / distY) : span;
        const fracNow = 1 - Math.max(0, Math.min(1, (midY - rect.top) / rect.height));
        if (zoomY || this.freqBins().zoomed) this.setFreqBins(anchor - fracNow * nextSpan, anchor - fracNow * nextSpan + nextSpan, 0);
      });
    }
  };

  private up = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || !this.pts.has(e.pointerId)) return;
    this.take(e);
    this.lastTouch = performance.now();
    this.pts.delete(e.pointerId);
    clearTimeout(this.holdTimer);
    const mode = this.mode;
    if (this.pts.size === 1 && mode === 'pinch') { this.continueWithOneFinger(); return; }
    if (this.pts.size) return;
    this.mode = 'idle';
    if (mode === 'pan') {
      // Fling only when the finger was still moving as it lifted.
      if (performance.now() - this.lastMove.t < FLING_IDLE_MS) this.startFling();
      return;
    }
    if (mode !== 'tap' || this.held) return;
    if (performance.now() - this.t0 > 600) return;
    this.tap(e.clientX, e.clientY);
  };

  private cancelPointer = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || !this.pts.has(e.pointerId)) return;
    this.pts.delete(e.pointerId);
    clearTimeout(this.holdTimer);
    if (this.pts.size === 1 && this.mode === 'pinch') { this.continueWithOneFinger(); return; }
    if (!this.pts.size) this.mode = 'idle';
  };

  /** One finger left after a pinch: go on scrolling with it from the view as it is now (no tap). */
  private continueWithOneFinger() {
    const [p] = [...this.pts.values()];
    this.mode = 'pan';
    this.startPan(p.x, p.y);
  }

  /** Single tap waits a moment for a second one (double tap = play / pause). */
  private tap(x: number, y: number) {
    const now = performance.now();
    if (now - this.lastTap < DOUBLE_MS) {
      clearTimeout(this.tapTimer);
      this.lastTap = 0;
      this.h.onDoubleTap();
      return;
    }
    this.lastTap = now;
    const id = this.labelAt(x, y);
    // Resolve a blank tap against the view that received it (a later scroll must not move the target).
    const time = id ? 0 : this.timeAt(x);
    this.tapTimer = window.setTimeout(() => {
      if (id) this.h.onLabelTap(id); else if (time != null) this.h.onEmptyTap(time);
    }, DOUBLE_MS);
  }

  private timeAt(x: number): number | null {
    const st = this.st;
    const w = st?.d?.canvasWrapper as HTMLElement | undefined;
    const pps = Number(st?.pixelsPerSecond) || 0;
    if (!w || !pps) return null;
    const r = w.getBoundingClientRect();
    return Math.max(0, (w.scrollLeft + (x - r.left)) / pps);
  }

  private labelAt(x: number, y: number): string | null {
    for (const node of document.elementsFromPoint(x, y)) {
      const region = (node as HTMLElement).closest?.('.spectrogram-label-region') as HTMLElement | null;
      if (region?.dataset.id) return region.dataset.id;
      if (node === this.target) break;
    }
    return null;
  }

  // ── Frequency view in the renderer's bin domain (linear, mel or log rows) ──

  private get coords() { return this.st?.coords; }

  private toBin(f: number) {
    const c = this.coords;
    return c?._freqToBinFractional ? Number(c._freqToBinFractional(f)) : f;
  }

  /** Fractional bin → Hz (the coordinate system only maps whole mel bins). */
  private toFreq(bin: number) {
    const c = this.coords;
    if (!c) return bin;
    if (c.isLinear) return bin * (c.nyquist / c.spectrogramMels);
    const freqs: ArrayLike<number> = c.melFreqs || [];
    const i = Math.max(0, Math.min(freqs.length - 1, Math.floor(bin)));
    const j = Math.min(freqs.length - 1, i + 1);
    return freqs[i] + (freqs[j] - freqs[i]) * (bin - i);
  }

  /** Visible frequency range as bins, plus the top bin and whether it is zoomed. */
  private freqBins() {
    const st = this.st;
    const top = Number(st?.coords?.boundedMaxFreq) || 0;
    const z = st?._freqZoom;
    const min = Number(z?.min ?? 0) || 0;
    const max = Number(z?.max ?? top) || top;
    return { lo: this.toBin(min), hi: this.toBin(max), zoomed: !!z?.isZoomed };
  }

  /** Show bins lo…hi, moved by `dy` px (finger down = the view moves to higher frequencies). */
  private setFreqBins(lo: number, hi: number, dy: number) {
    const st = this.st;
    const z = st?._freqZoom;
    const topHz = Number(st?.coords?.boundedMaxFreq) || 0;
    if (!z || !topHz) return;
    const topBin = this.toBin(topHz);
    const h = (st?.d?.canvasWrapper as HTMLElement | undefined)?.clientHeight || this.target.clientHeight || 1;
    const minSpan = Math.max(1, topBin / 60);
    const span = Math.max(minSpan, Math.min(topBin, hi - lo));
    if (span >= topBin * 0.995) { z.reset(); return; }
    let start = lo + (dy / h) * (hi - lo);
    start = Math.max(0, Math.min(topBin - span, start));
    z.set(this.toFreq(start), this.toFreq(start + span));
  }

  private startFling() {
    let v = this.vel * 16;   // px per frame
    if (Math.abs(v) < 2) return;
    const st = this.st;
    if (!st) return;
    const step = () => {
      v *= 0.94;
      if (Math.abs(v) < 0.5) return;
      st._setLinkedScrollLeft((st._getPrimaryScrollLeft?.() ?? 0) - v);
      this.fling = requestAnimationFrame(step);
    };
    this.fling = requestAnimationFrame(step);
  }

  /** At most one viewport update per frame. */
  private schedule(fn: () => void) {
    this.pending = fn;
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      const f = this.pending;
      this.pending = null;
      f?.();
    });
  }

  /** Apply a queued update now (before sampling the view for the next gesture phase). */
  private flush() {
    if (!this.raf) return;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    const f = this.pending;
    this.pending = null;
    f?.();
  }
}
