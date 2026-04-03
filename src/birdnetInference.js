/**
 * BirdNET browser inference via TensorFlow.js Web Worker.
 *
 * - TF.js is loaded from CDN at runtime (not bundled).
 * - The BirdNET model (TF.js Layers format) is fetched from a user-supplied URL
 *   or from the bundled model shipped with the GitHub Pages demo.
 * - Audio is resampled to 48 kHz and split into 3-second chunks for prediction.
 */

const TFJS_CDN = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4';
const TARGET_SR = 48000;
const CHUNK_SECONDS = 3;
const CHUNK_SAMPLES = TARGET_SR * CHUNK_SECONDS; // 144 000

/**
 * Default model URL pointing to the bundled BirdNET v2.4 TF.js model
 * on the GitHub Pages demo site.  npm users can use this as a convenient
 * fallback or host the model themselves.
 */
export const BIRDNET_MODEL_URL = 'https://limitlessgreen.github.io/Audio-Workbench/models/birdnet-v2.4/';

// ---------------------------------------------------------------------------
// Worker source — runs in a dedicated thread with WebGL-accelerated TF.js
// ---------------------------------------------------------------------------
const WORKER_SOURCE = `
importScripts('${TFJS_CDN}');

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

/* ── Worker message handler ── */
let model  = null;
let labels = [];

self.onmessage = async (e) => {
  var type = e.data.type;
  var id   = e.data.id;

  if (type === 'load') {
    try {
      await tf.setBackend('webgl');
      self.postMessage({ id: id, type: 'progress', message: 'Loading model\\u2026', percent: 10 });

      var base = e.data.modelUrl;
      if (!base.endsWith('/')) base += '/';

      model = await tf.loadLayersModel(base + 'model.json');

      self.postMessage({ id: id, type: 'progress', message: 'Warming up\\u2026', percent: 50 });
      model.predict(tf.zeros([1, ${CHUNK_SAMPLES}])).dispose();

      self.postMessage({ id: id, type: 'progress', message: 'Loading labels\\u2026', percent: 80 });
      var raw = await fetch(base + 'labels.json').then(function (r) { return r.json(); });
      labels = raw.map(function (l) {
        var s = String(l);
        var idx = s.indexOf('_');
        return idx >= 0
          ? { scientific: s.slice(0, idx), common: s.slice(idx + 1) }
          : { scientific: s, common: '' };
      });

      self.postMessage({ id: id, type: 'loaded', labelCount: labels.length });
    } catch (err) {
      self.postMessage({ id: id, type: 'error', message: String(err && err.message || err) });
    }
  }

  if (type === 'predict') {
    try {
      var pcm  = tf.tensor(e.data.samples, [1, ${CHUNK_SAMPLES}]);
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
// Audio resampling helper (browser only — uses OfflineAudioContext)
// ---------------------------------------------------------------------------
async function resampleTo48k(channelData, sourceSampleRate) {
  if (sourceSampleRate === TARGET_SR) return channelData;
  const duration = channelData.length / sourceSampleRate;
  const targetLength = Math.ceil(duration * TARGET_SR);
  const offCtx = new OfflineAudioContext(1, targetLength, TARGET_SR);
  const buf = offCtx.createBuffer(1, channelData.length, sourceSampleRate);
  buf.getChannelData(0).set(channelData);
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
  /** @type {Worker | null} */  #worker = null;
  /** @type {Map<number, function>} */ #pending = new Map();
  #nextId = 0;
  #loaded = false;
  /** @type {function | null} */ #onLoadProgress = null;

  /** Whether the model has been loaded successfully. */
  get loaded() { return this.#loaded; }

  /**
   * Load the BirdNET model into a Web Worker.
   *
   * @param {object}   opts
   * @param {string}   opts.modelUrl    Base URL of the TF.js model directory
   *                                    (must contain model.json + shards + labels.json).
   * @param {function} [opts.onProgress] Called with (message, percent) during loading.
   * @returns {Promise<{ labelCount: number }>}
   */
  async load({ modelUrl, onProgress }) {
    if (!modelUrl) throw new Error('modelUrl is required');

    // Resolve relative URLs against the page origin so the Blob-based Worker
    // (which has no meaningful base URL) can fetch the model files.
    const absoluteModelUrl = new URL(modelUrl, globalThis.location?.href).href;

    this.dispose();

    const blob = new Blob([WORKER_SOURCE], { type: 'text/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    this.#worker = new Worker(blobUrl);
    URL.revokeObjectURL(blobUrl);

    this.#onLoadProgress = onProgress || null;

    this.#worker.onmessage = (e) => {
      const { id, type } = e.data;
      if (type === 'progress') {
        if (this.#onLoadProgress) this.#onLoadProgress(e.data.message, e.data.percent);
        return;
      }
      const resolve = this.#pending.get(id);
      if (resolve) {
        this.#pending.delete(id);
        resolve(e.data);
      }
    };

    const result = await this.#send('load', { modelUrl: absoluteModelUrl });
    this.#onLoadProgress = null;
    if (result.type === 'error') throw new Error(result.message);
    this.#loaded = true;
    return { labelCount: result.labelCount };
  }

  /**
   * Run BirdNET inference on the given mono PCM audio.
   *
   * @param {Float32Array} channelData   Mono PCM samples.
   * @param {object}       [opts]
   * @param {number}       [opts.sampleRate]     Source sample rate in Hz.
   * @param {number}       [opts.overlap]        Overlap between chunks in seconds (0–2.5).
   * @param {number}       [opts.minConfidence]  Minimum confidence to keep a detection.
   * @param {function}     [opts.onProgress]     Called with a number 0–100 representing %.
   * @returns {Promise<Array<{ start: number, end: number, scientific: string, common: string, confidence: number }>>}
   */
  async analyze(channelData, opts = {}) {
    const { overlap = 0, minConfidence = 0.25, onProgress } = opts;
    const sampleRate = opts.sampleRate || TARGET_SR;
    if (!this.#loaded) throw new Error('Model not loaded — call load() first.');

    const pcm = await resampleTo48k(channelData, sampleRate);

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

      const result = await this.#send('predict', { samples: chunk }, [chunk.buffer]);
      if (result.type === 'error') throw new Error(result.message);

      const startSec = offset / TARGET_SR;
      const endSec = startSec + CHUNK_SECONDS;

      for (const pred of result.predictions) {
        if (pred.confidence >= minConfidence) {
          detections.push({
            start: startSec,
            end: Math.min(endSec, pcm.length / TARGET_SR),
            scientific: pred.scientific,
            common: pred.common,
            confidence: pred.confidence,
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
    this.#onLoadProgress = null;
  }

  // ── internal ──────────────────────────────────────────────────────

  #send(type, data = {}, transferables = []) {
    return new Promise((resolve) => {
      const id = this.#nextId++;
      this.#pending.set(id, resolve);
      if (this.#worker) this.#worker.postMessage({ type, id, ...data }, transferables);
    });
  }
}
