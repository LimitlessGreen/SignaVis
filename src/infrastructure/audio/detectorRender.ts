// ═══════════════════════════════════════════════════════════════════════
// detectorRender.ts — heterodyne / frequency-division output for a stretch
// of the recording, via aw-dsp (WASM, main thread).
//
// Output time maps 1:1 to recording time: sample k of a chunk plays
// recording time chunk.startSec + k / chunk.buffer.sampleRate.
// ═══════════════════════════════════════════════════════════════════════

import { wasmMain } from '../wasm-dsp/wasmMain.ts';

export type ListenMode =
  | { kind: 'expansion'; factor: number }
  | { kind: 'heterodyne'; carrierHz: number; bandwidthHz?: number }
  | { kind: 'division'; divisor: number; envelope: boolean };

export interface DetectorChunk {
  buffer: AudioBuffer;
  startSec: number;
  endSec: number;
  /** listenModeKey() of the mode it was rendered with. */
  key: string;
}

/** Default heterodyne bandwidth: what a hand-held detector passes. */
export const HETERODYNE_BANDWIDTH_HZ = 6000;
/** Front-end high-pass of the frequency divider. */
export const DIVISION_HIGHPASS_HZ = 15000;
/** Filter warm-up on both sides of a chunk, in input samples (≥ half the longest FIR). */
const PAD_SAMPLES = 2048;
/** Noise level of the divider: this many windows spread over the recording. */
const NOISE_WINDOWS = 200;
const NOISE_WINDOW_SAMPLES = 4096;

const noiseLevels = new WeakMap<AudioBuffer, number>();

/** Recording-wide background level for the divider threshold, cached per buffer. */
function divisionNoiseLevel(dsp: NonNullable<ReturnType<typeof wasmMain>>, source: AudioBuffer): number {
  const cached = noiseLevels.get(source);
  if (cached != null) return cached;
  const ch = source.getChannelData(0);
  const windows = Math.min(NOISE_WINDOWS, Math.max(1, Math.floor(ch.length / NOISE_WINDOW_SAMPLES)));
  const len = Math.min(ch.length, NOISE_WINDOW_SAMPLES);
  const step = windows > 1 ? (ch.length - len) / (windows - 1) : 0;
  const sample = new Float32Array(windows * len);
  for (let w = 0; w < windows; w++) {
    const at = Math.round(w * step);
    sample.set(ch.subarray(at, at + len), w * len);
  }
  const level = dsp.divisionNoiseLevel(sample, source.sampleRate, DIVISION_HIGHPASS_HZ);
  noiseLevels.set(source, level);
  return level;
}

export function listenModeKey(mode: ListenMode): string {
  return JSON.stringify(mode);
}

/**
 * Renders [startSec, endSec) of `source` in a detector mode. Returns null while
 * the WASM module is not loaded yet.
 * @param gain applied to heterodyne output (the divider has a fixed level)
 */
export function renderDetectorChunk(
  source: AudioBuffer,
  mode: Exclude<ListenMode, { kind: 'expansion' }>,
  startSec: number,
  endSec: number,
  gain = 1,
): DetectorChunk | null {
  const dsp = wasmMain();
  if (!dsp) return null;

  const sr = source.sampleRate;
  const dec = dsp.detectorDecimation(sr);
  const outRate = dsp.detectorOutputRate(sr);
  const pad = Math.ceil(PAD_SAMPLES / dec) * dec;

  // Align to the decimation grid so output sample k sits exactly at s0 + k·dec.
  const s0 = Math.floor((startSec * sr) / dec) * dec;
  const s1 = Math.min(source.length, Math.ceil(endSec * sr));
  const lo = Math.max(0, s0 - pad);
  const hi = Math.min(source.length, s1 + pad);
  const input = source.getChannelData(0).subarray(lo, hi);

  const out = mode.kind === 'heterodyne'
    ? dsp.heterodyne(input, sr, lo, mode.carrierHz, mode.bandwidthHz ?? HETERODYNE_BANDWIDTH_HZ)
    : dsp.frequencyDivision(input, sr, mode.divisor, DIVISION_HIGHPASS_HZ, divisionNoiseLevel(dsp, source), mode.envelope);

  const skip = (s0 - lo) / dec;
  const n = Math.max(1, Math.ceil((s1 - s0) / dec));
  const buffer = new AudioBuffer({ length: n, numberOfChannels: 1, sampleRate: outRate });
  const ch = buffer.getChannelData(0);
  const g = mode.kind === 'heterodyne' ? gain : 1;
  for (let k = 0; k < n; k++) {
    const v = (out[skip + k] ?? 0) * g;
    ch[k] = v > 1 ? 1 : v < -1 ? -1 : v;
  }
  return { buffer, startSec: s0 / sr, endSec: s1 / sr, key: listenModeKey(mode) };
}
