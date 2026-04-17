/**
 * Xeno-canto integration panel — audio fetch (with CORS proxies), label import,
 * recording metadata display, annotation set management, XC API upload,
 * and XC-format JSON export.
 */

import { importXenoCantoSpectrogramLabels, normalizeXcId } from '../../src/xenoCantoRecordingsApi.js';
import ModalManager from '../../src/modal-manager.js';
import { openMapModal } from './geo-map-modal.js';

const API_KEY_STORAGE     = 'audio-workbench.xc-api-key.v1';
const SET_META_STORAGE    = 'audio-workbench.xc-set-meta.v2';
// Profile fields that are auto-saved per manual set (persisted by labeling-app.html)
const LABELER_PROFILE_FIELDS = ['creator', 'creatorId', 'license', 'owner'];
const XC_UPLOAD_ENDPOINT = 'https://xeno-canto.org/api/3/upload/annotation-set';

// ── Read-only recording metadata (from XC API) ──────────────────────

const RECORDING_FIELDS_READONLY = [
  { key: 'recordist',          label: 'Recordist' },
  { key: 'country',            label: 'Country' },
  { key: 'locality',           label: 'Locality' },
  { key: 'date',               label: 'Date' },
  { key: 'time',               label: 'Time' },
  { key: 'quality',            label: 'Quality' },
  { key: 'license',            label: 'License' },
  { key: 'lat',                label: 'Lat' },
  { key: 'lng',                label: 'Lng' },
  { key: 'alt',                label: 'Altitude' },
  { key: 'method',             label: 'Method' },
  { key: 'animalSeen',         label: 'Animal seen' },
  { key: 'playbackUsed',       label: 'Playback used' },
  { key: 'backgroundSpecies',  label: 'Background spp.' },
  { key: 'remarks',            label: 'Remarks' },
];

// ── Editable recording metadata (user-supplied for upload context) ──

/** @type {Array<{key:string, label:string, type?:string, placeholder?:string, hint?:string, options?:string[]}>} */
export const RECORDING_EDIT_FIELDS = [
  { key: 'lat',          label: 'Latitude',          type: 'text', placeholder: 'e.g. 51.5074' },
  { key: 'lng',          label: 'Longitude',         type: 'text', placeholder: 'e.g. -0.1278' },
  { key: 'dateTime',     label: 'Date & Time',       type: 'datetime-local' },
  { key: 'rating',       label: 'Rating',            type: 'select', options: ['', 'A', 'B', 'C', 'D', 'E'] },
  { key: 'type',         label: 'Type of recording', type: 'text', placeholder: 'e.g. song, call, alarm call' },
  { key: 'targetSpecies',label: 'Target species',    type: 'text', placeholder: 'Common name' },
  { key: 'recorder',     label: 'Recorder',          type: 'text', placeholder: 'Make / model / Smartphone' },
  { key: 'microphone',   label: 'Microphone',        type: 'text', placeholder: 'Make / model' },
  { key: 'accessories',  label: 'Accessories',       type: 'text', placeholder: 'e.g. windscreen, preamp, parabola' },
  { key: 'contributors', label: 'Contributors',      type: 'text', placeholder: 'Names, comma-separated' },
  { key: 'comments',     label: 'Comments',          type: 'textarea', placeholder: 'Overall recording comments' },
];

/** Default shape of editable recording metadata. */
export function defaultRecordingEditMeta() {
  const m = {};
  for (const f of RECORDING_EDIT_FIELDS) m[f.key] = '';
  return m;
}

// ── Set license options ──────────────────────────────────────────────

const SET_LICENSES = [
  '',
  'CC-BY-4.0',
  'CC-BY-NC-4.0',
  'CC-BY-SA-4.0',
  'CC-BY-NC-SA-4.0',
  'CC0-1.0',
];

// ── Set metadata field groups ────────────────────────────────────────

