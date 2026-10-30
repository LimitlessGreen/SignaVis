// ═══════════════════════════════════════════════════════════════════════
// detectorRender.ts — heterodyne / frequency-division / pitch-shift output
// for a stretch of the recording, via aw-dsp (WASM).
//
// Pure helpers shared by the detector worker (playback) and the synchronous
// renderDetectorChunk (tests, main thread). Output time maps 1:1 to
// recording time: sample k of a chunk plays recording time
// chunk.startSec + k / chunk.buffer.sampleRate.
// ═══════════════════════════════════════════════════════════════════════

import { wasmMain } from '../wasm-dsp/wasmMain.ts';

export type ListenMode =
  | { kind: 'expansion'; factor: number }
  | { kind: 'heterodyne'; carrierHz: number; bandwidthHz?: number }
  | { kind: 'division'; divisor: number; envelope: boolean }
  | { kind: 'pitch'; factor: number };

export type DetectorMode = Exclude<ListenMode, { kind: 'expansion' }>;

export interface DetectorChunk {
  buffer: AudioBuffer;
  startSec: number;
  endSec: number;
}

/** The aw-dsp exports the detector modes need (main-thread or worker instance). */
export interface DetectorDsp {
  heterodyne(samples: Float32Array, sampleRate: number, firstSample: number, carrierHz: number, bandwidthHz: number): Float32Array;
  frequencyDivision(samples: Float32Array, sampleRate: number, divisor: number, highpassHz: number, noiseLevel: number, keepEnvelope: boolean): Float32Array;
  pitchShift(samples: Float32Array, sampleRate: number, factor: number): Float32Array;
  divisionNoiseLevel(samples: Float32Array, sampleRate: number, highpassHz: number): number;
  detectorDecimation(sampleRate: number): number;
  detectorOutputRate(sampleRate: number): number;
}

/** Default heterodyne bandwidth: what a hand-held detector passes. */
export const HETERODYNE_BANDWIDTH_HZ = 6000;
/** Front-end high-pass of the frequency divider. */
export const DIVISION_HIGHPASS_HZ = 15000;
/** Warm-up on both sides of a chunk, in input samples (≥ half the longest FIR, ≥ a vocoder frame). */
const PAD_SAMPLES = 4096;
/** Noise level of the divider: this many windows spread over the recording. */
const NOISE_WINDOWS = 200;
const NOISE_WINDOW_SAMPLES = 4096;

const noiseLevels = new WeakMap<AudioBuffer, number>();

export function listenModeKey(mode: ListenMode): string {
  return JSON.stringify(mode);
}

/** Recording-wide background level for the divider threshold, cached per buffer. */
export function divisionNoiseLevel(dsp: DetectorDsp, source: AudioBuffer): number {
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

export interface ChunkPlan {
  /** Input samples [lo, hi) handed to the detector, padded for warm-up. */
  lo: number;
  hi: number;
  /** Recording samples [s0, s1) the chunk plays; s0 on the decimation grid. */
  s0: number;
  s1: number;
  /** Output samples to drop (lead-in), and to keep. */
  skip: number;
  n: number;
  sampleRate: number;
  outRate: number;
}

export function planChunk(dsp: DetectorDsp, length: number, sampleRate: number, startSec: number, endSec: number): ChunkPlan {
  const dec = dsp.detectorDecimation(sampleRate);
  const pad = Math.ceil(PAD_SAMPLES / dec) * dec;
  // Align to the decimation grid so output sample k sits exactly at s0 + k·dec.
  const s0 = Math.floor((startSec * sampleRate) / dec) * dec;
  const s1 = Math.min(length, Math.ceil(endSec * sampleRate));
  const lo = Math.max(0, s0 - pad);
  const hi = Math.min(length, s1 + pad);
  return {
    lo, hi, s0, s1,
    skip: (s0 - lo) / dec,
    n: Math.max(1, Math.ceil((s1 - s0) / dec)),
    sampleRate,
    outRate: dsp.detectorOutputRate(sampleRate),
  };
}

/** Runs a detector mode on `input` = recording samples [lo, lo + input.length). */
export function runDetector(dsp: DetectorDsp, input: Float32Array, sampleRate: number, lo: number, mode: DetectorMode, noiseLevel: number): Float32Array {
  switch (mode.kind) {
    case 'heterodyne':
      return dsp.heterodyne(input, sampleRate, lo, mode.carrierHz, mode.bandwidthHz ?? HETERODYNE_BANDWIDTH_HZ);
    case 'pitch':
      return dsp.pitchShift(input, sampleRate, mode.factor);
    case 'division':
      return dsp.frequencyDivision(input, sampleRate, mode.divisor, DIVISION_HIGHPASS_HZ, noiseLevel, mode.envelope);
  }
}

/** Cuts the planned stretch out of the detector output into an AudioBuffer. */
export function toChunk(out: Float32Array, plan: ChunkPlan, mode: DetectorMode, gain: number): DetectorChunk {
  const buffer = new AudioBuffer({ length: plan.n, numberOfChannels: 1, sampleRate: plan.outRate });
  const ch = buffer.getChannelData(0);
  const g = mode.kind === 'division' ? 1 : gain;
  for (let k = 0; k < plan.n; k++) {
    const v = (out[plan.skip + k] ?? 0) * g;
    ch[k] = v > 1 ? 1 : v < -1 ? -1 : v;
  }
  return { buffer, startSec: plan.s0 / plan.sampleRate, endSec: plan.s1 / plan.sampleRate };
}

/**
 * Renders [startSec, endSec) of `source` on the main thread. Returns null while
 * the WASM module is not loaded yet. Playback uses the worker instead.
 * @param gain make-up gain for heterodyne / pitch output (the divider has a fixed level)
 */
export function renderDetectorChunk(
  source: AudioBuffer,
  mode: DetectorMode,
  startSec: number,
  endSec: number,
  gain = 1,
): DetectorChunk | null {
  const dsp = wasmMain();
  if (!dsp) return null;
  const plan = planChunk(dsp, source.length, source.sampleRate, startSec, endSec);
  const input = source.getChannelData(0).subarray(plan.lo, plan.hi);
  const noise = mode.kind === 'division' ? divisionNoiseLevel(dsp, source) : 0;
  return toChunk(runDetector(dsp, input, source.sampleRate, plan.lo, mode, noise), plan, mode, gain);
}
