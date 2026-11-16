"""Label-sync benchmark for the labeling app (plans/labeling-app-architecture-plan.md, step 2).

Needs the Vite dev server (window.__signavis only exists there):
    npx vite --port 5191
    uv run --with playwright python -I tools/perf/label-sync-bench.py [--url=...] [--labels=1500] [--runs=15]

Per action: median wall time until the next frame is drawn and how often the
label list, the label table and the spectrogram labels were rebuilt.
"""
import json, sys
from playwright.sync_api import sync_playwright

args = dict(a.lstrip('-').split('=', 1) for a in sys.argv[1:] if '=' in a)
URL = args.get('url', 'http://localhost:5191/demo/labeling-app.html')
N = int(args.get('labels', 1500))
RUNS = int(args.get('runs', 15))
if N < 1 or RUNS < 1:
    sys.exit('--labels and --runs must be at least 1')

SETUP = """async (n) => {
  const sv = window.__signavis;
  const own = 'own';
  const labels = [];
  for (let i = 0; i < n; i++) {
    const t = (i * 0.37) % 7.5;
    labels.push({ id: 'bench_' + i, start: t, end: t + 0.3, freqMin: 1000 + (i % 7) * 500, freqMax: 3000 + (i % 7) * 500,
      label: 'Species ' + (i % 25), scientificName: '', origin: 'manual', setId: own, tags: {} });
  }
  sv.state.labels = labels;
  sv.syncToPlayer();
  await new Promise((r) => setTimeout(r, 300));
  const counts = { list: 0, table: 0, player: 0 };
  const ms = { list: 0, table: 0, player: 0 };
  const wrap = (obj, key, name) => { const f = obj[key].bind(obj); obj[key] = (...a) => { counts[name]++; const t = performance.now(); try { return f(...a); } finally { ms[name] += performance.now() - t; } }; };
  wrap(sv.labelList, 'render', 'list');
  if (sv.labelTable) wrap(sv.labelTable, 'render', 'table');
  wrap(sv.player, 'setSpectrogramLabels', 'player');
  window.__bench = { counts, ms };
  return { labels: sv.state.labels.length, table: !!sv.labelTable };
}"""

ACTION = """async ([name, runs]) => {
  const sv = window.__signavis;
  const c = window.__bench.counts;
  const m = window.__bench.ms;
  const yieldTask = () => new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });
  // Next frame drawn: rAF callbacks, style/layout/paint, then a task.
  const painted = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  const n = sv.state.labels.length;
  const id = (k) => 'bench_' + (k % n);   // always an existing label, whatever --labels/--runs
  const actions = {
    'props edit (no name)': (i) => sv.propsPanel.onChange(id(i * 7), { note: 'n' + i }),
    'props edit (rename)': (i) => sv.propsPanel.onChange(id(i * 7), { label: 'Species ' + ((i + 3) % 25) }),
    'drag/resize on spectrogram': (i) => {
      const l = sv.state.labels.find((x) => x.id === id(i * 11));
      sv.player._emit('spectrogramlabelupdate', { label: { ...l, end: l.end + 0.01 } });
    },
    'syncToPlayer()': () => sv.syncToPlayer(),
  };
  const times = [];
  for (const k of Object.keys(c)) { c[k] = 0; m[k] = 0; }
  for (let i = 0; i < runs; i++) {
    await painted();
    const t0 = performance.now();
    actions[name](i);
    await painted();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return { median: times[Math.floor(times.length / 2)], per: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v / runs])),
    ms: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v / runs])) };
}"""

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={'width': 1400, 'height': 900})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL, wait_until='networkidle')
    page.wait_for_function('window.__signavis')
    page.evaluate("document.getElementById('loadSampleBtn')?.click()")
    page.wait_for_timeout(4000)
    print(json.dumps(page.evaluate(SETUP, N)))
    for name in ['props edit (no name)', 'props edit (rename)', 'drag/resize on spectrogram', 'syncToPlayer()']:
        r = page.evaluate(ACTION, [name, RUNS])
        per = ', '.join(f'{k} {v:g}x/{r["ms"][k]:.0f}ms' for k, v in r['per'].items())
        print(f'{name:30s} {r["median"]:8.1f} ms   renders per action: {per}')
    for e in errors: print('pageerror:', e[:200])
    b.close()