const SET_FIELD_GROUPS = [
  {
    label: null, // top-level, no group header
    fields: [
      { key: 'name',      label: 'Set Name',     type: 'text',   required: true,  placeholder: 'My annotation set' },
      { key: 'license',   label: 'License',      type: 'select', options: SET_LICENSES },
      { key: 'creator',   label: 'Creator',      type: 'text',   placeholder: 'Your name' },
      { key: 'creatorId', label: 'Creator ID',   type: 'text',   placeholder: 'XC username (optional)' },
      { key: 'owner',     label: 'Owner',        type: 'text',   placeholder: 'Organisation / person' },
      { key: 'source',    label: 'Set Source',   type: 'text',   placeholder: 'Origin description' },
      { key: 'uri',       label: 'Set URI',      type: 'text',   placeholder: 'https://…' },
    ],
  },
  {
    label: 'Project',
    fields: [
      { key: 'projectName', label: 'Project Name', type: 'text', placeholder: '(optional)' },
      { key: 'projectUri',  label: 'Project URI',  type: 'text', placeholder: 'https://…' },
      { key: 'funding',     label: 'Funding',      type: 'text', placeholder: 'Grant / organisation' },
    ],
  },
  {
    label: 'Scope',
    fields: [
      {
        key: 'taxonCoverage', label: 'Taxon Coverage', type: 'select',
        options: ['', 'all sounds', 'target species', 'partial'],
      },
      { key: 'completeness', label: 'Completeness', type: 'text', placeholder: 'e.g. complete, partial' },
    ],
  },
];

/** Default shape of a set — all fields present. */
export function defaultSetInfo(partial = {}) {
  return {
    id: '',
    origin: 'manual',
    name: '',
    license: '',
    creator: '',
    creatorId: '',
    owner: '',
    source: '',
    uri: '',
    createdOn: new Date().toISOString(),
    projectName: '',
    projectUri: '',
    funding: '',
    taxonCoverage: '',
    completeness: '',
    ...partial,
  };
}

// ── Helper: build a dt/dd pair for use inside a props-grid <dl> ──────

function buildField(f, value, onChange) {
  const dt = document.createElement('dt');
  dt.textContent = f.label + (f.required ? ' *' : '');

  const dd = document.createElement('dd');
  dd.classList.add('props-editable');

  let input;
  if (f.type === 'select') {
    input = document.createElement('select');
    input.className = 'props-select';
    for (const opt of (f.options || [])) {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt || '— choose —';
      input.appendChild(o);
    }
  } else if (f.type === 'textarea') {
    input = document.createElement('textarea');
    input.className = 'props-input';
    input.placeholder = f.placeholder || '';
    input.rows = 3;
    input.style.cssText = 'height:auto;resize:vertical;min-height:44px;width:100%';
  } else {
    input = document.createElement('input');
    input.type = f.type || 'text';
    input.className = 'props-input';
    input.placeholder = f.placeholder || '';
  }
  input.value = value ?? '';
  input.addEventListener('input', () => onChange(input.value));
  input.addEventListener('change', () => onChange(input.value.trim()));
  dd.appendChild(input);
  return { dt, dd, input };
}

// ── Collapsible section helper ────────────────────────────────────────

function buildCollapsible(label, contentFn, { expanded = false } = {}) {
  const sec = document.createElement('div');
  sec.className = 'xc-collapsible' + (expanded ? ' expanded' : '');

  const hdr = document.createElement('button');
  hdr.type = 'button';
  hdr.className = 'xc-collapsible-hdr';
  hdr.innerHTML = `<span class="xc-collapsible-chevron">▸</span> ${label}`;
  sec.appendChild(hdr);

  const body = document.createElement('div');
  body.className = 'xc-collapsible-body';
  body.hidden = !expanded;
  if (expanded) body.appendChild(contentFn());
  let built = expanded;
  sec.appendChild(body);

  hdr.addEventListener('click', () => {
    const open = !body.hidden;
    body.hidden = open;
    sec.classList.toggle('expanded', !open);
    if (!open && !built) { built = true; body.appendChild(contentFn()); }
  });
  return sec;
}

// ────────────────────────────────────────────────────────────────────

