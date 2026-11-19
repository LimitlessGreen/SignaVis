// Touch gestures on the phone spectrogram (src/ui/mobile/mobile-app.ts).
//
//   one finger drag   → scroll in time (with a short fling)
//   two fingers       → spread sideways = zoom in time, spread up/down = zoom in frequency, move = scroll
//   (a drag also moves the frequency view up / down when it is zoomed)
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
  onEmptyTap: (clientX: number) => void;
  onDoubleTap: () => void;
}

const TAP_SLOP = 10;        // px a tap may move
const HOLD_MS = 480;
const DOUBLE_MS = 280;
const MIN_PPS = 2;
const MAX_PPS = 4000;

export class SpectrogramGestures {
  private pts = new Map<number, { x: number; y: number }>();
  private mode: 'idle' | 'tap' | 'pan' | 'pinch' = 'idle';
  private x0 = 0;
  private y0 = 0;
  private t0 = 0;
  private scroll0 = 0;
  private pinch0 = { dist: 1, mid: 0, pps: 1, scroll: 0, distY: 1, midY: 0, fMin: 0, fMax: 1, axis: '' as '' | 'x' | 'y' | 'xy' };
  private f0 = { min: 0, max: 1, top: 0, zoomed: false };
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
    target.addEventListener('pointercancel', this.cancel, opt);
    // The browser follows a touch with emulated mouse events and click / dblclick; the desktop
    // handlers would seek or zoom on those, so swallow them right after a touch.
    const swallow = (e: Event) => {
      if (performance.now() - this.lastTouch < 800) { e.stopPropagation(); e.preventDefault(); }
    };
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick']) target.addEventListener(type, swallow, { capture: true });
    // The player's own touch recogniser (components/gestures) would zoom / scroll as well: on the phone
    // this class handles touch alone (it works on pointer events, which these don't affect).
    const block = (e: Event) => { if (document.documentElement.classList.contains('is-mobile')) e.stopPropagation(); };
    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) target.addEventListener(type, block, { capture: true });
    // Long press would open the browser's context menu / text selection otherwise.
    target.addEventListener('contextmenu', (e) => { if (this.pts.size || this.held) e.preventDefault(); });
  }

  private get st() { return this.h.player()?._state; }

  private take(e: PointerEvent) {
    e.stopPropagation();
    e.preventDefault();
  }

  private down = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || !document.documentElement.classList.contains('is-mobile')) return;
    this.take(e);
    this.lastTouch = performance.now();
    cancelAnimationFrame(this.fling);
    try { this.target.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    this.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const st = this.st;
    if (this.pts.size === 1) {
      this.mode = 'tap';
      this.x0 = e.clientX; this.y0 = e.clientY; this.t0 = performance.now();
      this.scroll0 = st?._getPrimaryScrollLeft?.() ?? 0;
      this.f0 = this.freqView();
      this.vel = 0;
      this.lastMove = { x: e.clientX, t: this.t0 };
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
      this.mode = 'pinch';
      const [a, b] = [...this.pts.values()];
      const fv = this.freqView();
      this.pinch0 = {
        dist: Math.max(20, Math.abs(a.x - b.x)),
        mid: (a.x + b.x) / 2,
        pps: Number(st?.pixelsPerSecond) || 1,
        scroll: st?._getPrimaryScrollLeft?.() ?? 0,
        distY: Math.max(20, Math.abs(a.y - b.y)),
        midY: (a.y + b.y) / 2,
        fMin: fv.min, fMax: fv.max,
        axis: '',
      };
    }
  };

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
      this.schedule(() => {
        st._setLinkedScrollLeft(left);
        if (this.f0.zoomed) this.setFreq(this.f0.min, this.f0.max, dy);
      });
    } else if (this.mode === 'pinch' && this.pts.size >= 2) {
      const [a, b] = [...this.pts.values()];
      const p0 = this.pinch0;
      const dist = Math.max(20, Math.abs(a.x - b.x));
      const distY = Math.max(20, Math.abs(a.y - b.y));
      const mid = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      // Which way do the fingers spread? Decided once per pinch: sideways = time, up/down = frequency,
      // diagonal = both. Keeps an up/down pinch from also zooming time by a few per cent.
      if (!p0.axis) {
        const gx = Math.abs(Math.log(dist / p0.dist)), gy = Math.abs(Math.log(distY / p0.distY));
        if (Math.max(gx, gy) > 0.06) p0.axis = gx > gy * 2 ? 'x' : gy > gx * 2 ? 'y' : 'xy';
      }
      const rect = st.d?.canvasWrapper?.getBoundingClientRect?.() ?? this.target.getBoundingClientRect();
      this.schedule(() => {
        if (p0.axis === 'x' || p0.axis === 'xy') {
          const pps = Math.max(MIN_PPS, Math.min(MAX_PPS, p0.pps * (dist / p0.dist)));
          // The time that was under the fingers' midpoint at the start stays under the midpoint now.
          const anchorTime = (p0.scroll + (p0.mid - rect.left)) / p0.pps;
          const local = Math.max(0, Math.min(rect.width, mid - rect.left));
          st._setPixelsPerSecond(pps, true, anchorTime, local);
        }
        if (p0.axis === 'y' || p0.axis === 'xy') {
          // Frequency under the starting midpoint stays under the fingers.
          const frac = 1 - Math.max(0, Math.min(1, (p0.midY - rect.top) / rect.height));
          const anchor = p0.fMin + frac * (p0.fMax - p0.fMin);
          const range = (p0.fMax - p0.fMin) * (p0.distY / distY);
          const min = anchor - frac * range;
          this.setFreq(min, min + range, midY - p0.midY);
        }
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
    if (this.pts.size === 1 && mode === 'pinch') {
      // One finger left after a pinch: go on scrolling with it, no tap.
      const [p] = [...this.pts.values()];
      this.mode = 'pan';
      this.x0 = p.x; this.y0 = p.y;
      this.scroll0 = this.st?._getPrimaryScrollLeft?.() ?? 0;
      this.lastMove = { x: p.x, t: performance.now() };
      this.vel = 0;
      return;
    }
    if (this.pts.size) return;
    this.mode = 'idle';
    if (mode === 'pan') { this.startFling(); return; }
    if (mode !== 'tap' || this.held) return;
    if (performance.now() - this.t0 > 600) return;
    this.tap(e.clientX, e.clientY);
  };

  private cancel = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    this.pts.delete(e.pointerId);
    clearTimeout(this.holdTimer);
    if (!this.pts.size) this.mode = 'idle';
  };

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
    this.tapTimer = window.setTimeout(() => {
      if (id) this.h.onLabelTap(id); else this.h.onEmptyTap(x);
    }, DOUBLE_MS);
  }

  private labelAt(x: number, y: number): string | null {
    for (const node of document.elementsFromPoint(x, y)) {
      const region = (node as HTMLElement).closest?.('.spectrogram-label-region') as HTMLElement | null;
      if (region?.dataset.id) return region.dataset.id;
      if (node === this.target) break;
    }
    return null;
  }

  /** Visible frequency range (Hz) and the full one. */
  private freqView() {
    const st = this.st;
    const top = Number(st?.coords?.boundedMaxFreq) || 0;
    const z = st?._freqZoom;
    const min = Number(z?.min ?? 0) || 0;
    const max = Number(z?.max ?? top) || top;
    return { min, max, top, zoomed: !!z?.isZoomed };
  }

  /** Show min…max Hz, moved by `dy` px (finger down = lower frequencies come into view = view moves up). */
  private setFreq(min: number, max: number, dy: number) {
    const st = this.st;
    const z = st?._freqZoom;
    const top = Number(st?.coords?.boundedMaxFreq) || 0;
    const h = (st?.d?.canvasWrapper as HTMLElement | undefined)?.clientHeight || this.target.clientHeight || 1;
    if (!z || !top) return;
    const range = Math.max(500, Math.min(top, max - min));
    let lo = min + (dy / h) * (max - min);
    lo = Math.max(0, Math.min(top - range, lo));
    if (range >= top * 0.995) { z.reset(); return; }
    z.set(lo, lo + range);
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
}
