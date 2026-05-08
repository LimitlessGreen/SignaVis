/**
 * SignaVis — Storybook Stories
 *
 * Each story: { id, title, description, category, defaultSample, run(root, audioUrl) → player | {destroy()} }
 */

const SAMPLE_BIRD  = './samples/birdsong.wav';
const SAMPLE_SWEEP = './samples/sweep-200-8000.wav';

/* ── Categories ── */

export const categories = [
  { id: 'presets',   label: 'Presets' },
  { id: 'embeds',    label: 'Embeds' },
  { id: 'features',  label: 'Features' },
  { id: 'tools',     label: 'Tools' },
  { id: 'headless',  label: 'Headless / Integration' },
];

/* ── Helpers ── */

function container(root, height = 520) {
  root.innerHTML = '';
  const el = document.createElement('div');
  Object.assign(el.style, {
    height: `${height}px`, width: '100%',
    borderRadius: '10px', overflow: 'hidden', background: 'var(--color-bg-surface)',
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

      /* ── Event definitions ── */
      const EVENT_DEFS = [
        { name: 'timeupdate',             on: false, fmt: ()          => 'timeupdate',                                             throttle: true },
        { name: 'selection',              on: true,  fmt: (e)         => `selection ${e.detail.start.toFixed(2)}–${e.detail.end.toFixed(2)}s` },
        { name: 'zoomchange',             on: true,  fmt: (e)         => `zoom ${Math.round(e.detail.pixelsPerSecond)} px/s` },
        { name: 'spectrogramlabelcreate', on: true,  fmt: (e)         => `label.create ${e.detail.label?.label || e.detail.label?.id}` },
        { name: 'spectrogramlabelupdate', on: true,  fmt: (e)         => `label.update ${e.detail.label?.label || e.detail.label?.id}` },
        { name: 'annotationcreate',       on: true,  fmt: (e)         => `ann.create ${e.detail?.id ?? ''}` },
        { name: 'ready',                  on: true,  fmt: (e)         => `ready ${e.detail.nFrames}f × ${e.detail.nMels}bins` },
        { name: 'computeTime',            on: true,  fmt: (e)         => `compute ${e.detail.durationMs}ms` },
        { name: 'progress',               on: true,  fmt: (e)         => `progress ${e.detail.percent}%` },
        { name: 'error',                  on: true,  fmt: (e)         => `error: ${e.detail.message}` },
      ];

      /* ── Layout: player | sidebar(toggles + log) ── */
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:grid;grid-template-columns:1fr 280px;gap:12px;min-width:0';
      root.appendChild(wrap);

      const playerHost = document.createElement('div');
      playerHost.style.minWidth = '0';
      wrap.appendChild(playerHost);

      const sidebar = document.createElement('div');
      sidebar.style.cssText = 'display:flex;flex-direction:column;gap:8px;min-width:0';
      wrap.appendChild(sidebar);

      /* ── Toggle panel ── */
      const togglePanel = document.createElement('div');
      Object.assign(togglePanel.style, {
        padding: '8px 10px', borderRadius: '10px',
        background: 'var(--color-bg-secondary)', color: 'var(--muted)',
        font: '11px/1.6 ui-monospace, SFMono-Regular, monospace',
        display: 'flex', flexWrap: 'wrap', gap: '2px 10px',
      });
      const heading = document.createElement('div');
      heading.textContent = 'Events';
      heading.style.cssText = 'width:100%;font-weight:600;color:var(--color-text-primary);margin-bottom:2px';
      togglePanel.appendChild(heading);
      sidebar.appendChild(togglePanel);

      const checkboxes = EVENT_DEFS.map((def) => {
        const label = document.createElement('label');
        label.style.cssText = 'display:flex;align-items:center;gap:4px;cursor:pointer;user-select:none';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = def.on;
        cb.style.cssText = 'accent-color:var(--color-accent);margin:0';
        label.appendChild(cb);
        label.appendChild(document.createTextNode(def.name));
        togglePanel.appendChild(label);
        return { def, cb };
      });

      /* ── Log ── */
      const log = document.createElement('pre');
      Object.assign(log.style, {
        margin: '0', padding: '10px', borderRadius: '10px',
        background: 'var(--color-bg-secondary)', color: 'var(--muted)',
        font: '12px/1.4 ui-monospace, SFMono-Regular, monospace',
        flex: '1 1 0', overflow: 'auto', minHeight: '0',
      });
      sidebar.appendChild(log);

      const write = (msg) => {
        log.textContent = new Date().toLocaleTimeString() + '  ' + msg + '\n' + log.textContent;
      };

      /* ── Player + subscriptions ── */
      const p = await makePlayer(playerHost, {}, url);
      write('player ready');

      const unsubs = EVENT_DEFS.map((def, i) => {
        const handler = (e) => {
          if (!checkboxes[i].cb.checked) return;
          if (def.throttle && Math.random() >= 0.02) return;
          write(def.fmt(e));
        };
        return p.on(def.name, handler);
      });

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
        sel.style.cssText = 'height:28px;border:1px solid var(--color-border);border-radius:6px;padding:0 6px;font:inherit;font-size:12px';
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

  // ══════════════════════════════════════════════════════════════════
  //  Headless / Integration Stories
  // ══════════════════════════════════════════════════════════════════

  {
    id: 'headless-mock-engine',
    title: 'MockAudioEngine (no WaveSurfer)',
    description: `
      Demonstrates the player with \`MockAudioEngine\` — no WaveSurfer, no AudioContext.
      Useful for Gradio/Streamlit embeds where Python handles DSP and the browser
      only needs the spectrogram overlay and label editing UI.
      The spectrogram is generated as a synthetic gradient image.
    `,
    category: 'headless',
    async run(root) {
      const { BirdNETPlayer, MockAudioEngine, InMemoryStorageAdapter } = globalThis.BirdNETPlayerModule;

      const el = document.createElement('div');
      Object.assign(el.style, { height: '520px', width: '100%', borderRadius: '10px', overflow: 'hidden' });
      root.innerHTML = '';
      root.appendChild(el);

      // Headless engine + in-memory storage
      const engine  = new MockAudioEngine();
      const storage = new InMemoryStorageAdapter({ 'aw-favourite-preset': 'perch' });

      const player = new BirdNETPlayer(el, {
        engine,
        storage,
        showFileOpen: false,
        viewMode: 'spectrogram',
      });
      await player.ready;

      // Simulate Python providing a pre-computed spectrogram
      await engine.loadFromUrl('https://example.com/bird.wav');

      // Generate a synthetic gradient spectrogram (stands in for real DSP output)
      const nFrames = 600, nMels = 160;
      const data = new Float32Array(nFrames * nMels);
      for (let f = 0; f < nFrames; f++) {
        for (let m = 0; m < nMels; m++) {
          // Simple synthetic bird-call pattern
          const freq = m / nMels;
          const time = f / nFrames;
          data[f * nMels + m] = Math.max(0,
            0.3 * Math.exp(-((freq - 0.6) ** 2) / 0.02) *
            Math.exp(-((time - 0.4) ** 2) / 0.01) +
            0.2 * Math.random()
          );
        }
      }
      await player.setSpectrogramData(data, nFrames, nMels, { mode: 'mel', sampleRate: 32000 });

      // Pre-load some labels (as Python would send them)
      player.setSpectrogramLabels([
        { id: 'lbl1', start: 1.2, end: 3.8, freqMin: 2000, freqMax: 8000, label: 'Bird Call', color: '#0ea5e9' },
        { id: 'lbl2', start: 5.0, end: 7.5, freqMin: 1500, freqMax: 6000, label: 'Song',      color: '#22c55e' },
      ]);

      return player;
    },
  },

  {
    id: 'headless-external-spectrogram',
    title: 'External Spectrogram Image',
    description: `
      Shows how to inject a pre-rendered spectrogram image from Python.
      The image bypasses all DSP computation — useful when the server
      provides PNG/JPEG spectrograms directly (e.g. librosa output).
    `,
    category: 'headless',
    defaultSample: SAMPLE_BIRD,
    async run(root, audioUrl) {
      const el = document.createElement('div');
      Object.assign(el.style, { height: '520px', width: '100%', borderRadius: '10px', overflow: 'hidden' });
      root.innerHTML = '';
      root.appendChild(el);

      const player = new globalThis.BirdNETPlayerModule.BirdNETPlayer(el, {
        showFileOpen: false,
        viewMode: 'spectrogram',
      });
      await player.ready;
      if (audioUrl) await player.loadUrl(audioUrl);

      // Synthesize a fake "server-provided" spectrogram PNG via canvas
      const canvas = document.createElement('canvas');
      canvas.width = 800; canvas.height = 160;
      const ctx = canvas.getContext('2d');
      const grad = ctx.createLinearGradient(0, 160, 0, 0);
      grad.addColorStop(0,   '#0a0a1a');
      grad.addColorStop(0.3, '#1e3a5f');
      grad.addColorStop(0.6, '#0ea5e9');
      grad.addColorStop(1,   '#ffffff');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 800, 160);
      // Add some fake activity
      for (let i = 0; i < 20; i++) {
        ctx.fillStyle = `rgba(255,255,100,${0.3 + Math.random() * 0.4})`;
        ctx.fillRect(
          Math.random() * 700, 20 + Math.random() * 100,
          10 + Math.random() * 40, 5 + Math.random() * 20,
        );
      }

      await player.setSpectrogramImage(canvas, {
        sampleRate: 32000,
        freqRange: [0, 16000],
        freqScale: 'linear',
      });

      return player;
    },
  },
];