export class XenoCantoPanel {
  /**
   * @param {object} opts
   * @param {HTMLInputElement}   opts.keyInput
   * @param {HTMLButtonElement}  opts.saveBtn
   * @param {HTMLElement}       [opts.backdrop]
   * @param {HTMLButtonElement} [opts.cancelBtn]
   * @param {HTMLButtonElement} [opts.openBtn]
   * @param {HTMLElement}       [opts.recordingMetaEl]     Read-only recording metadata container
   * @param {HTMLElement}       [opts.recordingEditEl]     Editable recording metadata container
   * @param {HTMLElement}       [opts.setContainerEl]      Container for set selector + form
   * @param {HTMLElement}       [opts.uploadBtn]
   * @param {HTMLElement}       [opts.exportSetBtn]
   * @param {HTMLElement}       [opts.statusEl]
   * @param {() => Map<string,object>}       [opts.getLabelSets]
   * @param {(setId:string, updates:object) => void} [opts.onSetChange]
   * @param {(partial:object) => object}    [opts.onCreateSet]
   * @param {() => object}                  [opts.getRecordingEditMeta]
   * @param {(updates:object) => void}      [opts.onRecordingEditMetaChange]
   */
  constructor(opts) {
    this.backdrop         = opts.backdrop || null;
    this.keyInput         = opts.keyInput;
    this.saveBtn          = opts.saveBtn;
    this.cancelBtn        = opts.cancelBtn || null;
    this.openBtn          = opts.openBtn || null;
    this.recordingMetaEl  = opts.recordingMetaEl || null;
    this.recordingEditEl  = opts.recordingEditEl || null;
    this.setContainerEl   = opts.setContainerEl || null;
    this.uploadBtn        = opts.uploadBtn || null;
    this.exportSetBtn     = opts.exportSetBtn || null;
    this.statusEl         = opts.statusEl || null;

    // External state callbacks
    this._getLabelSets             = opts.getLabelSets || null;
    this._onSetChange              = opts.onSetChange || null;
    this._onCreateSet              = opts.onCreateSet || null;
    this._getRecordingEditMeta     = opts.getRecordingEditMeta || null;
    this._onRecordingEditMetaChange = opts.onRecordingEditMetaChange || null;

    this._modal = this.backdrop ? new ModalManager({ backdrop: this.backdrop }) : null;

    this.useProxies = (typeof opts.useProxies === 'boolean')
      ? opts.useProxies
      : (() => {
        try { const v = localStorage.getItem('aw:xcUseProxies'); if (v != null) return v === '1' || v === 'true'; } catch {}
        return true;
      })();

    /** @type {string} */
    this.apiKey = '';
    /** @type {string|null} */
    this.xcId = null;
    /** @type {object|null} */
    this.recordingMeta = null;

    /** Fallback set metadata (used when no state.labelSets is available) */
    this.setMeta = defaultSetInfo();

    /** Currently selected set id (for upload/export) — null = all labels regardless of set */
    this._activeSetId = null;

    /** @type {((apiKey: string) => void)|null} */
    this.onKeyChange = null;

    this._restoreKey();
    this._restoreSetMeta();
    this._bindEvents();
    this._updateButtonState();
    this._buildSetSection();
    // Recording edit section is built lazily (hidden by default)
  }

  open() {
    if (this._modal) { this.keyInput.value = this.apiKey || ''; this._modal.open(); return; }
    if (!this.backdrop) return;
    this.keyInput.value = this.apiKey || '';
    this.backdrop.classList.add('show');
    this.backdrop.setAttribute('aria-hidden', 'false');
    setTimeout(() => this.keyInput.focus(), 0);
  }

  close() {
    if (this._modal) { this._modal.close(); return; }
    if (!this.backdrop) return;
    this.backdrop.classList.remove('show');
    this.backdrop.setAttribute('aria-hidden', 'true');
  }

  getAuthOptions() { return this.apiKey ? { apiKey: this.apiKey } : {}; }

  // ── Audio fetching ──────────────────────────────────────────────────

