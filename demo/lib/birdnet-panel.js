/**
 * BirdNET inference modal — opens a dialog, runs TF.js BirdNET analysis,
 * and returns detected labels.
 *
 * Usage:
 *   import { BirdNETPanel } from './lib/birdnet-panel.js';
 *   const panel = new BirdNETPanel({
 *     backdrop:     document.getElementById('birdnetModalBackdrop'),
 *     modelUrlInput: document.getElementById('birdnetModelUrl'),
 *     confidenceInput: document.getElementById('birdnetConfidence'),
 *     confidenceVal:   document.getElementById('birdnetConfidenceVal'),
 *     overlapSelect:   document.getElementById('birdnetOverlap'),
 *     mergeCheckbox:   document.getElementById('birdnetMerge'),
 *     authorInput:     document.getElementById('birdnetAuthor'),
 *     progressWrap:    document.getElementById('birdnetProgressWrap'),
 *     progressBar:     document.getElementById('birdnetProgressBar'),
 *     statusEl:        document.getElementById('birdnetStatus'),
 *     analyzeBtn:      document.getElementById('birdnetAnalyzeBtn'),
 *     cancelBtn:       document.getElementById('birdnetCancelBtn'),
 *     openBtn:         document.getElementById('birdnetBtn'),
 *     birdnet:         birdnetInstance,
 *     getAudioBuffer:  () => player._state?.audioBuffer,
 *     resolveLabel:    (det) => ({ ... }),
 *     onResults:       (labels) => { ... },
 *   });
 */
import ModalManager from '../../src/modal-manager.js';
import { openMapModal } from './geo-map-modal.js';

const DEFAULT_MODEL_URL = '../models/birdnet-v2.4/';
const STORAGE_KEY     = 'audio-workbench.birdnet-model-url.v2';
const STORAGE_GEO_KEY = 'audio-workbench.birdnet-geo-coords';
let DETECTION_COLOR = 'var(--color-detection)';
if (typeof window !== 'undefined' && window.getComputedStyle) {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--color-detection') || '';
  if (v.trim()) DETECTION_COLOR = v.trim();
}

/**
 * Merge labels of the same species whose time ranges overlap.
 * Keeps the highest confidence and extends the time range.
 */
export function mergeOverlappingLabels(labels) {
  const bySpecies = new Map();
  for (const lbl of labels) {
    const key = lbl.scientificName || lbl.label;
    if (!bySpecies.has(key)) bySpecies.set(key, []);
    bySpecies.get(key).push(lbl);
  }
  const merged = [];
  for (const group of bySpecies.values()) {
    group.sort((a, b) => a.start - b.start);
    let current = { ...group[0] };
    for (let i = 1; i < group.length; i++) {
      const next = group[i];
      if (next.start <= current.end) {
        current.end = Math.max(current.end, next.end);
        if (next.confidence > current.confidence) current.confidence = next.confidence;
      } else {
        merged.push(current);
        current = { ...next };
      }
    }
    merged.push(current);
  }
  return merged;
}

export class BirdNETPanel {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.backdrop
   * @param {HTMLInputElement} opts.modelUrlInput
   * @param {HTMLInputElement} opts.confidenceInput
   * @param {HTMLElement} opts.confidenceVal
   * @param {HTMLSelectElement} opts.overlapSelect
   * @param {HTMLInputElement} opts.mergeCheckbox
   * @param {HTMLInputElement} opts.authorInput
   * @param {HTMLElement} opts.progressWrap
   * @param {HTMLElement} opts.progressBar
   * @param {HTMLElement} opts.statusEl
   * @param {HTMLButtonElement} opts.analyzeBtn
   * @param {HTMLButtonElement} opts.cancelBtn
   * @param {HTMLButtonElement} [opts.openBtn]
   * @param {import('../../src/birdnetInference.js').BirdNETInference} opts.birdnet
   * @param {() => AudioBuffer|null} opts.getAudioBuffer
   * @param {(det: any, audioBuffer: AudioBuffer) => any} opts.resolveLabel
   * @param {(labels: any[]) => void} opts.onResults
   * -- Geo / location (all optional) --
   * @param {HTMLInputElement} [opts.latInput]
   * @param {HTMLInputElement} [opts.lonInput]
   * @param {HTMLButtonElement} [opts.geoBtn]
   * @param {HTMLButtonElement} [opts.mapBtn]
   * @param {HTMLInputElement} [opts.geoThresholdInput]
   * @param {HTMLElement} [opts.geoThresholdVal]
   * @param {HTMLElement} [opts.geoStatusEl]
   */
  constructor(opts) {
    Object.assign(this, opts);
    this._modal = this.backdrop ? new ModalManager({ backdrop: this.backdrop }) : null;
    this._restoreModelUrl();
    this._restoreGeoCoords();
    this._bindEvents();
  }

