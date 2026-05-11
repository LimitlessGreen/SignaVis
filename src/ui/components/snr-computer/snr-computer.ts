/**
 * SNR computation for labeled audio regions, via a Blob-based Web Worker.
 *
 * Algorithm:
 *  - Signal : samples within label.start … label.end
 *  - Noise  : equal-duration window immediately before (or after) the label
 *  - Bandpass filter applied when label has freqMin/freqMax (2nd-order Butterworth)
 *  - SNR_dB = 20 * log10(signal_rms / noise_rms)
 */

// ── Inline worker source ────────────────────────────────────────────────────

const WORKER_SOURCE = /* js */ `
// Audio EQ Cookbook biquad (R. Bristow-Johnson)
function biquadFilter(samples, fc, fs, type) {
  if (fc <= 0 || fc >= fs / 2) return samples;
  const w0 = 2 * Math.PI * fc / fs;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / Math.SQRT2; // Q = 1/sqrt(2) → Butterworth

  let b0, b1, b2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosW0;
  const a2 = 1 - alpha;

  if (type === 'lp') {
    b0 = (1 - cosW0) / 2;
    b1 =  1 - cosW0;
    b2 = (1 - cosW0) / 2;
  } else {
    b0 =  (1 + cosW0) / 2;
    b1 = -(1 + cosW0);
    b2 =  (1 + cosW0) / 2;
  }

  const nb0 = b0 / a0, nb1 = b1 / a0, nb2 = b2 / a0;
  const na1 = a1 / a0, na2 = a2 / a0;

  const out = new Float32Array(samples.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    const y0 = nb0*x0 + nb1*x1 + nb2*x2 - na1*y1 - na2*y2;
    out[i] = y0; x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}

function applyBandpass(samples, freqMin, freqMax, fs) {
  let s = samples;
  if (freqMin != null && freqMin > 0)        s = biquadFilter(s, freqMin, fs, 'hp');
  if (freqMax != null && freqMax < fs / 2)   s = biquadFilter(s, freqMax, fs, 'lp');
  return s;
}

function rms(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

self.onmessage = function (e) {
  const { id, sampleRate, signalSamples, noiseSamples, freqMin, freqMax } = e.data;
  try {
    const sig   = applyBandpass(signalSamples, freqMin, freqMax, sampleRate);
    const noise = applyBandpass(noiseSamples,  freqMin, freqMax, sampleRate);

    const sigRms   = rms(sig);
    const noiseRms = rms(noise);

    if (sigRms === 0 || noiseRms === 0) {
      self.postMessage({ id, status: 'error', error: 'silence' });
      return;
    }

    const snrDb = 20 * Math.log10(sigRms / noiseRms);
    self.postMessage({ id, status: 'done', value: snrDb });
  } catch (err) {
    self.postMessage({ id, status: 'error', error: String(err) });
  }
};
`;

// ── SnrComputer ─────────────────────────────────────────────────────────────

export class SnrComputer {
    // TypeScript property declarations (migrated from JS)
    _cache: any;
    _onResult: any;
    _timers: any;
    _worker: any;
  constructor() {
    /** @type {Map<string, {status: 'pending'|'done'|'error', value?: number}>} */
    this._cache = new Map();
    /** @type {Map<string, ReturnType<typeof setTimeout>>} */
    this._timers = new Map();
    /** @type {Worker|null} */
    this._worker = null;
    /** @type {((id: string, status: string, value?: number) => void)|null} */
    this._onResult = null;

    this._initWorker();
  }

  /** Called whenever a result (or error) arrives. */
  setOnResult(cb: any) { this._onResult = cb; }

  /**
   * Get current cached state for a label id.
   * @returns {{ status: 'pending'|'done'|'error', value?: number }|null}
   */
  getStatus(id: any) { return this._cache.get(id) ?? null; }

  /**
   * Schedule SNR computation for a label (debounced 300 ms).
   * @param {object} label  Label with start, end, freqMin?, freqMax?
   * @param {AudioBuffer} audioBuffer
   * @param {number} sampleRate
   */
  request(label: any, audioBuffer: any, sampleRate: any) {
    if (!label?.id || !audioBuffer) return;
    clearTimeout(this._timers.get(label.id));
    this._timers.set(label.id, setTimeout(() => {
      this._timers.delete(label.id);
      this._compute(label, audioBuffer, sampleRate);
    }, 300));
  }

  /**
   * Remove cached result and cancel any pending computation for a label.
   * @param {string} id
   */
  invalidate(id: any) {
    clearTimeout(this._timers.get(id));
    this._timers.delete(id);
    this._cache.delete(id);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  _initWorker() {
    const blob = new Blob([WORKER_SOURCE], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    this._worker = new Worker(url);
    URL.revokeObjectURL(url);

    this._worker.onmessage = (e: any) => {
      const { id, status, value } = e.data;
      this._cache.set(id, status === 'done' ? { status, value } : { status });
      this._onResult?.(id, status, value);
    };
    this._worker.onerror = (e: any) => {
      console.warn('[SnrComputer] Worker error:', e.message);
    };
  }

  _compute(label: any, audioBuffer: any, sampleRate: any) {
    const { id, start, end, freqMin, freqMax } = label;
    if (start == null || end == null || end <= start) return;

    const duration = end - start;
    const totalDuration = audioBuffer.duration;

    // Prefer noise window before the label; fall back to after.
    let noiseStart, noiseEnd;
    if (start >= duration) {
      noiseStart = start - duration;
      noiseEnd = start;
    } else if (end + duration <= totalDuration) {
      noiseStart = end;
      noiseEnd = end + duration;
    } else {
      // No room for a clean noise window
      this._cache.set(id, { status: 'error' });
      this._onResult?.(id, 'error');
      return;
    }

    // Extract slices from channel 0 (mono mix is fine for SNR estimation)
    const channelData = audioBuffer.getChannelData(0);
    const toIdx = (t: any) => Math.round(t * sampleRate);

    const signalSamples = channelData.slice(toIdx(start),      toIdx(end));
    const noiseSamples  = channelData.slice(toIdx(noiseStart), toIdx(noiseEnd));

    if (!signalSamples.length || !noiseSamples.length) return;

    this._cache.set(id, { status: 'pending' });
    this._onResult?.(id, 'pending');

    // Transfer ownership to avoid copying large buffers
    this._worker.postMessage(
      { id, sampleRate, signalSamples, noiseSamples, freqMin: freqMin ?? null, freqMax: freqMax ?? null },
      [signalSamples.buffer, noiseSamples.buffer],
    );
  }
}
