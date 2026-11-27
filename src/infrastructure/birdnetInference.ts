/**
 * BirdNET browser inference in a Web Worker. Two model formats are supported,
 * detected from the model folder:
 *
 * - BirdNET+ V3.0 (ONNX, default): the folder contains `model_config.json`
 *   (BirdNET Live layout). Runs on onnxruntime-web (WASM), 32 kHz, 3 s windows,
 *   optional geo-model (lat, lon, week 1–48).
 * - BirdNET v2.4 (TF.js Layers): the folder contains `model.json` + `labels.json`
 *   (a TF.js graph model with the same input and output works too, e.g. AnuraPAM;
 *   it must run with synchronous predict(), i.e. contain no control-flow ops)
 *   and optionally the area model in `mdata/`. 48 kHz, 3 s windows.
 *
 * Runtimes (TF.js / onnxruntime-web) are loaded from CDN at runtime (vendored in Lite).
 */

import { vendorUrl } from './tauri/runtime.ts';
import { patchWebglComplexCast } from './tfjsComplexCastFix.ts';
const TFJS_CDN = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4';
const TFJS_URL = vendorUrl('tfjs/tf.min.js', TFJS_CDN);
const ORT_VERSION = '1.30.0';
const ORT_BASE = vendorUrl('ort/', `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`);
const TFJS_SR = 48000;
const CHUNK_SECONDS = 3;
const TFJS_CHUNK_SAMPLES = TFJS_SR * CHUNK_SECONDS; // 144 000

/**
 * Default model URL pointing to the bundled BirdNET+ V3.0 ONNX model
 * on the GitHub Pages demo site.  npm users can use this as a convenient
 * fallback or host the model themselves.
 */
export const BIRDNET_MODEL_URL = 'https://limitlessgreen.github.io/SignaVis/models/birdnet-v3.0/';
/** Legacy BirdNET v2.4 TF.js model on the GitHub Pages demo site. */
export const BIRDNET_V24_MODEL_URL = 'https://limitlessgreen.github.io/SignaVis/models/birdnet-v2.4/';

