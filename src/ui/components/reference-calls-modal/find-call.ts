// Locate the strongest call in a reference recording.

/**
 * Find the window of length `dur` with the most energy inside [fMin, fMax].
 * Band-pass via OfflineAudioContext (native, fast), then a sliding energy sum.
 */
export async function findCall(buffer: AudioBuffer, fMin: number, fMax: number, dur: number) {
  const sr = buffer.sampleRate;
  const total = buffer.duration;
  const win = Math.min(Math.max(dur, 0.3), total);
  let data: Float32Array = buffer.getChannelData(0);

  const nyq = sr / 2;
  const lo = Math.max(20, Number.isFinite(fMin) ? fMin : 0);
  const hi = Math.min(nyq * 0.98, Number.isFinite(fMax) && fMax > lo ? fMax : nyq * 0.98);
  if (hi > lo && (lo > 50 || hi < nyq * 0.9) && typeof OfflineAudioContext !== 'undefined') {
    const ctx = new OfflineAudioContext(1, buffer.length, sr);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = lo;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';  lp.frequency.value = hi;
    src.connect(hp); hp.connect(lp); lp.connect(ctx.destination);
    src.start();
    data = (await ctx.startRendering()).getChannelData(0);
  }

  // Energy per 10 ms frame, then the best window of `win` seconds.
  const frame = Math.max(1, Math.round(sr * 0.01));
  const n = Math.floor(data.length / frame);
  const energy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let e = 0;
    for (let j = i * frame, end = j + frame; j < end; j++) e += data[j] * data[j];
    energy[i] = e;
  }
  const w = Math.min(n, Math.max(1, Math.round(win / 0.01)));
  let sum = 0, best = -1, bestAt = 0;
  for (let i = 0; i < n; i++) {
    sum += energy[i];
    if (i >= w) sum -= energy[i - w];
    if (i >= w - 1 && sum > best) { best = sum; bestAt = i - w + 1; }
  }
  const start = Math.max(0, bestAt * 0.01 - 0.1);
  return { start, end: Math.min(total, start + win + 0.2) };
}
