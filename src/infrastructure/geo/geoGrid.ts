/**
 * Fast geomodel grids for the range map: the geomodel trunk (models/geo-trunk-*, split by
 * scripts/geo_trunk.py) runs on WebGPU when available, else on WASM, in its own worker; the
 * output layer is applied for the one species asked for. ~0.1 s for 4,500 grid points on a
 * desktop GPU vs ~8 s for the full model on WASM (SignaVis-lab, geomodel experiment).
 *
 * Loaded lazily (range map only): the WebGPU build of onnxruntime-web is large.
 */
import { ORT_BASE } from '../birdnetInference.ts';
import { isLite } from '../tauri/runtime.ts';

const WORKER_SOURCE = (ortFile: string) => `
importScripts('${ORT_BASE}${ortFile}');
ort.env.wasm.wasmPaths = '${ORT_BASE}';
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, self.navigator.hardwareConcurrency || 1) : 1;
let session = null, inputName = 'input', outName = '', W = null, B = null, n = 0, d = 0, rows = null, labelIx = {}, ep = '';

function halfToFloat(h) {
  var s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

// One request at a time: onnxruntime-web does not support overlapping runs on one session
// (on a Mali GPU three overlapping WebGPU runs never return).
var queue = Promise.resolve();
self.onmessage = function (e) { queue = queue.then(function () { return handle(e); }); };

async function handle(e) {
  var m = e.data, id = m.id;
  try {
    if (m.type === 'load') {
      var head = await fetch(m.base + 'head.json').then(function (r) { if (!r.ok) throw new Error('head.json: HTTP ' + r.status); return r.json(); });
      var buf = await fetch(m.base + 'head.bin').then(function (r) { if (!r.ok) throw new Error('head.bin: HTTP ' + r.status); return r.arrayBuffer(); });
      n = head.n; d = head.d; rows = head.rows; inputName = head.input || 'input'; outName = head.hidden;
      var h16 = new Uint16Array(buf, 0, n * d);
      W = new Float32Array(n * d);
      var lut = new Float32Array(65536);
      for (var k = 0; k < 65536; k++) lut[k] = halfToFloat(k);
      for (var i = 0; i < n * d; i++) W[i] = lut[h16[i]];
      B = new Float32Array(buf, n * d * 2, n);
      var labels = await fetch(m.labelsUrl).then(function (r) { if (!r.ok) throw new Error('labels: HTTP ' + r.status); return r.text(); });
      labelIx = {};
      labels.replace(/\\r/g, '').split('\\n').forEach(function (l, li) { var c = l.split('\\t'); if (c[1]) labelIx[c[1]] = li; });
      session = null;
      if (m.gpu) {
        try {
          session = await ort.InferenceSession.create(m.base + 'trunk.onnx', { executionProviders: ['webgpu'] });
          ep = 'webgpu';
        } catch (_) { session = null; }
      }
      if (!session) {
        session = await ort.InferenceSession.create(m.base + 'trunk.onnx', { executionProviders: ['wasm'] });
        ep = 'wasm';
      }
      self.postMessage({ id: id, type: 'loaded', ep: ep, species: Object.keys(labelIx).length });
      return;
    }
    if (m.type === 'grid') {
      var li2 = labelIx[m.species];
      if (li2 == null) { self.postMessage({ id: id, type: 'grid', values: null }); return; }
      var rs = rows.map(function (r) { return r[li2]; }).filter(function (v, k, a) { return a.indexOf(v) === k; });
      var LATS = m.lats, C = m.cols, N = LATS.length * C, dLon = (m.east - m.west) / C;
      var vals = new Float32Array(N);
      var BATCH = ep === 'webgpu' ? 8192 : 1024;
      for (var o = 0; o < N; o += BATCH) {
        var nb = Math.min(BATCH, N - o), x = new Float32Array(nb * 3);
        for (var q = 0; q < nb; q++) {
          var cell = o + q, rr = Math.floor(cell / C), cc = cell % C;
          var lon = m.west + (cc + 0.5) * dLon;
          lon = ((lon + 180) % 360 + 360) % 360 - 180;
          x[q * 3] = LATS[rr]; x[q * 3 + 1] = lon; x[q * 3 + 2] = m.week;
        }
        var feeds = {}; feeds[inputName] = new ort.Tensor('float32', x, [nb, 3]);
        var hdn = (await session.run(feeds))[outName].data;
        for (var p = 0; p < nb; p++) {
          var best = 0;
          for (var t = 0; t < rs.length; t++) {
            var row = rs[t], a = B[row], wo = row * d, ho = p * d;
            for (var j = 0; j < d; j++) a += W[wo + j] * hdn[ho + j];
            var s = 1 / (1 + Math.exp(-a));
            if (s > best) best = s;
          }
          vals[o + p] = best;
        }
      }
      self.postMessage({ id: id, type: 'grid', values: vals }, [vals.buffer]);
    }
  } catch (err) {
    self.postMessage({ id: id, type: 'error', message: String(err && err.message || err) });
  }
}
`;

