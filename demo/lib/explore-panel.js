/**
 * ExplorePanel — two-tab panel for species discovery and detection statistics.
 *
 * Tab 1 — Statistics (default):
 *   Per-species detection count, average confidence and total duration,
 *   grouped by annotation origin (BirdNET / Xeno-canto / Manual).
 *   Updates live whenever labels change.
 *
 * Tab 2 — Explore:
 *   Species from the BirdNET area model sorted by local occurrence probability.
 *   Cards for already-labeled species show a green checkmark.
 *
 * Clicking any card pre-fills the topbar species selector for drawing new labels.
 */

const BIRD_IMG_BASE = 'https://birdnet.cornell.edu/api2/bird/';

const FALLBACK_SVG = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 72 72'%3E%3Crect width='72' height='72' fill='%23303030'/%3E%3Cpath d='M36 18c-6 0-11 4-13 9l-5-3c-1-1-3 0-2 2l4 7c-1 2-2 4-2 7 0 8 8 14 18 14s18-6 18-14c0-2-1-4-2-6l5-8c1-2-1-3-2-2l-6 4c-2-6-7-10-13-10z' fill='%23555'/%3E%3C/svg%3E`;

// ── Origin display ────────────────────────────────────────────────────────────
const ORIGIN_DISPLAY = { 'BirdNET': 'BirdNET', 'xeno-canto': 'Xeno-canto' };
const ORIGIN_ORDER   = { 'BirdNET': 0, 'xeno-canto': 1 };
function originDisplay(o) { return ORIGIN_DISPLAY[o] || 'Manual'; }
function originOrder(o)   { return ORIGIN_ORDER[o] ?? 99; }

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────────────────────────────────────

export class ExplorePanel {
  /**
   * @param {object} opts
  * @param {import('../../src/domain/analysis/types.ts').AnalysisBackend} opts.birdnet
   * @param {() => any[]}    opts.getLabels
   * @param {() => string}   opts.getLang
   * @param {import('../../src/infrastructure/taxonomyResolver.ts').TaxonomyResolver} opts.taxonomy
   * @param {() => {lat:number,lon:number}|null}  opts.getCoords
   * @param {() => string|null}                   opts.getRecordingDate
   * @param {(onProgress?: (msg:string,pct:number)=>void) => Promise<any>} [opts.loadModel]
   * @param {(item: {name:string, scientificName:string}) => void} [opts.onSpeciesSelect]
   *   Called when the user clicks a species card — use to pre-fill the label species bar.
   */
  constructor({ birdnet, getLabels, getLang, taxonomy, getCoords, getRecordingDate, loadModel, onSpeciesSelect, onOpenRefCalls }) {
    this._birdnet          = birdnet;
    this._getLabels        = getLabels;
    this._getLang          = getLang;
    this._taxonomy         = taxonomy;
    this._getCoords        = getCoords;
    this._getRecordingDate = getRecordingDate;
    this._loadModel        = loadModel ?? null;
    this._onSpeciesSelect  = onSpeciesSelect ?? null;
    this._onOpenRefCalls   = onOpenRefCalls ?? null;

    this._activeTab    = 'stats';
    this._loading      = false;
    this._exploreReady = false;

    this.el = this._build();
  }

  // ── Public API ───────────────────────────────────────────────────────────

  activate() {
    if (this._activeTab === 'stats') {
      this.refreshStats();
    } else if (!this._exploreReady) {
      this._renderExploreState();
    }
  }

  /** Always refresh stats — called on every label change. */
  notifyLabelsChanged() {
    this.refreshStats();
    // If Explore is showing cards, update checkmarks without a full reload
    if (this._activeTab === 'explore' && this._exploreReady) {
      this._syncExploreCheckmarks();
    }
  }

  // ── Statistics tab ───────────────────────────────────────────────────────