  open() {
    this.statusEl.textContent = '';
    this.progressWrap.style.display = 'none';
    this.progressBar.style.width = '0%';
    this.analyzeBtn.disabled = false;
    if (this._modal) {
      this._modal.open();
    } else if (this.backdrop) {
      this.backdrop.classList.add('show');
      this.backdrop.setAttribute('aria-hidden', 'false');
    }
    setTimeout(() => this.modelUrlInput.focus(), 0);
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

  _restoreModelUrl() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      this.modelUrlInput.value = stored || DEFAULT_MODEL_URL;
    } catch {
      this.modelUrlInput.value = DEFAULT_MODEL_URL;
    }
  }

  _restoreGeoCoords() {
    try {
      const raw = localStorage.getItem(STORAGE_GEO_KEY);
      if (!raw) return;
      const { lat, lon } = JSON.parse(raw);
      if (this.latInput && isFinite(lat)) this.latInput.value = lat;
      if (this.lonInput && isFinite(lon)) this.lonInput.value = lon;
    } catch { /* ignore */ }
  }

  _saveGeoCoords(lat, lon) {
    try { localStorage.setItem(STORAGE_GEO_KEY, JSON.stringify({ lat, lon })); } catch { /* ignore */ }
  }

  _getCoords() {
    if (!this.latInput || !this.lonInput) return null;
    const lat = parseFloat(this.latInput.value);
    const lon = parseFloat(this.lonInput.value);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat, lon };
  }

  _geoStatus(msg) {
    // Show in the dedicated geo status span AND the main status line.
    if (this.geoStatusEl) this.geoStatusEl.textContent = msg ? `(${msg})` : '';
    if (this.statusEl) this.statusEl.textContent = msg || '';
  }

  _setCoords(lat, lon) {
    if (this.latInput) this.latInput.value = lat.toFixed(5);
    if (this.lonInput) this.lonInput.value = lon.toFixed(5);
    this._saveGeoCoords(lat, lon);
    this._geoStatus(`${lat.toFixed(3)}, ${lon.toFixed(3)}`);
  }

  _bindEvents() {
    this.openBtn?.addEventListener('click', () => this.open());
    this.cancelBtn?.addEventListener('click', () => this.close());
    // Backdrop clicks and global Escape handler are managed by ModalManager when provided.
    this.confidenceInput.addEventListener('input', () => {
      this.confidenceVal.textContent = this.confidenceInput.value;
    });
    if (this.geoThresholdInput && this.geoThresholdVal) {
      this.geoThresholdInput.addEventListener('input', () => {
        this.geoThresholdVal.textContent = this.geoThresholdInput.value;
      });
    }
    this.analyzeBtn.addEventListener('click', () => this._analyze());

    // ── Geolocation button ──
    this.geoBtn?.addEventListener('click', () => {
      if (!navigator.geolocation) {
        this._geoStatus('Geolocation not supported by this browser.');
        return;
      }
      // Geolocation requires a secure context (https or localhost).
      if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
        this._geoStatus('Requires HTTPS or localhost.');
        return;
      }
      this._geoStatus('Locating…');
      this.geoBtn.disabled = true;
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          this.geoBtn.disabled = false;
          this._setCoords(pos.coords.latitude, pos.coords.longitude);
        },
        (err) => {
          this.geoBtn.disabled = false;
          const msg = err.code === 1 ? 'Permission denied — check browser site settings.'
                    : err.code === 2 ? 'Position unavailable.'
                    : 'Timeout — try again.';
          this._geoStatus(msg);
        },
        { timeout: 8000, maximumAge: 60000 }
      );
    });

    // ── Map button ──
    this.mapBtn?.addEventListener('click', () => {
      const coords = this._getCoords();
      openMapModal({
        lat: coords?.lat ?? 51,
        lon: coords?.lon ?? 10,
        onConfirm: ({ lat, lon }) => this._setCoords(lat, lon),
      });
    });

    // Persist coords when user types manually
    this.latInput?.addEventListener('change', () => {
      const c = this._getCoords();
      if (c) {
        this._saveGeoCoords(c.lat, c.lon);
        if (this.geoStatusEl) this.geoStatusEl.textContent = `(${c.lat.toFixed(3)}, ${c.lon.toFixed(3)})`;
      }
    });
    this.lonInput?.addEventListener('change', () => {
      const c = this._getCoords();
      if (c) {
        this._saveGeoCoords(c.lat, c.lon);
        if (this.geoStatusEl) this.geoStatusEl.textContent = `(${c.lat.toFixed(3)}, ${c.lon.toFixed(3)})`;
      }
    });
  }

  async _analyze() {
    const audioBuffer = this.getAudioBuffer();
    if (!audioBuffer) {
      this.statusEl.textContent = 'No audio loaded.';
      return;
    }

    const modelUrl = String(this.modelUrlInput.value || '').trim();
    if (!modelUrl) {
      this.statusEl.textContent = 'Please enter a model URL.';
      return;
    }

    try { localStorage.setItem(STORAGE_KEY, modelUrl); } catch { /* ignore */ }

    const confidence    = parseFloat(this.confidenceInput.value) || 0.25;
    const overlap       = parseFloat(this.overlapSelect.value) || 0;
    const geoThreshold  = parseFloat(this.geoThresholdInput?.value ?? 0) || 0;
    const coords        = this._getCoords();

    this.analyzeBtn.disabled = true;
    this.progressWrap.style.display = '';
    this.progressBar.style.width = '0%';

    try {
      if (!this.birdnet.loaded) {
        this.statusEl.textContent = 'Loading TF.js + model…';
        const loadResult = await this.birdnet.load({
          modelUrl,
          onProgress: (msg, pct) => {
            this.statusEl.textContent = msg;
            this.progressBar.style.width = pct + '%';
          },
        });
        if (loadResult.hasAreaModel) {
          this.statusEl.textContent = 'Area model loaded ✓';
        }
      }

      // Apply geographic priors if coordinates are set and area model is available
      if (coords && this.birdnet.hasAreaModel) {
        this.statusEl.textContent = 'Applying location filter…';
        await this.birdnet.setLocation(coords.lat, coords.lon);
      }

      this.statusEl.textContent = 'Analyzing…';
      this.progressBar.style.width = '0%';

      const channelData = audioBuffer.getChannelData(0);
      const detections = await this.birdnet.analyze(channelData, {
        sampleRate: audioBuffer.sampleRate,
        overlap,
        minConfidence: confidence,
        geoThreshold: coords ? geoThreshold : 0,
        onProgress: (pct) => { this.progressBar.style.width = pct + '%'; },
      });

      const author = this.authorInput.value.trim();
      const mergeOverlapping = this.mergeCheckbox.checked;
      const newLabels = detections.map((det) => ({
        ...this.resolveLabel(det, audioBuffer),
        id: `bn_${Math.random().toString(36).slice(2, 10)}`,
        start: det.start,
        end: det.end,
        freqMin: 0,
        freqMax: audioBuffer.sampleRate / 2,
        color: DETECTION_COLOR,
        confidence: det.confidence,
        origin: 'BirdNET',
        author: author || '',
      }));

      const labelsToAdd = mergeOverlapping ? mergeOverlappingLabels(newLabels) : newLabels;
      this.onResults(labelsToAdd);
      this.statusEl.textContent = `Done — ${labelsToAdd.length} detection${labelsToAdd.length === 1 ? '' : 's'} added.`;
    } catch (err) {
      this.statusEl.textContent = `Error: ${err?.message || String(err)}`;
      this.birdnet.dispose();
    } finally {
      this.analyzeBtn.disabled = false;
    }
  }

  dispose() {
    this._modal?.dispose();
  }
}
