/**
 * Xeno-canto integration panel — audio fetch (with CORS proxies), label import,
 * recording metadata display, annotation set management, XC API upload,
 * and XC-format JSON export.
 */

import { importXenoCantoSpectrogramLabels, normalizeXcId } from '../../src/xenoCantoRecordingsApi.js';
import ModalManager from '../../src/modal-manager.js';

const API_KEY_STORAGE = 'audio-workbench.xc-api-key.v1';
const SET_META_STORAGE = 'audio-workbench.xc-set-meta.v1';
const XC_UPLOAD_ENDPOINT = 'https://xeno-canto.org/api/3/upload/annotation-set';

// ── Recording metadata field definitions ─────────────────────────────

const RECORDING_FIELDS = [
  { key: 'recordist',  label: 'Recordist' },
  { key: 'country',    label: 'Country' },
  { key: 'locality',   label: 'Locality' },
  { key: 'date',       label: 'Date' },
  { key: 'time',       label: 'Time' },
  { key: 'quality',    label: 'Quality' },
  { key: 'license',    label: 'License' },
  { key: 'lat',        label: 'Lat' },
  { key: 'lng',        label: 'Lng' },
  { key: 'alt',        label: 'Altitude' },
  { key: 'method',     label: 'Method' },
  { key: 'animalSeen', label: 'Animal seen' },
  { key: 'playbackUsed', label: 'Playback used' },
  { key: 'backgroundSpecies', label: 'Background spp.' },
  { key: 'remarks',    label: 'Remarks' },
];

// ── Annotation set license options ───────────────────────────────────

const SET_LICENSES = [
  '',
  'CC-BY-4.0',
  'CC-BY-NC-4.0',
  'CC-BY-SA-4.0',
  'CC-BY-NC-SA-4.0',
  'CC0-1.0',
];

export class XenoCantoPanel {
  /**
   * @param {object} opts
   * @param {HTMLInputElement} opts.keyInput
   * @param {HTMLButtonElement} opts.saveBtn
   * @param {HTMLElement}      [opts.backdrop]
   * @param {HTMLButtonElement} [opts.cancelBtn]
   * @param {HTMLButtonElement} [opts.openBtn]
   * @param {HTMLElement}      [opts.recordingMetaEl]  Container for recording metadata
   * @param {HTMLElement}      [opts.setMetaEl]        Container for annotation set form
   * @param {HTMLElement}      [opts.uploadBtn]        Upload to XC button
   * @param {HTMLElement}      [opts.exportSetBtn]     Export XC JSON button
   * @param {HTMLElement}      [opts.statusEl]         Status message element
   */
  constructor(opts) {
    this.backdrop = opts.backdrop || null;
    this.keyInput = opts.keyInput;
    this.saveBtn = opts.saveBtn;
    this.cancelBtn = opts.cancelBtn || null;
    this.openBtn = opts.openBtn || null;
    this.recordingMetaEl = opts.recordingMetaEl || null;
    this.setMetaEl = opts.setMetaEl || null;
    this.uploadBtn = opts.uploadBtn || null;
    this.exportSetBtn = opts.exportSetBtn || null;
    this.statusEl = opts.statusEl || null;

    this._modal = this.backdrop ? new ModalManager({ backdrop: this.backdrop }) : null;

    /** @type {boolean} */
    this.useProxies = (typeof opts.useProxies === 'boolean')
      ? opts.useProxies
      : (() => {
        try {
          const v = localStorage.getItem('aw:xcUseProxies');
          if (v != null) return v === '1' || v === 'true';
        } catch (e) { /**/ }
        // Preserve previous behavior by default (proxies enabled)
        return true;
      })();

    /** @type {string} */
    this.apiKey = '';
    /** @type {string|null} Current XC recording ID */
    this.xcId = null;
    /** @type {object|null} Recording metadata from XC API */
    this.recordingMeta = null;
    /** @type {object} Annotation set metadata (editable) */
    this.setMeta = { setName: '', setCreator: '', setLicense: '', projectName: '', scope: '' };

    /** @type {((apiKey: string) => void)|null} */
    this.onKeyChange = null;

    this._restoreKey();
    this._restoreSetMeta();
    this._bindEvents();
    this._updateButtonState();
    if (this.setMetaEl) this._buildSetMetaForm();
  }