// ---------------------------------------------------------------------------
// Worker source — runs in a dedicated thread with WebGL-accelerated TF.js
// ---------------------------------------------------------------------------
const TFJS_WORKER_SOURCE = `
importScripts('${TFJS_URL}');
var patchWebglComplexCast = ${patchWebglComplexCast.toString()};

/* ── MelSpecLayerSimple — custom Keras layer expected by BirdNET v2.4 ── */
class MelSpecLayerSimple extends tf.layers.Layer {
  constructor(config) {
    super(config);
    this.sampleRate  = config.sampleRate;
    this.specShape   = config.specShape;
    this.frameStep   = config.frameStep;
    this.frameLength = config.frameLength;
    this.fmin        = config.fmin;
    this.fmax        = config.fmax;
    this.melFilterbank = tf.tensor2d(config.melFilterbank);
  }

  build(inputShape) {
    this.magScale = this.addWeight(
      'magnitude_scaling', [], 'float32',
      tf.initializers.constant({ value: 1.23 })
    );
    super.build(inputShape);
  }

  computeOutputShape(inputShape) {
    return [inputShape[0], this.specShape[0], this.specShape[1], 1];
  }

  call(inputs) {
    return tf.tidy(() => {
      let input = inputs[0];
      if (input.shape.length === 1) input = input.expandDims(0);
      return tf.stack(tf.split(input, input.shape[0]).map(t => {
        let spec = t.squeeze();
        spec = tf.sub(spec, tf.min(spec, -1, true));
        spec = tf.div(spec, tf.max(spec, -1, true).add(1e-6));
        spec = tf.sub(spec, 0.5);
        spec = tf.mul(spec, 2.0);
        spec = tf.signal.stft(
          spec, this.frameLength, this.frameStep,
          this.frameLength, tf.signal.hannWindow
        );
        spec = tf.cast(spec, 'float32');
        spec = tf.matMul(spec, this.melFilterbank);
        spec = spec.pow(2.0);
        spec = spec.pow(
          tf.div(1.0, tf.add(1.0, tf.exp(this.magScale.read())))
        );
        spec = tf.reverse(spec, -1);
        spec = tf.transpose(spec);
        spec = spec.expandDims(-1);
        return spec;
      }));
    });
  }

  static get className() { return 'MelSpecLayerSimple'; }
}
tf.serialization.registerClass(MelSpecLayerSimple);

/* ── Model loading ── */
async function fetchJson(url) {
  var r = await fetch(url);
  if (!r.ok) throw new Error(url.split('/').pop() + ': HTTP ' + r.status);
  return r.json();
}

async function fetchBuffer(url) {
  var r = await fetch(url);
  if (!r.ok) throw new Error(url.split('/').pop() + ': HTTP ' + r.status);
  return r.arrayBuffer();
}

/** Layers or graph model from its model.json (fetched once); shards resolve against folder. */
async function loadTfjsModel(manifest, folder) {
  var handler = {
    load: function () {
      return tf.io.getModelArtifactsForJSON(manifest, async function (groups) {
        var specs = [], paths = [];
        groups.forEach(function (g) { specs.push.apply(specs, g.weights); paths.push.apply(paths, g.paths); });
        var bufs = await Promise.all(paths.map(function (p) { return fetchBuffer(folder + p); }));
        return [specs, bufs]; // TF.js 4 takes the shards as a list
      });
    },
  };
  return manifest.format === 'graph-model' ? tf.loadGraphModel(handler) : tf.loadLayersModel(handler);
}

/**
 * Base layers model + dense head on its embeddings. predict() returns
 * sigmoid(concat(base logits, head logits)) like the BirdNET-Analyzer "Raw" export,
 * but runs the backbone once.
 */
async function loadHeadModel(manifest, folder, baseFolder) {
  var baseModel = await loadTfjsModel(await fetchJson(baseFolder + 'model.json'), baseFolder);
  var features = tf.model({
    inputs: baseModel.inputs,
    outputs: [baseModel.getLayer(manifest.embeddingLayer).output, baseModel.getLayer(manifest.baseLogitsLayer).output],
  });
  var data = new Float32Array(await fetchBuffer(folder + manifest.weightsFile));
  var off = 0;
  var layers = manifest.layers.map(function (l) {
    var k = l.kernelShape[0] * l.kernelShape[1];
    var layer = {
      activation: l.activation,
      kernel: tf.tensor2d(data.subarray(off, off + k), l.kernelShape),
      bias: tf.tensor1d(data.subarray(off + k, off + k + l.units)),
    };
    off += k + l.units;
    return layer;
  });
  if (off !== data.length) throw new Error(manifest.weightsFile + ': ' + data.length + ' values, expected ' + off);
  return {
    predict: function (x) {
      return tf.tidy(function () {
        var out = features.predict(x);
        var h = out[0];
        layers.forEach(function (l) {
          h = tf.add(tf.matMul(h, l.kernel), l.bias);
          if (l.activation === 'relu') h = tf.relu(h);
        });
        return tf.sigmoid(tf.concat([out[1], h], 1));
      });
    },
  };
}

/** BirdNET geo week: 4 per month, 1–48. */
function geoWeek(d) {
  return d.getMonth() * 4 + Math.min(3, Math.floor((d.getDate() - 1) / 7)) + 1;
}

/* ── Worker message handler ── */
let model     = null;
let areaModel = null;
let labels    = [];
let geoscores = null; // Float32Array, same length as labels; null = no geo filter

self.onmessage = async (e) => {
  var type = e.data.type;
  var id   = e.data.id;

  if (type === 'load') {
    try {
      await tf.setBackend('webgl');
      patchWebglComplexCast(tf);  // AnuraPAM: RFFT + Cast in the graph
      self.postMessage({ id: id, type: 'progress', message: 'Loading model\\u2026', percent: 10 });

      var base = e.data.modelUrl;
      if (!base.endsWith('/')) base += '/';

      // Layers model (BirdNET v2.4), graph model (a BirdNET-Analyzer custom classifier
      // converted from its SavedModel) or a classifier head on top of a layers model
      // (format "signavis-head", e.g. AnuraPAM: scripts/anurapam-head.mjs). All take 3 s
      // of 48 kHz audio and return sigmoid scores.
      var manifest = await fetchJson(base + 'model.json');
      var areaBase = base;
      if (manifest.format === 'signavis-head') {
        areaBase = new URL(manifest.base, base).href;
        model = await loadHeadModel(manifest, base, areaBase);
      } else {
        model = await loadTfjsModel(manifest, base);
      }

      self.postMessage({ id: id, type: 'progress', message: 'Warming up\\u2026', percent: 50 });
      model.predict(tf.zeros([1, ${TFJS_CHUNK_SAMPLES}])).dispose();

      self.postMessage({ id: id, type: 'progress', message: 'Loading labels\\u2026', percent: 80 });
      var raw = await fetch(base + 'labels.json').then(function (r) { return r.json(); });
      labels = raw.map(function (l) {
        var s = String(l);
        var idx = s.indexOf('_');
        return idx >= 0
          ? { scientific: s.slice(0, idx), common: s.slice(idx + 1) }
          : { scientific: s, common: '' };
      });

      self.postMessage({ id: id, type: 'progress', message: 'Loading area model\\u2026', percent: 92 });
      try {
        areaModel = await tf.loadGraphModel(areaBase + 'mdata/model.json');
        self.postMessage({ id: id, type: 'loaded', labelCount: labels.length, hasAreaModel: true, sampleRate: ${TFJS_SR}, format: 'tfjs' });
      } catch (_) {
        // Area model is optional — continue without it
        self.postMessage({ id: id, type: 'loaded', labelCount: labels.length, hasAreaModel: false, sampleRate: ${TFJS_SR}, format: 'tfjs' });
      }
    } catch (err) {
      self.postMessage({ id: id, type: 'error', message: String(err && err.message || err) });
    }
  }

  if (type === 'set-location') {
    if (!areaModel) {
      self.postMessage({ id: id, type: 'no-area-model' });
      return;
    }
    try {
      // Use provided date or fall back to today
      var refDate = e.data.date ? new Date(e.data.date) : new Date();
      if (isNaN(refDate.getTime())) refDate = new Date();
      // BirdNET area model week: 4 per month, 1–48 (not the ISO week).
      var week = geoWeek(refDate);

      var input = tf.tensor2d([[e.data.latitude, e.data.longitude, week]]);
      var scores = await areaModel.predict(input).data();
      input.dispose();
      geoscores = scores;
      self.postMessage({ id: id, type: 'area-scores-set', count: scores.length, week: week });
    } catch (err) {
      self.postMessage({ id: id, type: 'error', message: String(err && err.message || err) });
    }
  }

  if (type === 'geo-profile') {
    // Year profile (weeks 1–48) for a few species at one place. Leaves geoscores alone.
    if (!areaModel) { self.postMessage({ id: id, type: 'no-area-model' }); return; }
    try {
      var rows = [];
      for (var gw = 1; gw <= 48; gw++) rows.push([e.data.latitude, e.data.longitude, gw]);
      var gin = tf.tensor2d(rows);
      var gout = areaModel.predict(gin);
      var gall = await gout.data();
      gin.dispose(); gout.dispose();
      var gn = gall.length / 48;
      var profiles = {};
      (e.data.species || []).forEach(function (sci) {
        var li = labels.findIndex(function (l) { return l && l.scientific === sci; });
        if (li < 0 || li >= gn) return;
        var arr = new Array(48);
        for (var w = 0; w < 48; w++) arr[w] = gall[w * gn + li];
        profiles[sci] = arr;
      });
      self.postMessage({ id: id, type: 'geo-profile', profiles: profiles });
    } catch (err) {
      self.postMessage({ id: id, type: 'error', message: String(err && err.message || err) });
    }
  }

  if (type === 'clear-location') {
    geoscores = null;
    self.postMessage({ id: id, type: 'location-cleared' });
  }

  if (type === 'get-species-list') {
    var specList = [];
    for (var i = 0; i < labels.length; i++) {
      specList.push({
        scientific: labels[i].scientific,
        common:     labels[i].common,
        // a head model's extra classes (AnuraPAM frogs) are not in the area model
        geoscore:   geoscores && i < geoscores.length ? geoscores[i] : null,
      });
    }
    self.postMessage({ id: id, type: 'species-list', species: specList });
    return;
  }

  if (type === 'predict') {
    try {
      var pcm  = tf.tensor(e.data.samples, [1, ${TFJS_CHUNK_SAMPLES}]);
      var res  = model.predict(pcm);
      var probs = await res.data();
      pcm.dispose();
      res.dispose();

      var predictions = [];
      for (var i = 0; i < probs.length; i++) {
        if (probs[i] > 0.01 && i < labels.length) {
          predictions.push({
            scientific: labels[i].scientific,
            common:     labels[i].common,
            confidence: probs[i],
            geoscore:   geoscores && i < geoscores.length ? geoscores[i] : 1,
          });
        }
      }
      self.postMessage({ id: id, type: 'predictions', predictions: predictions });
    } catch (err) {
      self.postMessage({ id: id, type: 'error', message: String(err && err.message || err) });
    }
  }
};
`;