export interface GeoGridSource {
  /** Folder of the trunk files (trunk.onnx, head.bin, head.json), ending in '/'. */
  base: string;
  /** Geomodel label file (<id>\t<scientific>\t<common>), same order as the geomodel output. */
  labelsUrl: string;
}

/** Trunk folder for an audio model folder, by convention models/<model>/ → models/geo-trunk-<version>/. */
export const GEO_TRUNKS: Record<string, string> = { 'birdnet-v3.0': 'geo-trunk-v3.0' };

export function geoTrunkFor(modelUrl: string, geoLabelsFile: string | null): GeoGridSource | null {
  const m = /^(.*\/)([^/]+)\/?$/.exec(modelUrl || '');
  if (!m || !geoLabelsFile) return null;
  const trunk = GEO_TRUNKS[m[2]];
  if (!trunk) return null;
  return { base: `${m[1]}${trunk}/`, labelsUrl: `${m[1]}${m[2]}/${geoLabelsFile}` };
}

export class GeoGridRunner {
  #worker: Worker | null = null;
  #pending = new Map<number, (v: any) => void>();
  #next = 1;
  ep = '';

  static async create(src: GeoGridSource): Promise<GeoGridRunner> {
    const r = new GeoGridRunner();
    // WebGPU needs the larger JSEP build of onnxruntime-web; Lite bundles only the WASM build.
    let gpu = false;
    try { gpu = !isLite() && !!(await (navigator as any).gpu?.requestAdapter()); } catch { gpu = false; }
    const blob = new Blob([WORKER_SOURCE(gpu ? 'ort.webgpu.min.js' : 'ort.wasm.min.js')], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    r.#worker = new Worker(url);
    URL.revokeObjectURL(url);
    r.#worker.onmessage = (e) => { const f = r.#pending.get(e.data.id); if (f) { r.#pending.delete(e.data.id); f(e.data); } };
    const res = await r.#send({ type: 'load', base: src.base, labelsUrl: src.labelsUrl, gpu });
    if (res.type === 'error') { r.dispose(); throw new Error(res.message); }
    r.ep = res.ep;
    return r;
  }

  async grid(species: string, grid: { lats: number[]; west: number; east: number; cols: number }, week: number): Promise<Float32Array | null> {
    const res = await this.#send({ type: 'grid', species, week, ...grid });
    if (res.type === 'error') throw new Error(res.message);
    return res.values;
  }

  dispose() { this.#worker?.terminate(); this.#worker = null; }

  #send(msg: any): Promise<any> {
    return new Promise((resolve) => {
      const id = this.#next++;
      this.#pending.set(id, resolve);
      this.#worker!.postMessage({ ...msg, id });
    });
  }
}

/** "models/…" site path of an svdata:/http URL (Lite serves models through the svdata cache). */
export function modelSitePath(url: string): string | null {
  try {
    const p = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, '');
    const i = p.indexOf('models/');
    return i >= 0 ? p.slice(i) : null;
  } catch { return null; }
}

/**
 * Lite: the trunk runs natively (src-tauri-lite/src/geo_grid.rs, ONNX Runtime on CUDA,
 * DirectML or all CPU cores); same interface as GeoGridRunner.
 */
export class NativeGeoGridRunner {
  ep = 'native';
  trunk: string;
  labels: string;
  constructor(trunk: string, labels: string) { this.trunk = trunk; this.labels = labels; }

  static async create(src: GeoGridSource): Promise<NativeGeoGridRunner> {
    const trunk = modelSitePath(src.base), labels = modelSitePath(src.labelsUrl);
    if (!trunk || !labels) throw new Error(`no model path: ${src.base}`);
    const r = new NativeGeoGridRunner(trunk, labels);
    // Load now (first grid call), so the provider is known before the map opens.
    await r.grid('', { lats: [0], west: 0, east: 1, cols: 1 }, 1);
    const { invoke } = await import('@tauri-apps/api/core');
    r.ep = `native-${await invoke<string>('geo_grid_ep')}`;
    return r;
  }

  async grid(species: string, grid: { lats: number[]; west: number; east: number; cols: number }, week: number): Promise<Float32Array | null> {
    const { invoke } = await import('@tauri-apps/api/core');
    const buf = await invoke<ArrayBuffer>('geo_grid', { req: { trunk: this.trunk, labels: this.labels, species, week, ...grid } });
    return buf.byteLength ? new Float32Array(buf) : null;
  }

  dispose() { /* the trunk stays loaded in the app process */ }
}
