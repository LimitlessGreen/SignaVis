/**
 * Geo-map modal — Leaflet/OSM picker for recording coordinates.
 *
 * Usage:
 *   import { openMapModal } from './lib/geo-map-modal.js';
 *   openMapModal({ lat: 51.5, lon: 10.2, onConfirm: ({ lat, lon }) => { ... } });
 */

// ── Shared SVG icons (inline, currentColor) ─────────────────────────────────
export const GEO_ICONS = {
  /** Location pin (filled) */
  pin: `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>`,
  /** Crosshair / GPS target (locate current position) */
  locate: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/></svg>`,
  /** Folded map */
  map: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>`,
};

const LEAFLET_VERSION = '1.9.4';
const LEAFLET_CSS = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`;
const LEAFLET_JS  = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js`;

let leafletLoadPromise: any = null;

function loadLeaflet() {
  if (leafletLoadPromise) return leafletLoadPromise;
  leafletLoadPromise = new Promise<void>((resolve, reject) => {
    if ((window as any).L?.map) { resolve(); return; }

    const link = document.createElement('link');
    link.rel  = 'stylesheet';
    link.href = LEAFLET_CSS;
    document.head.appendChild(link);

    const script = document.createElement('script');
    script.src = LEAFLET_JS;
    script.onload  = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Leaflet from CDN'));
    document.head.appendChild(script);
  });
  return leafletLoadPromise;
}

/**
 * Open an OSM map modal to pick / confirm a recording location.
 *
 * @param {object}   opts
 * @param {number}   [opts.lat=51]    Initial latitude.
 * @param {number}   [opts.lon=10]    Initial longitude.
 * @param {number}   [opts.zoom=6]    Initial zoom level.
 * @param {boolean}  [opts.readOnly]  View-only mode: marker not draggable, no confirm button.
 * @param {(result: {lat:number, lon:number}) => void} opts.onConfirm  Called on "Confirm".
 * @param {() => void} [opts.onCancel]  Called on "Cancel" / backdrop click / Escape.
 */
