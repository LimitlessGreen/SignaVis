/**
 * Audio Workbench — Storybook Stories
 *
 * Each story: { id, title, description, category, defaultSample, run(root, audioUrl) → player | {destroy()} }
 */

const SAMPLE_BIRD  = './samples/birdsong.wav';
const SAMPLE_SWEEP = './samples/sweep-200-8000.wav';

/* ── Categories ── */

export const categories = [
  { id: 'presets',  label: 'Presets' },
  { id: 'embeds',   label: 'Embeds' },
  { id: 'features', label: 'Features' },
  { id: 'tools',    label: 'Tools' },
];

/* ── Helpers ── */

function container(root, height = 520) {
  root.innerHTML = '';
  const el = document.createElement('div');
  Object.assign(el.style, {
    height: `${height}px`, width: '100%',
    borderRadius: '10px', overflow: 'hidden', background: '#fff',
  });
  root.appendChild(el);
  return el;
}

async function makePlayer(root, opts, audioUrl) {
  const el = container(root, opts.height || 520);
  const p = new globalThis.BirdNETPlayerModule.BirdNETPlayer(el, opts);
  await p.ready;
  if (audioUrl) await p.loadUrl(audioUrl);
  return p;
}

const HERO_OPTS = {
  showOverview: false, showFileOpen: false, showTime: false,
  showVolume: false, showViewToggles: false, showZoom: false,
  showFFTControls: false, showDisplayGain: false, showStatusbar: false,
  transportStyle: 'hero', transportOverlay: true,
};

function heroHost(root, width = '560px') {
  root.innerHTML = '';
  const host = document.createElement('div');
  host.style.cssText = `width:${width};max-width:100%`;
  root.appendChild(host);
  return host;
}

/* ── Stories ── */