  open() {
    if (this._modal) {
      this.keyInput.value = this.apiKey || '';
      this._modal.open();
      return;
    }
    if (!this.backdrop) return;
    this.keyInput.value = this.apiKey || '';
    this.backdrop.classList.add('show');
    this.backdrop.setAttribute('aria-hidden', 'false');
    setTimeout(() => this.keyInput.focus(), 0);
  }

  close() {
    if (this._modal) {
      this._modal.close();
      return;
    }
    if (!this.backdrop) return;
    this.backdrop.classList.remove('show');
    this.backdrop.setAttribute('aria-hidden', 'true');
  }

  /** @returns {{ apiKey?: string }} Options to spread into XC API calls. */
  getAuthOptions() {
    return this.apiKey ? { apiKey: this.apiKey } : {};
  }

  // ── Audio & Label fetching ──────────────────────────────────────────

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

    // First, try direct download from Xeno-canto
    let lastError = null;
    try {
      onStatus?.(`Loading XC${clean} (Direct)...`);
      const res = await fetch(directUrl);
      if (res.ok) {
        const buf = await res.arrayBuffer();
        if (buf && buf.byteLength >= 10_000) {
          return { xcId: clean, buffer: buf };
        }
        lastError = new Error('Direct response too small to be valid audio.');
      } else {
        lastError = new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      lastError = err;
    }

    // If proxies are disabled, fail now
    if (!this.useProxies) {
      throw new Error(`Could not download XC${clean} directly: ${lastError?.message || 'unknown error'}`);
    }

    // Fallback: try list of public CORS proxies
    const candidates = [
      { name: 'CodeTabs', url: `https://api.codetabs.com/v1/proxy?quest=${directUrl}` },
      { name: 'CorsProxy', url: `https://corsproxy.io/?${encodeURIComponent(directUrl)}` },
      { name: 'AllOrigins', url: `https://api.allorigins.win/raw?url=${encodeURIComponent(directUrl)}` },
      { name: 'ThingProxy', url: `https://thingproxy.freeboard.io/fetch/${directUrl}` },
    ];

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
   * Also stores the recording metadata for display.
   * @param {string} xcId
   * @param {number} sampleRate
   * @returns {Promise<{xcId: string, labels: any[], rawLabels: any[], recording: any, recordingMeta: object}>}
   */
  async importLabels(xcId, sampleRate) {
    const result = await importXenoCantoSpectrogramLabels(xcId, {
      sampleRate,
      ...this.getAuthOptions(),
    });
    this.xcId = result.xcId;
    this.recordingMeta = result.recordingMeta || null;
    this.renderRecordingMeta();
    this._updateUploadState();
    return result;
  }

  // ── Recording metadata display ──────────────────────────────────────

  /**
   * Populate the recording metadata container (read-only display).
   * @param {object} [meta] Optional override; defaults to this.recordingMeta
   */
  renderRecordingMeta(meta) {
    const el = this.recordingMetaEl;
    if (!el) return;
    const m = meta || this.recordingMeta;
    el.innerHTML = '';
    if (!m || Object.keys(m).length === 0) {
      el.innerHTML = '<div class="field-hint" style="padding:6px 0">No recording loaded.</div>';
      return;
    }
    const dl = document.createElement('dl');
    dl.className = 'xc-meta-grid';
    for (const { key, label } of RECORDING_FIELDS) {
      const val = m[key];
      if (!val) continue;
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = val;
      if (key === 'quality') dd.textContent = `${val}/E`;
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    el.appendChild(dl);
  }

  // ── Annotation set form ─────────────────────────────────────────────

  /** Build the annotation set metadata form inside setMetaEl. */
  _buildSetMetaForm() {
    const el = this.setMetaEl;
    if (!el) return;
    el.innerHTML = '';

    const fields = [
      { key: 'setName', label: 'Set Name', type: 'input', placeholder: 'My annotation set' },
      { key: 'setCreator', label: 'Creator', type: 'input', placeholder: 'Your name' },
      { key: 'setLicense', label: 'License', type: 'select', options: SET_LICENSES },
      { key: 'projectName', label: 'Project', type: 'input', placeholder: '(optional)' },
      { key: 'scope', label: 'Scope', type: 'select', options: ['', 'all sounds', 'target species', 'partial'] },
    ];

    for (const f of fields) {
      const wrap = document.createElement('div');
      wrap.className = 'set-meta-field';
      const lbl = document.createElement('label');
      lbl.className = 'field-label';
      lbl.textContent = f.label;
      wrap.appendChild(lbl);

      /** @type {HTMLInputElement|HTMLSelectElement} */
      let input;
      if (f.type === 'select') {
        input = document.createElement('select');
        input.className = 'field-select';
        for (const opt of f.options) {
          const o = document.createElement('option');
          o.value = opt;
          o.textContent = opt || '— choose —';
          input.appendChild(o);
        }
      } else {
        input = document.createElement('input');
        input.className = 'input';
        input.placeholder = f.placeholder || '';
      }
      input.value = this.setMeta[f.key] || '';
      input.addEventListener('change', () => {
        this.setMeta[f.key] = input.value.trim();
        this._saveSetMeta();
      });
      input.addEventListener('input', () => {
        this.setMeta[f.key] = input.value.trim();
      });
      wrap.appendChild(input);
      el.appendChild(wrap);
    }
  }

  /** Read set meta values from form DOM (in case of direct edits). */
  _readSetMetaFromForm() {
    if (!this.setMetaEl) return;
    const inputs = this.setMetaEl.querySelectorAll('input, select');
    const keys = ['setName', 'setCreator', 'setLicense', 'projectName', 'scope'];
    inputs.forEach((inp, i) => {
      if (keys[i]) this.setMeta[keys[i]] = inp.value.trim();
    });
  }

  // ── XC annotation set payload ───────────────────────────────────────

  /**
   * Build an XC annotation set JSON payload from current labels.
   * @param {any[]} labels  Current label array from state
   * @returns {object} XC API-compatible annotation set payload
   */
  buildAnnotationSetPayload(labels) {
    this._readSetMetaFromForm();
    const sm = this.setMeta;
    const xcNr = this.xcId || '';

    const annotations = (labels || [])
      .filter(l => l.start != null && l.end != null)
      .map((l, i) => ({
        annotation_source_id: String(i + 1),
        xc_nr: xcNr,
        annotator: l.author || sm.setCreator || '',
        annotator_xc_id: '',
        start_time: Number(l.start).toFixed(6),
        end_time: Number(l.end).toFixed(6),
        frequency_low: Number(l.freqMin || 0).toFixed(1),
        frequency_high: Number(l.freqMax || 0).toFixed(1),
        scientific_name: l.scientificName || '',
        sound_type: l.tags?.soundType || '',
        date_identified: '',
        sex: l.tags?.sex || '',
        life_stage: l.tags?.lifeStage || '',
        animal_seen: l.tags?.animalSeen || '',
        playback_used: l.tags?.playbackUsed || '',
        collection_date: '',
        collection_specimen: '',
        temperature: '',
        annotation_remarks: l.tags?.remarks || '',
        overlap: '',
      }));

    return {
      set_source: '',
      set_uri: '',
      set_name: sm.setName || `Audio Workbench annotations ${new Date().toISOString().slice(0, 16)}`,
      annotation_software_name_and_version: 'Audio Workbench',
      set_creator: sm.setCreator || '',
      set_creator_id: '',
      set_owner: '',
      set_license: sm.setLicense || '',
      project_uri: '',
      project_name: sm.projectName || '',
      funding: '',
      scope: [{ taxon_coverage: sm.scope || '', completeness: '' }],
      annotations,
    };
  }

  // ── Upload to XC API ────────────────────────────────────────────────

  /**
   * Upload annotations to Xeno-canto API.
   * @param {any[]} labels Current label array
   * @param {(msg: string) => void} [onStatus]
   * @returns {Promise<{ok: boolean, message: string, warnings?: string[], errors?: string[]}>}
   */
  async uploadToXenoCanto(labels, onStatus) {
    if (!this.apiKey) throw new Error('API key required. Save your key first.');
    if (!this.xcId) throw new Error('No XC recording loaded.');
    if (!labels?.length) throw new Error('No labels to upload.');

    const payload = this.buildAnnotationSetPayload(labels);
    onStatus?.('Uploading to Xeno-canto…');

    const res = await fetch(XC_UPLOAD_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'key': this.apiKey,
      },
      body: JSON.stringify(payload),
    });

    let body;
    try { body = await res.json(); } catch { body = { message: await res.text().catch(() => 'Unknown response') }; }

    if (!res.ok) {
      return {
        ok: false,
        message: body?.message || `HTTP ${res.status}`,
        warnings: body?.warnings || [],
        errors: body?.errors || [body?.error || `Upload failed (HTTP ${res.status})`],
      };
    }

    return {
      ok: true,
      message: body?.message || 'Upload successful',
      warnings: body?.warnings || [],
      errors: body?.errors || [],
    };
  }