export async function openMapModal({ lat = 51, lon = 10, zoom = 6, readOnly = false, onConfirm, onCancel }: any) {
  await loadLeaflet();

  const L = (window as any).L;

  // ── Build modal DOM ──────────────────────────────────────────────
  const backdrop = document.createElement('div');
  backdrop.className = 'geo-map-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', 'Recording location');

  const editControls = readOnly ? '' : `
    <label class="geo-map-coord-label">
      <span>Lat</span>
      <input class="input geo-map-lat-input" type="number" step="0.0001" min="-90"  max="90" />
    </label>
    <label class="geo-map-coord-label">
      <span>Lon</span>
      <input class="input geo-map-lon-input" type="number" step="0.0001" min="-180" max="180" />
    </label>
    <button class="geo-action-btn geo-map-locate-btn" type="button" title="Use my current location" style="margin-left:auto">
      ${GEO_ICONS.locate} Locate me
    </button>`;

  const coordDisplay = readOnly ? `
    <span class="geo-map-coord-readonly">${lat.toFixed(5)}, ${lon.toFixed(5)}</span>` : '';

  const footer = readOnly
    ? `<button class="geo-action-btn geo-map-cancel-btn" type="button">Close</button>`
    : `<button class="geo-action-btn geo-map-cancel-btn" type="button">Cancel</button>
       <button class="geo-action-btn primary geo-map-confirm-btn" type="button">${GEO_ICONS.pin} Confirm Location</button>`;

  const hint = readOnly
    ? '© OpenStreetMap contributors'
    : 'Click map or drag marker to set location · © OpenStreetMap contributors';

  backdrop.innerHTML = `
    <div class="geo-map-modal">
      <div class="geo-map-header">
        <span class="geo-map-title">${readOnly ? 'Recording Location' : 'Set Recording Location'}</span>
        <button class="geo-map-close" type="button" aria-label="Close">×</button>
      </div>
      <div class="geo-map-coord-bar">${coordDisplay}${editControls}</div>
      <div class="geo-map-container"></div>
      <div class="geo-map-attribution-hint">${hint}</div>
      <div class="geo-map-footer">${footer}</div>
    </div>
  `;

  document.body.appendChild(backdrop);

  const latInput   = backdrop.querySelector('.geo-map-lat-input');
  const lonInput   = backdrop.querySelector('.geo-map-lon-input');
  const locateBtn  = backdrop.querySelector('.geo-map-locate-btn');
  const cancelBtn  = backdrop.querySelector('.geo-map-cancel-btn');
  const confirmBtn = backdrop.querySelector('.geo-map-confirm-btn');
  const closeBtn   = backdrop.querySelector('.geo-map-close');
  const mapEl      = backdrop.querySelector('.geo-map-container');

  let currentLat = lat;
  let currentLon = lon;

  function syncInputs(lt: any, ln: any) {
    currentLat = lt;
    currentLon = ln;
    if (latInput) (latInput as any).value = lt.toFixed(5);
    if (lonInput) (lonInput as any).value = ln.toFixed(5);
  }

  syncInputs(lat, lon);

  // ── Leaflet map ──────────────────────────────────────────────────
  const map = L.map(mapEl, { zoomControl: true }).setView([lat, lon], zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const marker = L.marker([lat, lon], { draggable: !readOnly }).addTo(map);

  if (!readOnly) {
    marker.on('dragend', () => {
      const p = marker.getLatLng();
      syncInputs(p.lat, p.lng);
    });

    map.on('click', (e: any) => {
      marker.setLatLng(e.latlng);
      syncInputs(e.latlng.lat, e.latlng.lng);
    });

    if (latInput) latInput.addEventListener('change', () => {
      const lt = parseFloat((latInput as any).value);
      const ln = parseFloat((lonInput as HTMLInputElement)?.value);
      if (!isNaN(lt) && !isNaN(ln) && lt >= -90 && lt <= 90 && ln >= -180 && ln <= 180) {
        currentLat = lt; currentLon = ln;
        marker.setLatLng([lt, ln]);
        map.panTo([lt, ln]);
      }
    });
    if (lonInput) lonInput.addEventListener('change', () => {
      const lt = parseFloat((latInput as HTMLInputElement)?.value);
      const ln = parseFloat((lonInput as any).value);
      if (!isNaN(lt) && !isNaN(ln) && lt >= -90 && lt <= 90 && ln >= -180 && ln <= 180) {
        currentLat = lt; currentLon = ln;
        marker.setLatLng([lt, ln]);
        map.panTo([lt, ln]);
      }
    });
  }

  // Fix Leaflet layout since element was just mounted
  requestAnimationFrame(() => map.invalidateSize());

  // ── Geolocation button inside modal ─────────────────────────────
  locateBtn?.addEventListener('click', () => {
    if (!navigator.geolocation) {
      (locateBtn as any).title = 'Geolocation not supported by this browser';
      locateBtn.textContent = 'Not supported';
      return;
    }
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      (locateBtn as any).title = 'Geolocation requires HTTPS or localhost';
      locateBtn.textContent = 'Needs HTTPS';
      return;
    }
    (locateBtn as any).disabled = true;
    (locateBtn as any).title = 'Locating…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        (locateBtn as any).disabled = false;
        (locateBtn as any).title = 'Use my current location';
        syncInputs(pos.coords.latitude, pos.coords.longitude);
        marker.setLatLng([currentLat, currentLon]);
        map.setView([currentLat, currentLon], Math.max(map.getZoom(), 10));
      },
      (err) => {
        (locateBtn as any).disabled = false;
        (locateBtn as any).title = err.code === 1 ? 'Permission denied — check browser settings'
                        : err.code === 2 ? 'Position unavailable' : 'Timeout';
      },
      { timeout: 8000, maximumAge: 60000 }
    );
  });

  // ── Close / confirm logic ────────────────────────────────────────
  function close() {
    map.remove();
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e: any) {
    if (e.key === 'Escape') { close(); onCancel?.(); }
  }
  document.addEventListener('keydown', onKey);

  closeBtn?.addEventListener('click', () => { close(); onCancel?.(); });
  cancelBtn?.addEventListener('click', () => { close(); onCancel?.(); });
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) { close(); onCancel?.(); }
  });
  confirmBtn?.addEventListener('click', () => {
    close();
    onConfirm?.({ lat: currentLat, lon: currentLon });
  });
}