export const stories = [

  /* ── Presets ── */

  {
    id: 'full-player',
    title: 'Full Player',
    description: 'All controls enabled — the default DAW-like layout.',
    category: 'presets',
    defaultSample: SAMPLE_BIRD,
    run: (root, url) => makePlayer(root, { showFileOpen: true }, url),
  },
  {
    id: 'spectrogram-analysis',
    title: 'Spectrogram Analysis',
    description: 'Spectrogram-focused view with a frequency sweep sample.',
    category: 'presets',
    defaultSample: SAMPLE_SWEEP,
    run: (root, url) => makePlayer(root, { viewMode: 'spectrogram' }, url),
  },

  /* ── Embeds ── */

  {
    id: 'waveform-hero',
    title: 'Waveform Hero',
    description: 'Compact waveform preview with centered play overlay.',
    category: 'embeds',
    defaultSample: SAMPLE_BIRD,
    run: (root, url) =>
      makePlayer(heroHost(root), { ...HERO_OPTS, height: 220, viewMode: 'waveform' }, url),
  },
  {
    id: 'spectrogram-hero',
    title: 'Spectrogram Hero',
    description: 'Compact spectrogram preview with centered play overlay.',
    category: 'embeds',
    defaultSample: SAMPLE_SWEEP,
    run: (root, url) =>
      makePlayer(heroHost(root), { ...HERO_OPTS, height: 220, viewMode: 'spectrogram' }, url),
  },
  {
    id: 'compact-embed',
    title: 'Compact Embed',
    description: 'Ultra-small player for tight embed scenarios.',
    category: 'embeds',
    defaultSample: SAMPLE_BIRD,
    run: (root, url) =>
      makePlayer(heroHost(root, '340px'), { ...HERO_OPTS, height: 160, viewMode: 'spectrogram' }, url),
  },

  /* ── Features ── */

  {
    id: 'annotations',
    title: 'Annotations',
    description: 'BirdNET-style annotation regions on the amplitude view.',
    category: 'features',
    defaultSample: SAMPLE_BIRD,
    async run(root, url) {
      const p = await makePlayer(root, {}, url);
      p.setAnnotations([
        { start: 0.7, end: 2.1, species: 'Erithacus rubecula', confidence: 0.93, color: 'rgba(255,99,132,0.22)' },
        { start: 3.0, end: 4.3, species: 'Parus major',        confidence: 0.87, color: 'rgba(54,162,235,0.22)' },
        { start: 5.2, end: 6.7, species: 'Turdus merula',      confidence: 0.91, color: 'rgba(255,206,86,0.22)' },
      ]);
      return p;
    },
  },
  {
    id: 'spectrogram-labels',
    title: 'Spectrogram Labels',
    description: '2-D frequency × time labels drawn on the spectrogram.',
    category: 'features',
    defaultSample: SAMPLE_BIRD,
    async run(root, url) {
      const p = await makePlayer(root, {}, url);
      p.setSpectrogramLabels([
        { start: 0.8, end: 2.0, freqMin: 1800, freqMax: 4100, label: 'Robin call',      color: 'rgba(239,68,68,0.25)' },
        { start: 3.2, end: 4.5, freqMin: 900,  freqMax: 2500, label: 'Great tit phrase', color: 'rgba(59,130,246,0.25)' },
        { start: 5.4, end: 6.6, freqMin: 2800, freqMax: 5600, label: 'Blackbird motif',  color: 'rgba(234,179,8,0.25)' },
      ]);
      return p;
    },
  },
  {
    id: 'event-monitor',
    title: 'Event Monitor',
    description: 'Live event stream — see every event the player emits.',
    category: 'features',
    defaultSample: SAMPLE_BIRD,
    async run(root, url) {
      root.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:grid;grid-template-columns:1fr 260px;gap:12px;min-width:0';
      root.appendChild(wrap);

      const playerHost = document.createElement('div');
      playerHost.style.minWidth = '0';
      wrap.appendChild(playerHost);

      const log = document.createElement('pre');
      Object.assign(log.style, {
        margin: '0', padding: '10px', borderRadius: '10px',
        background: '#0f172a', color: '#94a3b8',
        font: '12px/1.4 ui-monospace, SFMono-Regular, monospace',
        height: '520px', overflow: 'auto',
      });
      wrap.appendChild(log);

      const write = (msg) => {
        log.textContent = new Date().toLocaleTimeString() + '  ' + msg + '\n' + log.textContent;
      };

      const p = await makePlayer(playerHost, {}, url);
      write('player ready');

      const unsubs = [
        p.on('timeupdate',             () => { if (Math.random() < 0.02) write('timeupdate'); }),
        p.on('selection',              (e) => write(`selection ${e.detail.start.toFixed(2)}–${e.detail.end.toFixed(2)}s`)),
        p.on('zoomchange',             (e) => write(`zoom ${Math.round(e.detail.pixelsPerSecond)} px/s`)),
        p.on('spectrogramlabelcreate', (e) => write(`label.create ${e.detail.label?.label || e.detail.label?.id}`)),
        p.on('spectrogramlabelupdate', (e) => write(`label.update ${e.detail.label?.label || e.detail.label?.id}`)),
        p.on('annotationcreate',       (e) => write(`ann.create ${e.detail?.id ?? ''}`)),
        p.on('cachehit',               ()  => write('cache hit')),
        p.on('cachemiss',              ()  => write('cache miss')),
        p.on('cachewrite',             ()  => write('cache write')),
      ];

      const origDestroy = p.destroy.bind(p);
      p.destroy = () => { unsubs.forEach(u => u()); origDestroy(); };
      return p;
    },
  },

  /* ── Tools ── */

  {
    id: 'playground',
    title: 'Playground',
    description: 'Toggle every option in real time and see the result.',
    category: 'tools',
    defaultSample: SAMPLE_BIRD,
    async run(root, audioUrl) {
      root.innerHTML = '';

      const shell = document.createElement('div');
      shell.style.cssText = 'display:grid;grid-template-columns:220px 1fr;gap:14px;min-width:0';
      root.appendChild(shell);

      const panel = document.createElement('div');
      panel.style.cssText = 'display:flex;flex-direction:column;gap:6px;font-size:13px;overflow-y:auto;max-height:600px;padding-right:4px';
      shell.appendChild(panel);

      const stage = document.createElement('div');
      stage.style.minWidth = '0';
      shell.appendChild(stage);

      const opts = {
        showFileOpen: true, showTransport: true, showTime: true, showVolume: true,
        showViewToggles: true, showZoom: true, showFFTControls: true,
        showDisplayGain: true, showStatusbar: true, showOverview: true,
        viewMode: 'both', transportStyle: 'default', transportOverlay: false,
        compactToolbar: 'auto', height: 520,
      };

      let mounted = null;
      const mount = async () => {
        if (mounted) mounted.destroy();
        mounted = await makePlayer(stage, opts, audioUrl);
      };

      /* Panel helpers */
      const heading = (text) => {
        const h = document.createElement('div');
        h.textContent = text;
        h.style.cssText = 'font-weight:700;padding-top:6px';
        panel.appendChild(h);
      };

      const toggle = (key) => {
        const lbl = document.createElement('label');
        lbl.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = opts[key];
        cb.addEventListener('change', () => { opts[key] = cb.checked; mount(); });
        lbl.append(cb, key);
        panel.appendChild(lbl);
      };

      const select = (key, values) => {
        const lbl = document.createElement('label');
        lbl.style.cssText = 'display:grid;gap:3px';
        const sel = document.createElement('select');
        sel.style.cssText = 'height:28px;border:1px solid #d1d5db;border-radius:6px;padding:0 6px;font:inherit;font-size:12px';
        for (const v of values) {
          const o = document.createElement('option');
          o.value = v; o.textContent = v;
          sel.appendChild(o);
        }
        sel.value = String(opts[key]);
        sel.addEventListener('change', () => {
          const val = sel.value;
          opts[key] = val === 'true' ? true : val === 'false' ? false : val;
          mount();
        });
        lbl.append(key, sel);
        panel.appendChild(lbl);
      };

      heading('Sections');
      for (const k of [
        'showFileOpen', 'showTransport', 'showTime', 'showVolume',
        'showViewToggles', 'showZoom', 'showFFTControls',
        'showDisplayGain', 'showStatusbar', 'showOverview',
      ]) toggle(k);

      heading('Layout');
      select('viewMode', ['both', 'waveform', 'spectrogram']);
      select('transportStyle', ['default', 'hero']);
      select('transportOverlay', ['false', 'true']);
      select('compactToolbar', ['auto', 'on', 'off']);

      heading('Size');
      const sizeLbl = document.createElement('label');
      sizeLbl.style.cssText = 'display:grid;gap:3px';
      const sizeText = document.createTextNode(`height: ${opts.height}px`);
      const sizeRange = document.createElement('input');
      sizeRange.type = 'range'; sizeRange.min = '160'; sizeRange.max = '620';
      sizeRange.step = '10'; sizeRange.value = String(opts.height);
      sizeRange.addEventListener('input', () => {
        opts.height = Number(sizeRange.value);
        sizeText.textContent = `height: ${opts.height}px`;
        mount();
      });
      sizeLbl.append(sizeText, sizeRange);
      panel.appendChild(sizeLbl);

      await mount();
      return { destroy() { mounted?.destroy(); } };
    },
  },
];