  /**
   * Export annotation set as JSON file download.
   * @param {any[]} labels Current label array
   */
  exportAnnotationSetJSON(labels) {
    const payload = this.buildAnnotationSetPayload(labels);
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const name = this.xcId ? `XC${this.xcId}_annotation_set.json` : 'annotation_set.json';
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ── Status helpers ──────────────────────────────────────────────────

  _setStatus(msg, type = 'info') {
    if (!this.statusEl) return;
    this.statusEl.textContent = msg;
    this.statusEl.className = `xc-status xc-status-${type}`;
    this.statusEl.style.display = msg ? '' : 'none';
  }

  _updateUploadState() {
    if (this.uploadBtn) {
      this.uploadBtn.disabled = !this.apiKey || !this.xcId;
    }
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

  _restoreSetMeta() {
    try {
      const data = JSON.parse(localStorage.getItem(SET_META_STORAGE) || '{}');
      if (data && typeof data === 'object') {
        for (const k of ['setName', 'setCreator', 'setLicense', 'projectName', 'scope']) {
          if (data[k]) this.setMeta[k] = data[k];
        }
      }
    } catch { /* ignore */ }
  }

  _saveSetMeta() {
    try { localStorage.setItem(SET_META_STORAGE, JSON.stringify(this.setMeta)); } catch { /* ignore */ }
  }

  _updateButtonState() {
    if (this.openBtn) this.openBtn.textContent = this.apiKey ? 'XC API ✓' : 'XC API';
  }

  _bindEvents() {
    this.openBtn?.addEventListener('click', () => this.open());
    this.cancelBtn?.addEventListener('click', () => this.close());
    this.saveBtn?.addEventListener('click', () => {
      this.apiKey = String(this.keyInput?.value || '').trim();
      try { localStorage.setItem(API_KEY_STORAGE, this.apiKey); } catch { /* ignore */ }
      this._updateButtonState();
      this._updateUploadState();
      this.onKeyChange?.(this.apiKey);
      if (this.backdrop) {
        this.close();
      } else if (this.saveBtn) {
        const orig = this.saveBtn.textContent;
        this.saveBtn.textContent = '✓ Saved';
        setTimeout(() => { this.saveBtn.textContent = orig; }, 1200);
      }
    });
    // Backdrop clicks and global Escape handler are managed by ModalManager when provided.
  }

  dispose() {
    this._modal?.dispose();
  }
}