  refreshStats() {
    const cardsEl = this._q('#epStatsCards');
    if (!cardsEl) return;
    const labels = this._getLabels();
    const lang   = this._getLang();

    /** @type {Map<string, Map<string, {sci,common,count,confSum,confCount,dur}>>} */
    const byOrigin = new Map();

    for (const lbl of labels) {
      const origin = lbl.origin || 'manual';
      if (!byOrigin.has(origin)) byOrigin.set(origin, new Map());
      const originMap = byOrigin.get(origin);

      const sci = lbl.scientificName || '';
      const key = sci || lbl.label || '(unknown)';
      if (!originMap.has(key)) {
        originMap.set(key, { sci, common: lbl.commonName || lbl.label || key,
          count: 0, confSum: 0, confCount: 0, dur: 0 });
      }
      const s = originMap.get(key);
      s.count++;
      if (typeof lbl.confidence === 'number' && isFinite(lbl.confidence)) {
        s.confSum += lbl.confidence; s.confCount += 1;
      }
      if (typeof lbl.start === 'number' && typeof lbl.end === 'number') {
        s.dur += Math.max(0, lbl.end - lbl.start);
      }
    }

    if (!byOrigin.size) {
      cardsEl.innerHTML = `<div class="sp-cards-empty">No labels yet — annotate the spectrogram or run a BirdNET analysis.</div>`;
      return;
    }

    cardsEl.innerHTML = '';

    const sortedOrigins = [...byOrigin.keys()].sort((a, b) => originOrder(a) - originOrder(b));
    for (const origin of sortedOrigins) {
      const originMap = byOrigin.get(origin);
      const totalCount = [...originMap.values()].reduce((n, s) => n + s.count, 0);

      const header = document.createElement('div');
      header.className = 'sp-section-header';
      header.innerHTML = `
        <span class="sp-section-title">${esc(originDisplay(origin))}</span>
        <span class="sp-section-count">${totalCount} label${totalCount !== 1 ? 's' : ''}</span>`;
      cardsEl.appendChild(header);

      const sorted = [...originMap.values()].sort((a, b) => b.count - a.count);
      for (const s of sorted) {
        const record     = s.sci ? this._taxonomy?.resolve(s.sci) : null;
        const commonName = record
          ? (this._taxonomy.resolveCommonName(record, lang) || s.common)
          : s.common;
        const avgConf  = s.confCount > 0 ? s.confSum / s.confCount : null;
        const confText = avgConf != null ? `avg ${(avgConf * 100).toFixed(0)}% confidence` : '';
        const durText  = s.dur > 0 ? _fmtDur(s.dur) : '';

        cardsEl.appendChild(this._makeCard({
          scientificName: s.sci,
          commonName,
          badgeText:  String(s.count),
          badgeTitle: `${s.count} detection${s.count !== 1 ? 's' : ''}`,
          barValue:   avgConf,
          metaLeft:   `${s.count} detection${s.count !== 1 ? 's' : ''}`,
          metaRight:  [confText, durText].filter(Boolean).join(' · '),
          labeled:    false,   // all stats cards are labeled by definition — no extra badge needed
        }));
      }
    }
  }

  // ── Explore tab ──────────────────────────────────────────────────────────

  _renderExploreState() {
    const cardsEl    = this._q('#epExploreCards');
    const controlsEl = this._q('#epControls');

    if (!this._birdnet.loaded) {
      controlsEl.hidden = true;
      if (this._loadModel) {
        this._actionCard(cardsEl, 'BirdNET model not loaded.', 'Load Model',
          () => this._loadModelThenRefresh());
      } else {
        cardsEl.innerHTML = `<div class="sp-cards-empty">Open the BirdNET panel and run an analysis first to load the model.</div>`;
      }
      return;
    }
    if (!this._birdnet.hasAreaModel) {
      controlsEl.hidden = true;
      cardsEl.innerHTML = `<div class="sp-cards-empty">No area model found. Use the bundled BirdNET v2.4 model — it includes a <code>mdata/</code> folder alongside <code>model.json</code>.</div>`;
      return;
    }
    const coords = this._getCoords?.();
    if (!coords) {
      controlsEl.hidden = true;
      cardsEl.innerHTML = `<div class="sp-cards-empty">Set a recording location in the BirdNET panel to see species ranked by occurrence probability for your region.</div>`;
      return;
    }
    this.refreshExplore();
  }

  async _loadModelThenRefresh() {
    const cardsEl = this._q('#epExploreCards');
    cardsEl.innerHTML = `
      <div class="sp-cards-empty">
        <div class="ep-progress-wrap"><div class="ep-progress-bar" id="epLoadBar"></div></div>
        <span class="ep-load-status" id="epLoadStatus">Loading model…</span>
      </div>`;
    try {
      await this._loadModel((msg, pct) => {
        const bar = this.el.querySelector('#epLoadBar');
        const lbl = this.el.querySelector('#epLoadStatus');
        if (bar) bar.style.width = `${pct}%`;
        if (lbl) lbl.textContent = msg;
      });
      await this.refreshExplore();
    } catch (err) {
      cardsEl.innerHTML = `<div class="sp-cards-empty">Failed to load model: ${esc(err?.message || String(err))}</div>`;
    }
  }