// ---------------------------------------------------------------------------
// Worker source — BirdNET+ V3.0 (ONNX, BirdNET Live layout) on onnxruntime-web
// ---------------------------------------------------------------------------
const ONNX_WORKER_SOURCE = `
importScripts('${ORT_BASE}ort.wasm.min.js');
ort.env.wasm.wasmPaths = '${ORT_BASE}';
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, self.navigator.hardwareConcurrency || 1) : 1;

let audio = null, geo = null, cfg = null;
let labels = [];        // { scientific, common, geoIx }
let multipliers = null; // Float32Array | null (score blacklist)
let geoscores = null;   // Float32Array aligned with labels | null
let chunkSamples = 0;

function parseCsv(text, delim) {
  return text.replace(/\\r/g, '').split('\\n').filter(function (l) { return l.length; })
    .map(function (l) { return l.split(delim); });
}

/** BirdNET+ geo week: 4 per month, 1–48. */
function geoWeek(d) {
  return d.getMonth() * 4 + Math.min(3, Math.floor((d.getDate() - 1) / 7)) + 1;
}

self.onmessage = async (e) => {
  var type = e.data.type;
  var id   = e.data.id;

  if (type === 'load') {
    try {
      var base = e.data.modelUrl;
      if (!base.endsWith('/')) base += '/';
      cfg = e.data.config;
      var am = cfg.audioModel;
      chunkSamples = am.audio.sampleRate * ${CHUNK_SECONDS};

      self.postMessage({ id: id, type: 'progress', message: 'Loading labels\\u2026', percent: 5 });
      var lc = am.labels, cols = lc.columns;
      var rows = parseCsv(await fetch(base + lc.file).then(function (r) { return r.text(); }), lc.delimiter || ';');
      var header = lc.hasHeader !== false ? rows.shift() : null;
      var col = function (name, fallback) { var i = header ? header.indexOf(name) : -1; return i >= 0 ? i : fallback; };
      var iIdx = col(cols.index, 0), iId = col(cols.birdnetId, 1), iSci = col(cols.scientificName, 2), iCom = col(cols.commonName, 3);
      labels = [];
      var ids = [];
      rows.forEach(function (r) {
        labels[Number(r[iIdx])] = { scientific: r[iSci], common: r[iCom], geoIx: -1 };
        ids[Number(r[iIdx])] = r[iId];
      });

      multipliers = null;
      if (am.scoreBlacklistFile) {
        try {
          var bl = await fetch(base + am.scoreBlacklistFile).then(function (r) { return r.ok ? r.json() : {}; });
          var keys = Object.keys(bl);
          if (keys.length) {
            multipliers = new Float32Array(labels.length).fill(1);
            labels.forEach(function (l, i) { if (bl[l.common] != null) multipliers[i] = Number(bl[l.common]); });
          }
        } catch (_) { /* optional */ }
      }

      self.postMessage({ id: id, type: 'progress', message: 'Loading BirdNET+ model\\u2026', percent: 15 });
      audio = await ort.InferenceSession.create(base + am.onnx.modelFile, { executionProviders: ['wasm'] });

      self.postMessage({ id: id, type: 'progress', message: 'Warming up\\u2026', percent: 60 });
      var warm = new ort.Tensor('float32', new Float32Array(chunkSamples), [1, chunkSamples]);
      var wf = {}; wf[am.onnx.inputName] = warm;
      await audio.run(wf, [am.onnx.outputNames.predictions]);

      geo = null;
      if (cfg.geoModel) {
        self.postMessage({ id: id, type: 'progress', message: 'Loading geo model\\u2026', percent: 85 });
        try {
          var gText = await fetch(base + cfg.geoModel.labelsFile).then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); });
          // Geo labels: <id>\\t<scientific>\\t<common>. The id is the BirdNET id in the BNL
          // build but an iNat id in the 14K geomodel, so fall back to the scientific name.
          var geoById = {}, geoBySci = {};
          parseCsv(gText, '\\t').forEach(function (r, i) { geoById[r[0]] = i; if (r[1]) geoBySci[r[1]] = i; });
          labels.forEach(function (l, i) {
            var g = geoById[ids[i]];
            if (g == null) g = geoBySci[l.scientific];
            l.geoIx = g == null ? -1 : g;
          });
          geo = await ort.InferenceSession.create(base + cfg.geoModel.modelFile, { executionProviders: ['wasm'] });
        } catch (_) { geo = null; }
      }
      self.postMessage({ id: id, type: 'loaded', labelCount: labels.length, hasAreaModel: !!geo,
        sampleRate: am.audio.sampleRate, format: 'onnx' });
    } catch (err) {
      self.postMessage({ id: id, type: 'error', message: String(err && err.message || err) });
    }
  }

  if (type === 'set-location') {
    if (!geo) { self.postMessage({ id: id, type: 'no-area-model' }); return; }
    try {
      // No (valid) recording date → whole year: max over weeks 1–48 (week 0, as in birdnet_v3.py).
      var refDate = e.data.date ? new Date(e.data.date) : null;
      var week = refDate && !isNaN(refDate.getTime()) ? geoWeek(refDate) : 0;
      var weeks = week ? [week] : Array.from({ length: 48 }, function (_, w) { return w + 1; });
      var x = new Float32Array(weeks.length * 3);
      weeks.forEach(function (w, r) { x[r * 3] = e.data.latitude; x[r * 3 + 1] = e.data.longitude; x[r * 3 + 2] = w; });
      var feeds = {};
      feeds[cfg.geoModel.inputName] = new ort.Tensor('float32', x, [weeks.length, 3]);
      var out = await geo.run(feeds);
      var all = out[cfg.geoModel.outputName].data;
      var n = all.length / weeks.length;
      var probs = new Float32Array(n);
      for (var r = 0; r < weeks.length; r++) for (var q = 0; q < n; q++) if (all[r * n + q] > probs[q]) probs[q] = all[r * n + q];
      // Align to audio labels; non-animal sound classes have no geo output → never filtered.
      geoscores = new Float32Array(labels.length);
      for (var i = 0; i < labels.length; i++) {
        geoscores[i] = labels[i].geoIx >= 0 ? probs[labels[i].geoIx] : 1;
      }
      self.postMessage({ id: id, type: 'area-scores-set', count: geoscores.length, week: week });
    } catch (err) {
      self.postMessage({ id: id, type: 'error', message: String(err && err.message || err) });
    }
  }

  if (type === 'geo-profile') {
    // Year profile (weeks 1–48) for a few species at one place. Leaves geoscores alone.
    if (!geo) { self.postMessage({ id: id, type: 'no-area-model' }); return; }
    try {
      var gx = new Float32Array(48 * 3);
      for (var gw = 0; gw < 48; gw++) { gx[gw * 3] = e.data.latitude; gx[gw * 3 + 1] = e.data.longitude; gx[gw * 3 + 2] = gw + 1; }
      var gf = {};
      gf[cfg.geoModel.inputName] = new ort.Tensor('float32', gx, [48, 3]);
      var gall = (await geo.run(gf))[cfg.geoModel.outputName].data;
      var gn = gall.length / 48;
      var profiles = {};
      (e.data.species || []).forEach(function (sci) {
        var li = labels.findIndex(function (l) { return l && l.scientific === sci; });
        var gi = li >= 0 ? labels[li].geoIx : -1;
        if (gi < 0) return;
        var arr = new Array(48);
        for (var w = 0; w < 48; w++) arr[w] = gall[w * gn + gi];
        profiles[sci] = arr;
      });
      self.postMessage({ id: id, type: 'geo-profile', profiles: profiles });
    } catch (err) {
      self.postMessage({ id: id, type: 'error', message: String(err && err.message || err) });
    }
  }

  if (type === 'clear-location') {
    geoscores = null;
    self.postMessage({ id: id, type: 'location-cleared' });
  }

  if (type === 'get-species-list') {
    var specList = [];
    for (var j = 0; j < labels.length; j++) {
      specList.push({
        scientific: labels[j].scientific,
        common:     labels[j].common,
        geoscore:   geoscores ? geoscores[j] : null,
      });
    }
    self.postMessage({ id: id, type: 'species-list', species: specList });
    return;
  }

  if (type === 'predict') {
    try {
      var on = cfg.audioModel.onnx;
      var f = {};
      f[on.inputName] = new ort.Tensor('float32', e.data.samples, [1, chunkSamples]);
      var res = await audio.run(f, [on.outputNames.predictions]);
      var p = res[on.outputNames.predictions].data;
      var predictions = [];
      for (var k = 0; k < p.length && k < labels.length; k++) {
        var c = multipliers ? p[k] * multipliers[k] : p[k];
        if (c > 0.01) {
          predictions.push({
            scientific: labels[k].scientific,
            common:     labels[k].common,
            confidence: c,
            geoscore:   geoscores ? geoscores[k] : 1,
          });
        }
      }
      self.postMessage({ id: id, type: 'predictions', predictions: predictions });
    } catch (err) {
      self.postMessage({ id: id, type: 'error', message: String(err && err.message || err) });
    }
  }
};
`;

