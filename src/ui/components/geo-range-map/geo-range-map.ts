/**
 * Range map of one species from the geomodel: score overlay for the visible map area and a
 * week slider (1–48) with play. Opens as a modal; reuses the location map's layout.
 */
import { loadLeaflet } from '../geo-map-modal/geo-map-modal.ts';
import { weekLabel, createGeoSourceInfo, GEO_WEEKS } from '../geo-season.ts';
import { gridForView, gridToRgba, type ViewGrid } from './range-grid.ts';

export interface RangeMapOptions {
  scientific: string;
  title?: string;
  /** Recording place: marker and initial centre. */
  place?: { lat: number; lon: number } | null;
  week?: number | null;
  modelName?: string | null;
  /** Scores below are not coloured (area filter threshold). */
  minScore?: number;
  /** Score grid for the given week. */
  fetchGrid: (grid: { lats: number[]; west: number; east: number; cols: number }, week: number) => Promise<Float32Array | null>;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export async function openRangeMap(opts: RangeMapOptions): Promise<void> {
  await loadLeaflet();
  const L = (window as any).L;
  let week = opts.week && opts.week >= 1 && opts.week <= GEO_WEEKS ? opts.week : 20;

  const backdrop = document.createElement('div');
  backdrop.className = 'geo-map-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', `Range map ${opts.title || opts.scientific}`);
  backdrop.innerHTML = `
    <div class="geo-map-modal geo-range-modal">
      <div class="geo-map-header">
        <span class="geo-map-title">${esc(opts.title || opts.scientific)}${opts.title && opts.title !== opts.scientific ? ` <i class="geo-range-sci">${esc(opts.scientific)}</i>` : ''}</span>
        <span class="geo-range-src"></span>
        <button class="geo-map-close" type="button" aria-label="Close">×</button>
      </div>
      <div class="geo-map-container geo-range-container"></div>
      <div class="geo-range-bar">
        <button class="geo-action-btn geo-range-play" type="button" aria-label="Play weeks" title="Play through the year">▶</button>
        <input class="geo-range-week" type="range" min="1" max="${GEO_WEEKS}" step="1" value="${week}" aria-label="Week" />
        <span class="geo-range-week-label"></span>
        <span class="geo-range-legend" title="Geomodel score (prior, not an observation); blank below the area filter threshold"><span>${opts.minScore ?? 0.01}</span><span class="geo-range-ramp"></span><span>1</span></span>
        <span class="geo-range-status" aria-live="polite"></span>
      </div>
      <div class="geo-map-attribution-hint">Geomodel prediction, not observations · © OpenStreetMap contributors</div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector('.geo-range-src')!.appendChild(createGeoSourceInfo(opts.modelName));

  const mapEl = backdrop.querySelector('.geo-range-container') as HTMLElement;
  const slider = backdrop.querySelector('.geo-range-week') as HTMLInputElement;
  const weekLbl = backdrop.querySelector('.geo-range-week-label') as HTMLElement;
  const status = backdrop.querySelector('.geo-range-status') as HTMLElement;
  const playBtn = backdrop.querySelector('.geo-range-play') as HTMLButtonElement;

  const center = opts.place ? [opts.place.lat, opts.place.lon] : [30, 10];
  const map = L.map(mapEl, { zoomControl: true, worldCopyJump: true }).setView(center, opts.place ? 4 : 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 12, attribution: '© OpenStreetMap contributors',
  }).addTo(map);
  if (opts.place) L.circleMarker([opts.place.lat, opts.place.lon], { radius: 5, color: '#000', weight: 2, fillColor: '#fff', fillOpacity: 1 }).addTo(map);

  let overlay: any = null;
  let token = 0;
  let closed = false;
  const cache = new Map<string, Float32Array | null>();
  let playing: number | null = null;

  const viewKey = (g: ViewGrid) => `${g.north.toFixed(3)},${g.south.toFixed(3)},${g.west.toFixed(3)},${g.east.toFixed(3)},${g.lats.length}x${g.cols}`;

  const COARSE = { cellPx: 22, max: 1500 }, FINE = { cellPx: 10, max: 4500 };

  /** Coarse grid first (fast), then a finer one unless playing or superseded. */
  async function render() {
    const my = ++token;
    weekLbl.textContent = `${weekLabel(week)} (week ${week})`;
    if (!await renderPass(my, COARSE)) return;
    if (playing == null) await renderPass(my, FINE);
  }

  async function renderPass(my: number, res: { cellPx: number; max: number }): Promise<boolean> {
    const b = map.getBounds(), size = map.getSize();
    const g = gridForView({ north: b.getNorth(), south: b.getSouth(), west: b.getWest(), east: b.getEast() }, size.x, size.y, res.cellPx, res.max);
    const key = `${viewKey(g)}|${week}`;
    let values = cache.get(key);
    if (values === undefined) {
      status.textContent = res === COARSE ? 'Computing…' : 'Refining…';
      try {
        values = await opts.fetchGrid({ lats: g.lats, west: g.west, east: g.east, cols: g.cols }, week);
      } catch (err: any) {
        if (my === token) status.textContent = `Failed: ${err?.message || err}`;
        return false;
      }
      cache.set(key, values);
      if (cache.size > 120) cache.delete(cache.keys().next().value!);
    }
    if (my !== token || closed) return false;
    if (!values) { status.textContent = 'No geomodel output for this species.'; return false; }
    status.textContent = '';
    const rows = g.lats.length, cols = g.cols;
    const canvas = document.createElement('canvas');
    canvas.width = cols; canvas.height = rows;
    const ctx = canvas.getContext('2d')!;
    ctx.putImageData(new ImageData(gridToRgba(values, rows, cols, opts.minScore ?? 0.01) as Uint8ClampedArray<ArrayBuffer>, cols, rows), 0, 0);
    const url = canvas.toDataURL();
    const bounds = [[g.south, g.west], [g.north, g.east]];
    if (overlay) { overlay.setUrl(url); overlay.setBounds(L.latLngBounds(bounds)); }
    else overlay = L.imageOverlay(url, bounds, { opacity: 0.75, className: 'geo-range-overlay' }).addTo(map);
    return true;
  }

  let moveTimer: any = null;
  map.on('moveend', () => { clearTimeout(moveTimer); moveTimer = setTimeout(render, 150); });
  slider.addEventListener('input', () => { week = Number(slider.value); render(); });

  function stop() { if (playing != null) { clearTimeout(playing); playing = null; } playBtn.textContent = '▶'; playBtn.setAttribute('aria-label', 'Play weeks'); }
  async function step() {
    week = week % GEO_WEEKS + 1;
    slider.value = String(week);
    await render();
    if (playing != null && !closed) playing = window.setTimeout(step, 250);
  }
  playBtn.addEventListener('click', () => {
    if (playing != null) { stop(); return; }
    playBtn.textContent = '❚❚'; playBtn.setAttribute('aria-label', 'Pause');
    playing = window.setTimeout(step, 0);
  });

  function close() {
    closed = true; stop();
    map.remove(); backdrop.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      if (document.activeElement === slider) return; // the slider handles its own keys
      week = (week - 1 + (e.key === 'ArrowRight' ? 1 : GEO_WEEKS - 1)) % GEO_WEEKS + 1;
      slider.value = String(week); render();
    }
  }
  document.addEventListener('keydown', onKey);
  backdrop.querySelector('.geo-map-close')!.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  setTimeout(() => { map.invalidateSize(); render(); }, 50);
}