  async refreshExplore() {
    if (this._loading) return;
    this._loading = true;

    const cardsEl    = this._q('#epExploreCards');
    const statusEl   = this._q('#epStatus');
    const controlsEl = this._q('#epControls');
    const refreshBtn = this._q('#epRefreshBtn');
    if (refreshBtn) refreshBtn.disabled = true;

    try {
      if (!this._birdnet.loaded || !this._birdnet.hasAreaModel) {
        this._renderExploreState(); return;
      }
      const coords = this._getCoords?.();
      if (!coords) { this._renderExploreState(); return; }

      controlsEl.hidden = false;
      statusEl.textContent = 'Applying location…';
      cardsEl.innerHTML = '';

      const date      = this._getRecordingDate?.();
      const geoResult = await this._birdnet.setLocation(coords.lat, coords.lon,
        { date: date || undefined });

      statusEl.textContent = 'Loading species list…';
      const all = await this._birdnet.getAllSpecies();

      const filtered = all
        .filter(s => s.geoscore != null && s.geoscore > 0.001)
        .sort((a, b) => b.geoscore - a.geoscore);

      const weekPart  = (geoResult.ok && geoResult.week) ? ` · week ${geoResult.week}` : '';
      const coordPart = `${coords.lat.toFixed(2)}, ${coords.lon.toFixed(2)}`;
      statusEl.textContent = `${filtered.length} species · ${coordPart}${weekPart}`;

      this._renderExploreCards(cardsEl, filtered);
      this._exploreReady = true;
    } catch (err) {
      if (statusEl) statusEl.textContent = `Error: ${err?.message || String(err)}`;
    } finally {
      this._loading = false;
      if (refreshBtn) refreshBtn.disabled = false;
    }
  }

  /** Lightweight update: just toggle `.sp-card--labeled` without re-rendering all cards. */
  _syncExploreCheckmarks() {
    const labeled = this._labeledSciNames();
    this._q('#epExploreCards')?.querySelectorAll('.sp-card[data-sci]').forEach(card => {
      const sci = card.dataset.sci;
      card.classList.toggle('sp-card--labeled', labeled.has(sci));
    });
  }

  // ── Rendering helpers ────────────────────────────────────────────────────

  _build() {
    const el = document.createElement('div');
    el.className = 'explore-panel';
    el.innerHTML = `
      <div class="ep-tab-bar">
        <button class="ep-tab active" data-tab="stats">Statistics</button>
        <button class="ep-tab" data-tab="explore">Explore</button>
      </div>

      <!-- Statistics pane (default — visible) -->
      <div class="ep-pane" id="epPaneStats">
        <div class="sp-cards" id="epStatsCards">
          <div class="sp-cards-empty">No labels yet.</div>
        </div>
      </div>

      <!-- Explore pane (hidden until selected) -->
      <div class="ep-pane ep-pane--hidden" id="epPaneExplore">
        <div class="ep-controls" id="epControls" hidden>
          <button class="tb-btn" id="epRefreshBtn" type="button">↻ Refresh</button>
          <span class="ep-status" id="epStatus"></span>
        </div>

        <!-- Informational infobox: explains the Explore list purpose -->
        <div class="ep-infobox" id="epInfobox">
          <strong>Likely species for the selected location and date</strong>
          <div class="ep-infobox-text">This list ranks species by estimated local occurrence probability for the selected coordinates and recording date, computed by BirdNET's geographic (area) model. Use these suggestions to help prioritise annotation and validation; probabilities indicate relative likelihood and are not confirmed detections.</div>
        </div>

        <div class="sp-cards" id="epExploreCards">
          <div class="sp-cards-empty">Switch to the Explore tab to load species.</div>
        </div>
      </div>
    `;

    el.querySelectorAll('.ep-tab').forEach(btn =>
      btn.addEventListener('click', () => this._switchTab(btn.dataset.tab)));
    el.querySelector('#epRefreshBtn').addEventListener('click', () => this.refreshExplore());

    return el;
  }