/** Fetch `model_config.json` (BirdNET Live / V3.0 layout); null for TF.js model folders. */
async function fetchOnnxConfig(baseUrl: string): Promise<any | null> {
  try {
    const res = await fetch(baseUrl + 'model_config.json');
    if (!res.ok) return null;
    const cfg = await res.json();
    return cfg?.audioModel?.onnx ? cfg : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Audio resampling helper (browser only — uses OfflineAudioContext)
// ---------------------------------------------------------------------------
export async function resampleTo(channelData: Float32Array | number[], sourceSampleRate: number, TARGET_SR: number): Promise<Float32Array> {
  if (sourceSampleRate === TARGET_SR) return channelData instanceof Float32Array ? channelData : Float32Array.from(channelData as any);
  const duration = (channelData as any).length / sourceSampleRate;
  const targetLength = Math.ceil(duration * TARGET_SR);
  const offCtx = new OfflineAudioContext(1, targetLength, TARGET_SR);
  const buf = offCtx.createBuffer(1, (channelData as any).length, sourceSampleRate);
  buf.getChannelData(0).set(channelData as any);
  const src = offCtx.createBufferSource();
  src.buffer = buf;
  src.connect(offCtx.destination);
  src.start();
  const rendered = await offCtx.startRendering();
  return rendered.getChannelData(0);
}

// ---------------------------------------------------------------------------
// BirdNETInference — public API
// ---------------------------------------------------------------------------
export class BirdNETInference {
  date: any;
  overlap: any;
  minConfidence: any;
  geoThreshold: any;
  onProgress: any;
  sampleRate: any;
  terminate: any;
  postMessage: any;
  #worker: Worker | null = null;
  #pending: Map<number, (v: any) => void> = new Map();
  #nextId = 0;
  #loaded = false;
  #hasAreaModel = false;
  #sampleRate = TFJS_SR;
  #format: 'onnx' | 'tfjs' | null = null;
  #onLoadProgress: ((...args: any[]) => void) | null = null;

  /** Whether the model has been loaded successfully. */
  get loaded() { return this.#loaded; }

  /** Whether the area (geo) model was found and loaded alongside the main model. */
  get hasAreaModel() { return this.#hasAreaModel; }

  /** Format of the loaded model: 'onnx' (BirdNET+ V3.0) or 'tfjs' (BirdNET v2.4). */
  get format() { return this.#format; }

  /**
   * Load the BirdNET model into a Web Worker.
   *
   * @param {object}   opts
   * @param {string}   opts.modelUrl    Base URL of the model directory: either a BirdNET+ V3.0
   *                                    folder with model_config.json (ONNX) or a TF.js folder
   *                                    with model.json + shards + labels.json.
   * @param {function} [opts.onProgress] Called with (message, percent) during loading.
   * @returns {Promise<{ labelCount: number, hasAreaModel: boolean }>}
   */
  async load({ modelUrl, onProgress }: { modelUrl: string; onProgress?: (msg: string, percent: number) => void; }) {
    if (!modelUrl) throw new Error('modelUrl is required');

    // Resolve relative URLs against the page origin so the Blob-based Worker
    // (which has no meaningful base URL) can fetch the model files.
    let absoluteModelUrl = new URL(modelUrl, globalThis.location?.href).href;
    if (!absoluteModelUrl.endsWith('/')) absoluteModelUrl += '/';

    this.dispose();

    const onnxConfig = await fetchOnnxConfig(absoluteModelUrl);
    const blob = new Blob([onnxConfig ? ONNX_WORKER_SOURCE : TFJS_WORKER_SOURCE], { type: 'text/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    this.#worker = new Worker(blobUrl);
    URL.revokeObjectURL(blobUrl);

    this.#onLoadProgress = onProgress || null;

    this.#worker.onmessage = (e: MessageEvent) => {
      const { id, type } = (e.data as any);
      if (type === 'progress') {
        if (this.#onLoadProgress) this.#onLoadProgress((e.data as any).message, (e.data as any).percent);
        return;
      }
      const resolve = this.#pending.get(id);
      if (resolve) {
        this.#pending.delete(id);
        resolve((e.data as any));
      }
    };

    const result: any = await this.#send('load', { modelUrl: absoluteModelUrl, config: onnxConfig });
    this.#onLoadProgress = null;
    if (result.type === 'error') throw new Error(result.message);
    this.#loaded = true;
    this.#sampleRate = result.sampleRate || TFJS_SR;
    this.#format = result.format || 'tfjs';
    this.#hasAreaModel = result.hasAreaModel === true;
    return { labelCount: result.labelCount, hasAreaModel: this.#hasAreaModel };
  }

  /**
   * Update the geographic location used to weight species occurrence probabilities.
   * Requires the area model to be present alongside the main model.
   *
   * @param {number} latitude
   * @param {number} longitude
   * @param {object}  [opts]
   * @param {string|Date} [opts.date]  Recording date — used to determine the season week.
   *                                   Falls back to today if not provided or invalid.
   * @returns {Promise<{ok:boolean, week?:number}>}
   */
  async setLocation(latitude: number, longitude: number, { date }: { date?: string | Date } = {}) {
    if (!this.#loaded) return { ok: false };
    const dateStr = date instanceof Date ? date.toISOString() : (date ?? null);
    const result = await this.#send('set-location', { latitude, longitude, date: dateStr });
    if (result.type === 'area-scores-set') return { ok: true, week: result.week };
    return { ok: false };
  }

  /**
   * Return all loaded species with their current geoscores (occurrence probabilities).
   * Geoscore is null for each species if no location has been set yet.
   *
   * @returns {Promise<Array<{ scientific: string, common: string, geoscore: number|null }>>}
   */
  async getAllSpecies() {
    if (!this.#loaded) return [];
    const result = await this.#send('get-species-list', {});
    return result.type === 'species-list' ? result.species : [];
  }

  /**
   * Geomodel scores for weeks 1–48 (four per month) at one place, per species.
   * Does not change the location set with setLocation. Species without geo output are left out.
   * Returns null without an area model.
   */
  async getYearProfile(latitude: number, longitude: number, species: string[]): Promise<Record<string, number[]> | null> {
    if (!this.#loaded || !this.hasAreaModel) return null;
    const result = await this.#send('geo-profile', { latitude, longitude, species });
    return result.type === 'geo-profile' ? result.profiles : null;
  }

  /**
   * Clear the geographic location, disabling geo-filtering.
   * @returns {Promise<void>}
   */
  async clearLocation() {
    if (!this.#loaded) return;
    await this.#send('clear-location', {});
  }

  /**
   * Run BirdNET inference on the given mono PCM audio.
   *
   * @param {Float32Array} channelData   Mono PCM samples.
   * @param {object}       [opts]
   * @param {number}       [opts.sampleRate]     Source sample rate in Hz.
   * @param {number}       [opts.overlap]        Overlap between chunks in seconds (0–2.5).
   * @param {number}       [opts.minConfidence]  Minimum confidence to keep a detection (0–1).
   * @param {number}       [opts.geoThreshold]   Minimum geoscore to keep a detection (0 = disabled).
   * @param {function}     [opts.onProgress]     Called with a number 0–100 representing %.
   * @returns {Promise<Array<{ start: number, end: number, scientific: string, common: string, confidence: number, geoscore: number }>>}
   */
  async analyze(channelData: Float32Array | number[], opts: any = {}) {
    const { overlap = 0, minConfidence = 0.25, geoThreshold = 0, onProgress } = opts;
    if (!this.#loaded) throw new Error('Model not loaded — call load() first.');
    const TARGET_SR = this.#sampleRate;
    const CHUNK_SAMPLES = TARGET_SR * CHUNK_SECONDS;
    const sampleRate = opts.sampleRate || TARGET_SR;

    const pcm = await resampleTo(channelData, sampleRate, TARGET_SR);

    const overlapSamples = Math.round(overlap * TARGET_SR);
    const step = CHUNK_SAMPLES - overlapSamples;
    const totalChunks = Math.max(1, Math.ceil((pcm.length - CHUNK_SAMPLES) / step) + 1);

    const detections = [];

    for (let i = 0; i < totalChunks; i++) {
      const offset = i * step;
      let chunk;
      if (offset + CHUNK_SAMPLES <= pcm.length) {
        chunk = pcm.slice(offset, offset + CHUNK_SAMPLES);
      } else {
        chunk = new Float32Array(CHUNK_SAMPLES);
        chunk.set(pcm.subarray(offset));
      }

      if (onProgress) onProgress(Math.round((i / totalChunks) * 100));

      const result: any = await this.#send('predict', { samples: chunk }, [chunk.buffer]);
      if (result.type === 'error') throw new Error(result.message);

      const startSec = offset / TARGET_SR;
      const endSec = startSec + CHUNK_SECONDS;

      for (const pred of result.predictions) {
        if (pred.confidence >= minConfidence && pred.geoscore >= geoThreshold) {
          detections.push({
            start: startSec,
            end: Math.min(endSec, pcm.length / TARGET_SR),
            scientific: pred.scientific,
            common: pred.common,
            confidence: pred.confidence,
            geoscore: pred.geoscore,
          });
        }
      }
    }

    if (onProgress) onProgress(100);
    return detections;
  }

  /** Terminate the worker and release resources. */
  dispose() {
    if (this.#worker) {
      this.#worker.terminate();
      this.#worker = null;
    }
    this.#pending.clear();
    this.#loaded = false;
    this.#hasAreaModel = false;
    this.#format = null;
    this.#onLoadProgress = null;
  }

  // ── internal ──────────────────────────────────────────────────────

  #send(type: any, data: any = {}, transferables: any[] = []): Promise<any> {
    return new Promise((resolve) => {
      const id = this.#nextId++;
      this.#pending.set(id, resolve as any);
      if (this.#worker) (this.#worker as Worker).postMessage({ type, id, ...data }, transferables);
    });
  }
}

/** Worker sources, for tests only. */
export const __workerSourcesForTests = { tfjs: TFJS_WORKER_SOURCE, onnx: ONNX_WORKER_SOURCE };
