/**
 * Xeno-canto integration panel — API key modal, audio fetch (with CORS proxies),
 * label import, and XC label pool builder.
 *
 * Usage:
 *   import { XenoCantoPanel } from './lib/xc-panel.js';
 *   const xc = new XenoCantoPanel({
 *     backdrop: document.getElementById('xcApiModalBackdrop'),
 *     keyInput: document.getElementById('xcApiKeyInput'),
 *     saveBtn:  document.getElementById('xcApiSaveBtn'),
 *     cancelBtn: document.getElementById('xcApiCancelBtn'),
 *     openBtn:   document.getElementById('xcApiBtn'),
 *   });
 *   // Later:
 *   const auth = xc.getAuthOptions();
 *   const buf  = await xc.fetchAudio('12345');
 */

import { importXenoCantoSpectrogramLabels, normalizeXcId } from '../../src/xenoCantoRecordingsApi.js';

const API_KEY_STORAGE = 'audio-workbench.xc-api-key.v1';

export class XenoCantoPanel {
  /**
   * @param {object} opts
   * @param {HTMLElement}      opts.backdrop
   * @param {HTMLInputElement} opts.keyInput
   * @param {HTMLButtonElement} opts.saveBtn
   * @param {HTMLButtonElement} opts.cancelBtn
   * @param {HTMLButtonElement} [opts.openBtn]
   */
  constructor(opts) {
    this.backdrop = opts.backdrop;
    this.keyInput = opts.keyInput;
    this.saveBtn = opts.saveBtn;
    this.cancelBtn = opts.cancelBtn;
    this.openBtn = opts.openBtn || null;
    this.apiKey = '';
    this._restoreKey();
    this._bindEvents();
    this._updateButtonState();
  }

  open() {
    this.keyInput.value = this.apiKey || '';
    this.backdrop.classList.add('show');
    this.backdrop.setAttribute('aria-hidden', 'false');
    setTimeout(() => this.keyInput.focus(), 0);
  }

  close() {
    this.backdrop.classList.remove('show');
    this.backdrop.setAttribute('aria-hidden', 'true');
  }

  /** @returns {{ apiKey?: string }} Options to spread into XC API calls. */
  getAuthOptions() {
    return this.apiKey ? { apiKey: this.apiKey } : {};
  }

  /**
   * Fetch audio from Xeno-canto using CORS proxies.
   * @param {string} xcId
   * @param {(msg: string) => void} [onStatus] Status callback
   * @returns {Promise<{xcId: string, buffer: ArrayBuffer}>}
   */
  async fetchAudio(xcId, onStatus) {
    const clean = normalizeXcId(xcId);
    if (!clean) throw new Error('Invalid Xeno-canto ID.');

    const directUrl = `https://xeno-canto.org/${clean}/download`;
    const candidates = [
      { name: 'CodeTabs', url: `https://api.codetabs.com/v1/proxy?quest=${directUrl}` },
      { name: 'CorsProxy', url: `https://corsproxy.io/?${encodeURIComponent(directUrl)}` },
      { name: 'AllOrigins', url: `https://api.allorigins.win/raw?url=${encodeURIComponent(directUrl)}` },
      { name: 'ThingProxy', url: `https://thingproxy.freeboard.io/fetch/${directUrl}` },
    ];

    let lastError = null;
    for (const c of candidates) {
      onStatus?.(`Loading XC${clean} (${c.name})...`);
      try {
        const res = await fetch(c.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (!buf || buf.byteLength < 10_000) throw new Error('Response too small to be valid audio.');
        return { xcId: clean, buffer: buf };
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(`Could not download XC${clean}: ${lastError?.message || 'unknown error'}`);
  }

  /**
   * Import spectrogram labels from Xeno-canto.
   * @param {string} xcId
   * @param {number} sampleRate
   * @returns {Promise<{xcId: string, labels: any[], rawLabels: any[], recording: any}>}
   */
  async importLabels(xcId, sampleRate) {
    return importXenoCantoSpectrogramLabels(xcId, {
      sampleRate,
      ...this.getAuthOptions(),
    });
  }

  /**
   * Build a label pool from XC import results for suggestion providers.
   * @param {any} result  Return value from importLabels
   * @returns {Array<{name: string, scientificName: string}>}
   */
  static buildLabelPool(result) {
    const pool = new Map();
    const add = (name, scientificName = '') => {
      const n = String(name || '').trim();
      const s = String(scientificName || '').trim();
      if (!n) return;
      const key = s ? `sci:${s}` : `name:${n.toLowerCase()}`;
      if (!pool.has(key)) pool.set(key, { name: n, scientificName: s });
    };

    const recording = result?.recording || {};
    const recSci = String(
      recording?.gen && recording?.sp ? `${recording.gen} ${recording.sp}` : '',
    ).trim();
    add(recording?.en, recSci);
    add(recSci, recSci);
    add(recording?.type, recSci);

    for (const raw of result?.rawLabels || []) {
      const sci = String(raw?.scientific_name || raw?.scientificName || recSci).trim();
      add(raw?.sound_type || raw?.soundType, sci);
      add(raw?.annotation_remarks || raw?.comment || raw?.description, sci);
      add(raw?.label || raw?.name || raw?.value, sci);
      if (sci) add(sci, sci);
    }

    return Array.from(pool.values());
  }

  // ── Private ─────────────────────────────────────────────────────

  _restoreKey() {
    try { this.apiKey = String(localStorage.getItem(API_KEY_STORAGE) || ''); } catch { /* ignore */ }
  }

  _updateButtonState() {
    if (this.openBtn) this.openBtn.textContent = this.apiKey ? 'XC API ✓' : 'XC API';
  }

  _bindEvents() {
    this.openBtn?.addEventListener('click', () => this.open());
    this.cancelBtn.addEventListener('click', () => this.close());
    this.saveBtn.addEventListener('click', () => {
      this.apiKey = String(this.keyInput.value || '').trim();
      try { localStorage.setItem(API_KEY_STORAGE, this.apiKey); } catch { /* ignore */ }
      this._updateButtonState();
      this.close();
    });
    this.backdrop.addEventListener('click', (e) => {
      if (e.target === this.backdrop) this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.backdrop.classList.contains('show')) this.close();
    });
  }
}