  _switchTab(tab) {
    this._activeTab = tab;
    this.el.querySelectorAll('.ep-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === tab));
    this._q('#epPaneStats').classList.toggle('ep-pane--hidden',   tab !== 'stats');
    this._q('#epPaneExplore').classList.toggle('ep-pane--hidden', tab !== 'explore');

    if (tab === 'stats')                          this.refreshStats();
    else if (!this._exploreReady)                 this._renderExploreState();
    else                                          this._syncExploreCheckmarks();
  }

  _renderExploreCards(container, species) {
    const lang    = this._getLang();
    const labeled = this._labeledSciNames();
    container.innerHTML = '';
    for (const s of species) {
      const record     = s.scientific ? this._taxonomy?.resolve(s.scientific) : null;
      const commonName = record
        ? (this._taxonomy.resolveCommonName(record, lang) || s.common || s.scientific)
        : (s.common || s.scientific);
      const pct = (s.geoscore * 100).toFixed(1);

      container.appendChild(this._makeCard({
        scientificName: s.scientific,
        commonName,
        badgeText:  `${pct}%`,
        badgeTitle: `Area occurrence: ${pct}%`,
        barValue:   s.geoscore,
        metaLeft:   'occurrence probability',
        metaRight:  `${pct}%`,
        labeled:    labeled.has(s.scientific),
      }));
    }
  }

  _actionCard(container, msg, btnLabel, btnAction) {
    container.innerHTML = `
      <div class="sp-cards-empty">
        <div class="ep-action-msg">${esc(msg)}</div>
        <button class="geo-action-btn primary ep-action-btn" type="button">${esc(btnLabel)}</button>
      </div>`;
    container.querySelector('.ep-action-btn').addEventListener('click', btnAction);
  }

  /**
   * Build one species card element.
   * @param {{ scientificName:string, commonName:string, badgeText:string, badgeTitle:string,
   *           barValue:number|null, metaLeft:string, metaRight:string, labeled:boolean }} opts
   */
  _makeCard({ scientificName, commonName, badgeText, badgeTitle, barValue, metaLeft, metaRight, labeled }) {
    const card = document.createElement('div');
    card.className = 'sp-card' + (this._onSpeciesSelect ? ' sp-card--clickable' : '')
                               + (labeled ? ' sp-card--labeled' : '');
    if (scientificName) card.dataset.sci = scientificName;

    const imgSrc = scientificName
      ? `${BIRD_IMG_BASE}${encodeURIComponent(scientificName)}.webp`
      : FALLBACK_SVG;
    const barPct = (barValue != null && isFinite(barValue))
      ? Math.min(100, barValue * 100).toFixed(1)
      : null;

    card.innerHTML = `
      <div class="sp-card-img-wrap">
        <img class="sp-card-img" src="${esc(imgSrc)}" alt="${esc(commonName)}" loading="lazy" />
      </div>
      <div class="sp-card-body">
        <div class="sp-card-top">
          <span class="sp-card-common" title="${esc(commonName)}">${esc(commonName)}</span>
          <span class="sp-card-badge" title="${esc(badgeTitle)}">${esc(badgeText)}</span>
        </div>
        <div class="sp-card-sci" title="${esc(scientificName)}">${esc(scientificName)}</div>
        ${barPct != null ? `
        <div class="sp-card-bar-track" role="progressbar"
             aria-valuenow="${barPct}" aria-valuemin="0" aria-valuemax="100">
          <div class="sp-card-bar-fill" style="width:${barPct}%"></div>
        </div>` : ''}
        <div class="sp-card-meta">
          <span class="sp-card-meta-l">${esc(metaLeft)}</span>
          ${metaRight ? `<span class="sp-card-meta-r">${esc(metaRight)}</span>` : ''}
        </div>
      </div>
    `;

    if (this._onOpenRefCalls) {
      const refBtn = document.createElement('button');
      refBtn.className = 'act-btn';
      refBtn.title = 'Reference Calls';
      refBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
      refBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._onOpenRefCalls({ scientificName, name: commonName });
      });
      // Append to the meta row so it sits inline with the existing meta content.
      const metaEl = card.querySelector('.sp-card-meta');
      if (metaEl) metaEl.appendChild(refBtn);
      else card.querySelector('.sp-card-body')?.appendChild(refBtn);
    }

    const img = card.querySelector('.sp-card-img');
    img.addEventListener('error', () => { img.src = FALLBACK_SVG; }, { once: true });

    if (this._onSpeciesSelect) {
      card.addEventListener('click', () => {
        this._onSpeciesSelect({ name: commonName, scientificName: scientificName || '' });
        // Brief visual feedback
        card.classList.add('sp-card--flash');
        setTimeout(() => card.classList.remove('sp-card--flash'), 300);
      });
    }

    return card;
  }

  /** Set of scientific names that currently have at least one label. */
  _labeledSciNames() {
    const set = new Set();
    for (const lbl of this._getLabels()) {
      if (lbl.scientificName) set.add(lbl.scientificName);
    }
    return set;
  }

  _q(sel) { return this.el.querySelector(sel); }
}

// ── Utility ────────────────────────────────────────────────────────────────

function _fmtDur(seconds) {
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m} m ${s} s`;
}