  async fetchAudio(xcId, onStatus) {
    const clean = normalizeXcId(xcId);
    if (!clean) throw new Error('Invalid Xeno-canto ID.');
    const directUrl = `https://xeno-canto.org/${clean}/download`;
    let lastError = null;
    try {
      onStatus?.(`Loading XC${clean} (Direct)...`);
      const res = await fetch(directUrl);
      if (res.ok) {
        const buf = await res.arrayBuffer();
        if (buf && buf.byteLength >= 10_000) return { xcId: clean, buffer: buf };
        lastError = new Error('Direct response too small to be valid audio.');
      } else { lastError = new Error(`HTTP ${res.status}`); }
    } catch (err) { lastError = err; }
    if (!this.useProxies) throw new Error(`Could not download XC${clean} directly: ${lastError?.message || 'unknown error'}`);
    const candidates = [
      { name: 'CodeTabs',   url: `https://api.codetabs.com/v1/proxy?quest=${directUrl}` },
      { name: 'CorsProxy',  url: `https://corsproxy.io/?${encodeURIComponent(directUrl)}` },
      { name: 'AllOrigins', url: `https://api.allorigins.win/raw?url=${encodeURIComponent(directUrl)}` },
      { name: 'ThingProxy', url: `https://thingproxy.freeboard.io/fetch/${directUrl}` },
    ];
    for (const c of candidates) {
      onStatus?.(`Loading XC${clean} (${c.name})...`);
      try {
        const res = await fetch(c.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (!buf || buf.byteLength < 10_000) throw new Error('Response too small.');
        return { xcId: clean, buffer: buf };
      } catch (err) { lastError = err; }
    }
    throw new Error(`Could not download XC${clean}: ${lastError?.message || 'unknown error'}`);
  }

  // ── Label import ────────────────────────────────────────────────────

  async importLabels(xcId, sampleRate) {
    const result = await importXenoCantoSpectrogramLabels(xcId, { sampleRate, ...this.getAuthOptions() });
    this.xcId = result.xcId;
    this.recordingMeta = result.recordingMeta || null;
    this.renderRecordingMeta();
    this._syncRecordingEditFromMeta();
    this._rebuildSetSection();
    this._updateUploadState();
    return result;
  }

  // ── Recording metadata display ──────────────────────────────────────

  renderRecordingMeta(meta) {
    const el = this.recordingMetaEl;
    if (!el) return;
    const m = meta || this.recordingMeta;
    el.innerHTML = '';
    if (!m || !Object.keys(m).length) {
      el.innerHTML = '<div class="field-hint" style="padding:4px 0">No recording loaded.</div>';
      return;
    }
    const dl = document.createElement('dl');
    dl.className = 'props-grid';
    for (const { key, label } of RECORDING_FIELDS_READONLY) {
      const val = m[key];
      if (!val) continue;
      const dt = document.createElement('dt'); dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = key === 'quality' ? `${val}/E` : val;
      dl.appendChild(dt); dl.appendChild(dd);
    }
    el.appendChild(dl);
  }

  // Pre-fill editable recording meta from the XC API data (lat/lng/date/time/type)
  _syncRecordingEditFromMeta() {
    if (!this._onRecordingEditMetaChange || !this.recordingMeta) return;
    const m = this.recordingMeta;
    const updates = {};
    if (m.lat)  updates.lat = String(m.lat);
    if (m.lng)  updates.lng = String(m.lng);
    if (m.date || m.time) {
      const d = (m.date || '').replace(/\//g, '-');
      const t = (m.time || '00:00').slice(0, 5);
      if (d) updates.dateTime = `${d}T${t}`;
    }
    if (m.type)      updates.type = m.type;
    if (m.recordist) updates.recorder = m.recordist;
    if (Object.keys(updates).length) this._onRecordingEditMetaChange(updates);
    this._buildRecordingEditSection();
  }

  // ── Editable recording metadata section ────────────────────────────

  _buildRecordingEditSection() {
    const el = this.recordingEditEl;
    if (!el) return;
    el.innerHTML = '';
    const meta = this._getRecordingEditMeta?.() || {};
    const dl = document.createElement('dl');
    dl.className = 'props-grid';

    // Keep references to lat/lng inputs for cross-field map interaction
    let latInput = null, lngInput = null;

    for (const f of RECORDING_EDIT_FIELDS) {
      const { dt, dd, input } = buildField(f, meta[f.key] || '', (val) => {
        this._onRecordingEditMetaChange?.({ [f.key]: val });
      });
      if (f.key === 'lat') latInput = input;
      if (f.key === 'lng') lngInput = input;
      dl.appendChild(dt);
      dl.appendChild(dd);
    }

    // Map button row — opens map modal, writes both lat and lng on confirm
    const mapRow = document.createElement('div');
    mapRow.className = 'props-map-row';
    const mapBtn = document.createElement('button');
    mapBtn.type = 'button';
    mapBtn.className = 'sidebar-action-btn secondary props-map-open-btn';
    mapBtn.innerHTML = '🗺&nbsp;Pick on Map';
    mapBtn.addEventListener('click', () => {
      const lat = parseFloat(latInput?.value) || 51;
      const lon = parseFloat(lngInput?.value) || 10;
      openMapModal({
        lat: isFinite(lat) ? lat : 51,
        lon: isFinite(lon) ? lon : 10,
        zoom: (isFinite(lat) && isFinite(lon)) ? 10 : 5,
        onConfirm: ({ lat: lt, lon: ln }) => {
          if (latInput) { latInput.value = lt.toFixed(5); latInput.dispatchEvent(new Event('change')); }
          if (lngInput) { lngInput.value = ln.toFixed(5); lngInput.dispatchEvent(new Event('change')); }
          this._onRecordingEditMetaChange?.({ lat: String(lt.toFixed(5)), lng: String(ln.toFixed(5)) });
        },
      });
    });
    mapRow.appendChild(mapBtn);
    el.appendChild(dl);
    el.appendChild(mapRow);
  }

  // ── Set section: selector + form ────────────────────────────────────

  _buildSetSection() {
    const el = this.setContainerEl;
    if (!el) return;
    el.innerHTML = '';

    const sets = this._getLabelSets?.() || new Map();
    const hasExternalSets = sets.size > 0;

    // ── Active set selector ──
    const selectorWrap = document.createElement('div');
    selectorWrap.className = 'xc-set-selector-wrap';

    const selLabel = document.createElement('label');
    selLabel.className = 'field-label';
    selLabel.textContent = 'Active Set';
    selectorWrap.appendChild(selLabel);

    const selectorRow = document.createElement('div');
    selectorRow.className = 'xc-set-selector-row';

    const sel = document.createElement('select');
    sel.className = 'field-select';
    const optAll = document.createElement('option');
    optAll.value = '';
    optAll.textContent = hasExternalSets ? '— All labels (no set) —' : '— No sets yet —';
    sel.appendChild(optAll);
    for (const [id, s] of sets) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = `${s.origin === 'xeno-canto' ? '🌍 ' : '📝 '}${s.name || id}`;
      sel.appendChild(opt);
    }
    if (this._activeSetId && sets.has(this._activeSetId)) sel.value = this._activeSetId;
    sel.addEventListener('change', () => {
      this._activeSetId = sel.value || null;
      this._rebuildSetForm();
      this._updateUploadState();
    });
    selectorRow.appendChild(sel);

    const newSetBtn = document.createElement('button');
    newSetBtn.type = 'button';
    newSetBtn.className = 'tb-btn';
    newSetBtn.title = 'Create new annotation set';
    newSetBtn.textContent = '+ New';
    newSetBtn.addEventListener('click', () => {
      if (!this._onCreateSet) return;
      const newSet = this._onCreateSet({ origin: 'manual', name: 'New annotation set' });
      this._activeSetId = newSet.id;
      this._rebuildSetSection();
    });
    selectorRow.appendChild(newSetBtn);
    selectorWrap.appendChild(selectorRow);
    el.appendChild(selectorWrap);

    // ── Set form ──
    this._setFormEl = document.createElement('div');
    this._setFormEl.className = 'xc-set-form';
    el.appendChild(this._setFormEl);
    this._rebuildSetForm();
  }

  /** Rebuild set selector + form (call after external set registry changes). */
  _rebuildSetSection() { this._buildSetSection(); }

  _rebuildSetForm() {
    const el = this._setFormEl;
    if (!el) return;
    el.innerHTML = '';

    const sets = this._getLabelSets?.() || new Map();
    // Determine the set data to show
    let setData = null;
    if (this._activeSetId && sets.has(this._activeSetId)) {
      setData = sets.get(this._activeSetId);
    } else if (!this._getLabelSets) {
      // Fallback to internal setMeta when no external sets
      setData = this.setMeta;
    }

    if (!setData) {
      el.innerHTML = '<div class="props-empty">Select or create a set above.</div>';
      return;
    }

    const isExternal = this._activeSetId && sets.has(this._activeSetId);

    const makeOnChange = (key) => (val) => {
      if (isExternal && this._onSetChange) {
        this._onSetChange(this._activeSetId, { [key]: val });
      } else {
        this.setMeta[key] = val;
        this._saveSetMeta();
      }
    };

    for (const group of SET_FIELD_GROUPS) {
      const buildGroup = () => {
        const dl = document.createElement('dl');
        dl.className = 'props-grid';
        for (const f of group.fields) {
          const { dt, dd } = buildField(f, setData[f.key] ?? '', makeOnChange(f.key));
          dl.appendChild(dt);
          dl.appendChild(dd);
        }
        return dl;
      };

      if (group.label) {
        el.appendChild(buildCollapsible(group.label, buildGroup));
      } else {
        el.appendChild(buildGroup());
      }
    }

    // Created on (read-only)
    if (setData.createdOn) {
      const dl = document.createElement('dl');
      dl.className = 'props-grid';
      const dt = document.createElement('dt'); dt.textContent = 'Created on';
      const dd = document.createElement('dd');
      dd.textContent = new Date(setData.createdOn).toLocaleString();
      dl.appendChild(dt); dl.appendChild(dd);
      el.appendChild(dl);
    }
  }

  // ── Payload builder ─────────────────────────────────────────────────

  /**
   * Build XC annotation set JSON payload.
   * @param {any[]} labels
   * @param {Map<string,object>} [labelSets]
   * @param {object} [recordingEditMeta]
   */
  buildAnnotationSetPayload(labels, labelSets, recordingEditMeta) {
    const sets = labelSets || this._getLabelSets?.() || new Map();
    const recMeta = recordingEditMeta || this._getRecordingEditMeta?.() || {};
    const xcNr = this.xcId || '';

    // Resolve active set
    let sm = null;
    if (this._activeSetId && sets.has(this._activeSetId)) {
      sm = sets.get(this._activeSetId);
    } else if (sets.size > 0) {
      // Use first xeno-canto set, else first manual set
      for (const s of sets.values()) { if (s.origin === 'xeno-canto') { sm = s; break; } }
      if (!sm) sm = sets.values().next().value;
    }
    if (!sm) sm = this.setMeta; // fallback to legacy internal

    // Filter labels to the active set if one is selected
    let targetLabels = labels || [];
    if (this._activeSetId) {
      const filtered = targetLabels.filter(l => l.setId === this._activeSetId);
      if (filtered.length) targetLabels = filtered;
    }

    const annotations = targetLabels
      .filter(l => l.start != null && l.end != null)
      .map((l, i) => ({
        annotation_source_id: String(i + 1),
        xc_nr: xcNr,
        annotator: l.author || sm.creator || '',
        annotator_xc_id: sm.creatorId || '',
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
        collection_date: recMeta.dateTime ? recMeta.dateTime.slice(0, 10) : '',
        collection_specimen: '',
        temperature: '',
        annotation_remarks: l.tags?.remarks || '',
        overlap: '',
      }));

    // Build recording context for upload
    const recContext = {
      latitude: recMeta.lat || '',
      longitude: recMeta.lng || '',
      recording_date: recMeta.dateTime ? recMeta.dateTime.slice(0, 10) : '',
      recording_time: recMeta.dateTime ? recMeta.dateTime.slice(11, 16) : '',
      rating: recMeta.rating || '',
      type: recMeta.type || '',
      target_species: recMeta.targetSpecies || '',
      recorder: recMeta.recorder || '',
      microphone: recMeta.microphone || '',
      accessories: recMeta.accessories || '',
      contributors: recMeta.contributors ? recMeta.contributors.split(',').map(s => s.trim()).filter(Boolean) : [],
      comments: recMeta.comments || '',
    };

    return {
      set_source: sm.source || '',
      set_uri: sm.uri || '',
      set_name: sm.name || `Audio Workbench annotations ${new Date().toISOString().slice(0, 16)}`,
      annotation_software_name_and_version: 'Audio Workbench',
      set_creator: sm.creator || '',
      set_creator_id: sm.creatorId || '',
      set_owner: sm.owner || '',
      set_license: sm.license || '',
      project_uri: sm.projectUri || '',
      project_name: sm.projectName || '',
      funding: sm.funding || '',
      scope: [{ taxon_coverage: sm.taxonCoverage || '', completeness: sm.completeness || '' }],
      recording_context: recContext,
      annotations,
    };
  }

  // ── Upload / Export ─────────────────────────────────────────────────

  async uploadToXenoCanto(labels, labelSets, recordingEditMeta, onStatus) {
    if (!this.apiKey) throw new Error('API key required. Save your key first.');
    if (!this.xcId) throw new Error('No XC recording loaded.');
    if (!labels?.length) throw new Error('No labels to upload.');

    const payload = this.buildAnnotationSetPayload(labels, labelSets, recordingEditMeta);
    onStatus?.('Uploading to Xeno-canto…');

    const res = await fetch(XC_UPLOAD_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'key': this.apiKey },
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
    return { ok: true, message: body?.message || 'Upload successful', warnings: body?.warnings || [], errors: body?.errors || [] };
  }

  exportAnnotationSetJSON(labels, labelSets, recordingEditMeta) {
    const payload = this.buildAnnotationSetPayload(labels, labelSets, recordingEditMeta);
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = this.xcId ? `XC${this.xcId}_annotation_set.json` : 'annotation_set.json';
    document.body.appendChild(a); a.click(); a.remove();
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
    const sets = this._getLabelSets?.() || new Map();
    const hasSet = this._activeSetId ? sets.has(this._activeSetId) : true;
    if (this.uploadBtn) this.uploadBtn.disabled = !this.apiKey || !this.xcId || !hasSet;
  }

  // ── Label pool ───────────────────────────────────────────────────────

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
    const recSci = String(recording?.gen && recording?.sp ? `${recording.gen} ${recording.sp}` : '').trim();
    add(recording?.en, recSci); add(recSci, recSci); add(recording?.type, recSci);
    for (const raw of result?.rawLabels || []) {
      const sci = String(raw?.scientific_name || raw?.scientificName || recSci).trim();
      add(raw?.sound_type || raw?.soundType, sci);
      add(raw?.annotation_remarks || raw?.comment || raw?.description, sci);
      add(raw?.label || raw?.name || raw?.value, sci);
      if (sci) add(sci, sci);
    }
    return Array.from(pool.values());
  }

  // ── Private ──────────────────────────────────────────────────────────

  _restoreKey() {
    try { this.apiKey = String(localStorage.getItem(API_KEY_STORAGE) || ''); } catch {}
  }

  _restoreSetMeta() {
    try {
      const data = JSON.parse(localStorage.getItem(SET_META_STORAGE) || '{}');
      if (data && typeof data === 'object') Object.assign(this.setMeta, data);
    } catch {}
  }

  _saveSetMeta() {
    try { localStorage.setItem(SET_META_STORAGE, JSON.stringify(this.setMeta)); } catch {}
  }

  _updateButtonState() {
    if (this.openBtn) this.openBtn.textContent = this.apiKey ? 'XC API ✓' : 'XC API';
  }

  _bindEvents() {
    this.openBtn?.addEventListener('click', () => this.open());
    this.cancelBtn?.addEventListener('click', () => this.close());
    this.saveBtn?.addEventListener('click', () => {
      this.apiKey = String(this.keyInput?.value || '').trim();
      try { localStorage.setItem(API_KEY_STORAGE, this.apiKey); } catch {}
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
  }

  dispose() { this._modal?.dispose(); }
}
