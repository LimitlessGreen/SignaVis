/**
 * Geo-map modal — Leaflet/OSM picker for recording coordinates.
 *
 * Usage:
 *   import { openMapModal } from './lib/geo-map-modal.js';
 *   openMapModal({ lat: 51.5, lon: 10.2, onConfirm: ({ lat, lon }) => { ... } });
 */

const LEAFLET_VERSION = '1.9.4';
const LEAFLET_CSS = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`;
const LEAFLET_JS  = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js`;

let leafletLoadPromise = null;

function loadLeaflet() {
  if (leafletLoadPromise) return leafletLoadPromise;
  leafletLoadPromise = new Promise((resolve, reject) => {
    if (window.L?.map) { resolve(); return; }

    const link = document.createElement('link');
    link.rel  = 'stylesheet';
    link.href = LEAFLET_CSS;
    document.head.appendChild(link);

    const script = document.createElement('script');
    script.src = LEAFLET_JS;
    script.onload  = resolve;
    script.onerror = () => reject(new Error('Failed to load Leaflet from CDN'));
    document.head.appendChild(script);
  });
  return leafletLoadPromise;
}

/**
 * Open an OSM map modal to pick / confirm a recording location.
 *
 * @param {object}   opts
 * @param {number}   [opts.lat=51]   Initial latitude.
 * @param {number}   [opts.lon=10]   Initial longitude.
 * @param {number}   [opts.zoom=6]   Initial zoom level.
 * @param {(result: {lat:number, lon:number}) => void} opts.onConfirm  Called on "Confirm".
 * @param {() => void} [opts.onCancel]  Called on "Cancel" / backdrop click / Escape.
 */
export async function openMapModal({ lat = 51, lon = 10, zoom = 6, onConfirm, onCancel }) {
  await loadLeaflet();

  const L = window.L;

  // ── Build modal DOM ──────────────────────────────────────────────
  const backdrop = document.createElement('div');
  backdrop.className = 'geo-map-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', 'Recording location');

  backdrop.innerHTML = `
    <div class="geo-map-modal">
      <div class="geo-map-header">
        <span class="geo-map-title">Recording Location</span>
        <button class="geo-map-close" type="button" aria-label="Close">×</button>
      </div>
      <div class="geo-map-coord-bar">
        <label class="geo-map-coord-label">
          <span>Lat</span>
          <input class="input geo-map-lat-input" type="number" step="0.0001" min="-90"  max="90" />
        </label>
        <label class="geo-map-coord-label">
          <span>Lon</span>
          <input class="input geo-map-lon-input" type="number" step="0.0001" min="-180" max="180" />
        </label>
        <button class="geo-map-locate-btn tb-btn" type="button" title="Use my current location">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/></svg>
          Locate
        </button>
      </div>
      <div class="geo-map-container"></div>
      <div class="geo-map-attribution-hint">Click or drag marker to set location · © OpenStreetMap contributors</div>
      <div class="geo-map-footer">
        <button class="sidebar-action-btn geo-map-btn-secondary" type="button">Cancel</button>
        <button class="sidebar-action-btn geo-map-btn-confirm" type="button">Confirm Location</button>
      </div>
    </div>
  `;

  document.body.appendChild(backdrop);

  const latInput   = backdrop.querySelector('.geo-map-lat-input');
  const lonInput   = backdrop.querySelector('.geo-map-lon-input');
  const locateBtn  = backdrop.querySelector('.geo-map-locate-btn');
  const cancelBtn  = backdrop.querySelector('.geo-map-btn-secondary');
  const confirmBtn = backdrop.querySelector('.geo-map-btn-confirm');
  const closeBtn   = backdrop.querySelector('.geo-map-close');
  const mapEl      = backdrop.querySelector('.geo-map-container');

  let currentLat = lat;
  let currentLon = lon;

  function syncInputs(lt, ln) {
    currentLat = lt;
    currentLon = ln;
    latInput.value = lt.toFixed(5);
    lonInput.value = ln.toFixed(5);
  }

  syncInputs(lat, lon);

  // ── Leaflet map ──────────────────────────────────────────────────
  const map = L.map(mapEl, { zoomControl: true }).setView([lat, lon], zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const marker = L.marker([lat, lon], { draggable: true }).addTo(map);

  marker.on('dragend', () => {
    const p = marker.getLatLng();
    syncInputs(p.lat, p.lng);
  });

  map.on('click', (e) => {
    marker.setLatLng(e.latlng);
    syncInputs(e.latlng.lat, e.latlng.lng);
  });

  function applyInputs() {
    const lt = parseFloat(latInput.value);
    const ln = parseFloat(lonInput.value);
    if (!isNaN(lt) && !isNaN(ln) && lt >= -90 && lt <= 90 && ln >= -180 && ln <= 180) {
      currentLat = lt;
      currentLon = ln;
      marker.setLatLng([lt, ln]);
      map.panTo([lt, ln]);
    }
  }
  latInput.addEventListener('change', applyInputs);
  lonInput.addEventListener('change', applyInputs);

  // Fix Leaflet layout since element was just mounted
  requestAnimationFrame(() => map.invalidateSize());

  // ── Geolocation button inside modal ─────────────────────────────
  locateBtn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      locateBtn.title = 'Geolocation not supported by this browser';
      locateBtn.textContent = 'Not supported';
      return;
    }
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      locateBtn.title = 'Geolocation requires HTTPS or localhost';
      locateBtn.textContent = 'Needs HTTPS';
      return;
    }
    locateBtn.disabled = true;
    locateBtn.title = 'Locating…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        locateBtn.disabled = false;
        locateBtn.title = 'Use my current location';
        syncInputs(pos.coords.latitude, pos.coords.longitude);
        marker.setLatLng([currentLat, currentLon]);
        map.setView([currentLat, currentLon], Math.max(map.getZoom(), 10));
      },
      (err) => {
        locateBtn.disabled = false;
        locateBtn.title = err.code === 1 ? 'Permission denied — check browser settings'
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

  function onKey(e) {
    if (e.key === 'Escape') { close(); onCancel?.(); }
  }
  document.addEventListener('keydown', onKey);

  closeBtn.addEventListener('click', () => { close(); onCancel?.(); });
  cancelBtn.addEventListener('click', () => { close(); onCancel?.(); });
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) { close(); onCancel?.(); }
  });
  confirmBtn.addEventListener('click', () => {
    close();
    onConfirm?.({ lat: currentLat, lon: currentLon });
  });
}
