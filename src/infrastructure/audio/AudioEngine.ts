// ═══════════════════════════════════════════════════════════════════════
// AudioEngine.ts — WaveSurfer wrapper, transport & segment playback
//
// Handles all audio playback, WaveSurfer lifecycle, and AudioContext-based
// bandpass-filtered segment playback.
//
// Events emitted (via EventTarget):
//   'ready'                — { duration, sampleRate }
//   'uiupdate'             — { time, fromPlayback, centerView?, emitSeek?, immediate? }
//   'timeupdate'           — { currentTime, duration }   (throttled to ~15 fps)
//   'transportstatechange' — { state, reason }
//   'play'                 — {}
//   'pause'                — {}
//   'finish'               — {}
//   'segmentstart'         — { start, end, loop?, filter? }
//   'segmentend'           — { end }
//   'segmentloop'          — { start, end, filter }
//   'error'                — { message }
// ═══════════════════════════════════════════════════════════════════════

import { clamp, parseNativeSampleRate } from '../../shared/utils.ts';
import { AudioEngineBase } from './AudioEngineBase.ts';
import { parseGuano } from '../../domain/ultrasound.ts';
import { listenModeKey, type ListenMode, type DetectorChunk } from './detectorRender.ts';
import type { DetectorRenderer } from './detectorWorkerClient.ts';
import { TIMEUPDATE_THROTTLE_MS } from '../../shared/constants.ts';

/** Browsers reject playbackRate below 1/16. */
export const MAX_TIME_EXPANSION = 16;
/** Detector output: a short first chunk starts playback fast, then longer ones. */
const DETECTOR_FIRST_CHUNK_SEC = 1;
const DETECTOR_CHUNK_SEC = 5;
/** Request the next chunk this long before the current one runs out (render takes < 1 s). */
const DETECTOR_LOOKAHEAD_SEC = 2;
/** Rendered chunks kept per playback (label loops replay the same ones). */
const DETECTOR_CACHE_CHUNKS = 8;

export type { ListenMode };

function normalizeListenMode(mode: ListenMode): ListenMode {
  switch (mode?.kind) {
    case 'heterodyne':
      return { kind: 'heterodyne', carrierHz: Math.max(1000, Number(mode.carrierHz) || 40000), ...(mode.bandwidthHz ? { bandwidthHz: mode.bandwidthHz } : {}) };
    case 'division':
      return { kind: 'division', divisor: clamp(Math.round(Number(mode.divisor) || 10), 2, 64), envelope: !!mode.envelope };
    case 'pitch':
      return { kind: 'pitch', factor: clamp(Number(mode.factor) || 10, 1, 32) };
    default:
      return { kind: 'expansion', factor: clamp(Number((mode as any)?.factor) || 1, 1, MAX_TIME_EXPANSION) };
  }
}



/**
 * @typedef {Object} SegmentFilter
 * @property {'bandpass'} type
 * @property {number} freqMinHz
 * @property {number} freqMaxHz
 */

/**
 * @typedef {Object} SegmentPlayback
 * @property {number} token
 * @property {AudioContext} ctx
 * @property {AudioBufferSourceNode|null} source
 * @property {BiquadFilterNode} bandpass
 * @property {GainNode} gain
 * @property {number} startSec
 * @property {number} endSec
 * @property {number} startAtCtx
 * @property {number} runStartSec
 * @property {number} sourceGeneration
 * @property {number} rafId
 * @property {number} currentTimeSec
 */

/**
 * Decode an ArrayBuffer into an AudioBuffer, preserving the file's native
 * sample rate by pre-parsing the header before creating the AudioContext.
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<AudioBuffer>}
 */
async function decodeArrayBuffer(arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
  const Ctor: any = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!Ctor) throw new Error('AudioContext is not supported by this browser.');
  const nativeSr = parseNativeSampleRate(arrayBuffer);
  const ctx = new Ctor(nativeSr > 0 ? { sampleRate: nativeSr } : undefined);
  try {
    return await ctx.decodeAudioData(arrayBuffer);
  } finally {
    ctx.close?.().catch(() => {});
  }
}

/**
 * AudioEngine — Wraps WaveSurfer and audio playback.
 * Extends EventTarget for event emission.
 */
export class AudioEngine extends AudioEngineBase {
  webkitAudioContext: any;
  _WaveSurferCtor: any;
  _container: HTMLElement | null;
  audioBuffer: AudioBuffer | null;
  wavesurfer: any;
  volume: number;
  muted: boolean;
  preMuteVolume: number;
  _segmentMode: boolean;
  _activeSegmentLabelId: string | null;
  _activeSegmentFilter: any | null;
  _activeSegmentStart: number | null;
  _activeSegmentEnd: number | null;
  _suppressNextPauseHandler: boolean;
  _segmentPlayToken: number;
  _customSegmentPlayback: any | null;
  _lastTimeupdateEmitAt: number;
  pixelsPerSecond: number;
  loopPlayback: boolean;
  timeExpansion: number;
  listenMode: ListenMode;
  _detector: DetectorRenderer | null;
  _detectorLoading: Promise<DetectorRenderer> | null;
  _peakFor: AudioBuffer | null;
  _peak: number;
  guano: Record<string, string> | null;
  ctx: any;
  bandpass: any;
  emitEnd: any;
  /**
   * @param {Function} WaveSurferCtor - WaveSurfer constructor (loaded at runtime)
   * @param {Object} [options]
   * @param {HTMLElement} [options.container] - Container element for WaveSurfer
   */
  constructor(WaveSurferCtor: any, options: any = {}) {
    super();
    this._WaveSurferCtor = WaveSurferCtor;
    this._container = options.container || null;

    // ── State ──────────────────────────────────────────────────────────
    /** @type {AudioBuffer|null} */
    this.audioBuffer = null;
    /** @type {any|null} WaveSurfer instance */
    this.wavesurfer = null;
    /** @type {number} Volume 0-1 */
    this.volume = 0.8;
    /** @type {boolean} */
    this.muted = false;
    /** @type {number} Volume before mute */
    this.preMuteVolume = 0.8;
    /** @type {boolean} True while a segment (labelled or unlabelled) is the active playback target. */
    this._segmentMode = false;
    /** @type {string|null} */
    this._activeSegmentLabelId = null;
    /** @type {SegmentFilter|null} */
    this._activeSegmentFilter = null;
    /** @type {number|null} */
    this._activeSegmentStart = null;
    /** @type {number|null} */
    this._activeSegmentEnd = null;
    /** @type {boolean} */
    this._suppressNextPauseHandler = false;
    /** @type {number} */
    this._segmentPlayToken = 0;
    /** @type {SegmentPlayback|null} */
    this._customSegmentPlayback = null;
    /** @type {number} */
    this._lastTimeupdateEmitAt = 0;
    /** @type {number} */
    this.pixelsPerSecond = 100;
    /** @type {boolean} */
    this.loopPlayback = false;
    /** @type {number} Playback slowdown with pitch dropping along (×10 makes bat calls audible). */
    this.timeExpansion = 1;
    /** @type {ListenMode} How playback makes ultrasound audible (time expansion ×1 = plain). */
    this.listenMode = { kind: 'expansion', factor: 1 };
    this._detector = null;
    this._detectorLoading = null;
    this._peakFor = null;
    this._peak = 1;
    /** @type {Record<string,string>|null} GUANO metadata of the loaded WAV (bat detectors). */
    this.guano = null;
  }

  // ── Derived state ────────────────────────────────────────────────────

  /** @returns {'normal'|'segment'} */
  get playbackMode() { return this._segmentMode ? 'segment' : 'normal'; }
  set playbackMode(v) { this._segmentMode = (v === 'segment'); }

  // ── Public API ───────────────────────────────────────────────────────

  /**
   * Loads audio from an ArrayBuffer.
   * @param {ArrayBuffer} arrayBuffer
   * @param {string} [name] - Display filename
   * @returns {Promise<{duration: number, sampleRate: number}>}
   */
  async loadFromArrayBuffer(arrayBuffer: ArrayBuffer, name?: string) {
    this.guano = parseGuano(arrayBuffer);
    const audioBuffer = await decodeArrayBuffer(arrayBuffer);
    this.audioBuffer = audioBuffer;

    const displayName = name || 'audio';
    this._setupWaveSurfer(null, displayName);
    return { duration: audioBuffer.duration, sampleRate: audioBuffer.sampleRate };
  }

  /**
   * Loads audio from a URL.
   * @param {string} url
   * @returns {Promise<{duration: number, sampleRate: number}>}
   */
  async loadFromUrl(url: string) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    this.guano = parseGuano(arrayBuffer);
    const audioBuffer = await decodeArrayBuffer(arrayBuffer);
    this.audioBuffer = audioBuffer;

    const name = decodeURIComponent(
      new URL(url, location.href).pathname.split('/').pop() || 'audio',
    );
    this._setupWaveSurfer(url, name);
    return { duration: audioBuffer.duration, sampleRate: audioBuffer.sampleRate };
  }

  /**
   * Loads audio from a File object (WaveSurfer loads the file directly via loadBlob).
   * @param {File} file
   * @returns {Promise<{duration: number, sampleRate: number}>}
   */
  async loadFromFile(file: File) {
    const arrayBuffer = await file.arrayBuffer();
    this.guano = parseGuano(arrayBuffer);
    const audioBuffer = await decodeArrayBuffer(arrayBuffer);
    this.audioBuffer = audioBuffer;
    this._setupWaveSurfer(file, file.name);
    return { duration: audioBuffer.duration, sampleRate: audioBuffer.sampleRate };
  }

  /**
   * Toggles playback (play/pause).
   */
  playPause() {
    if (this._customSegmentPlayback) {
      this._stopCustomSegmentPlayback('paused', this._customSegmentPlayback.currentTimeSec);
      return;
    }
    this._clearActiveSegment();
    if (!this.wavesurfer || !this.audioBuffer) return;
    if (this._isDetectorMode()) {
      this._playDetectorFull(this.wavesurfer.getCurrentTime());
      return;
    }
    this.wavesurfer.playPause();
  }

  /**
   * Stops playback and seeks to the beginning.
   */
  stop() {
    if (this._customSegmentPlayback) {
      this._stopCustomSegmentPlayback('stopped', 0);
    }
    if (!this.wavesurfer) return;
    this._clearActiveSegment();
    this.wavesurfer.pause();
    this.seekToTime(0);
    this._emit('transportstatechange', { state: 'stopped', reason: 'stop-control' });
    this._emit('pause', {});
  }

  /**
   * Seeks to a specific time.
   * @param {number} timeSec
   * @param {boolean} [centerView=false]
   * @param {Object} [options]
   */
  seekToTime(timeSec: number, centerView = false, options: any = {}) {
    if (!this.audioBuffer) return;
    const custom = this._customSegmentPlayback;
    if (custom?.full && options.allowCustomPlayback !== true) {
      // Detector playback of the whole file keeps playing from the new position.
      const t = clamp(timeSec, 0, this.audioBuffer.duration);
      if (this.wavesurfer) this.wavesurfer.setTime(t);
      this._restartCustomSegmentSource(custom, t);
      this._emit('uiupdate', { time: t, fromPlayback: false, centerView, emitSeek: true, immediate: true });
      return;
    }
    if (this._customSegmentPlayback && options.allowCustomPlayback !== true) {
      this._stopCustomSegmentPlayback('paused', this._customSegmentPlayback.currentTimeSec);
    }
    const t = clamp(timeSec, 0, this.audioBuffer.duration);
    if (this.wavesurfer) this.wavesurfer.setTime(t);
    this._emit('uiupdate', { time: t, fromPlayback: false, centerView, emitSeek: true, immediate: true });
  }

  /**
   * Seeks relative to the current time.
   * @param {number} deltaSec
   */
  seekByDelta(deltaSec: number) {
    if (!this.audioBuffer) return;
    this.seekToTime(this.getCurrentTime() + deltaSec, false);
  }

  /**
   * Returns the current playback time.
   * @returns {number}
   */
  getCurrentTime() {
    if (this._customSegmentPlayback) return this._customSegmentPlayback.currentTimeSec;
    return this.wavesurfer ? this.wavesurfer.getCurrentTime() : 0;
  }

  /**
   * Plays a time segment using WaveSurfer's native segment playback.
   * @param {number} startSec
   * @param {number} endSec
   * @param {Object} [options]
   * @param {string} [options.labelId]
   */
  playSegment(startSec: number, endSec: number, options: any = {}) {
    if (!this.audioBuffer || !this.wavesurfer) return;
    this._clearPlaybackFilter();
    const dur = this.audioBuffer.duration;
    const start = clamp(startSec, 0, dur);
    const end = clamp(endSec, 0, dur);
    if (end - start < 0.01) return;
    if (this._isDetectorMode()) {
      this._startCustomPlayback({ start, end, labelId: options?.labelId || null });
      return;
    }
    this._clearActiveSegment();
    const token = this._segmentPlayToken;
    this.playbackMode = 'segment';
    this._activeSegmentLabelId = options?.labelId || null;
    this._activeSegmentFilter = null;
    this._activeSegmentStart = start;
    this._activeSegmentEnd = end;
    if (this.wavesurfer.isPlaying()) {
      this._suppressNextPauseHandler = true;
      this.wavesurfer.pause();
    }
    this.seekToTime(start, false);
    if (token !== this._segmentPlayToken) return;

    const runPlay = () => {
      if (token !== this._segmentPlayToken) return;
      try {
        if (this.loopPlayback) {
          this.seekToTime(start, false, { allowCustomPlayback: true });
          this.wavesurfer.play();
          this._emit('segmentstart', { start, end, loop: true });
          return;
        }
        // Prefer native segment playback if available in this WaveSurfer build.
        const maybePromise = this.wavesurfer.play(start, end);
        this._emit('segmentstart', { start, end });
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.catch(() => {
            if (token !== this._segmentPlayToken) return;
            this.seekToTime(start, false);
            this.wavesurfer?.play();
          });
        }
      } catch {
        if (token !== this._segmentPlayToken) return;
        this.seekToTime(start, false);
        this.wavesurfer?.play();
        this._emit('segmentstart', { start, end });
      }
    };

    try {
      // One frame delay prevents play/pause races after click+drag interactions.
      window.requestAnimationFrame(runPlay);
    } catch {
      runPlay();
    }
  }

  /**
   * Plays a bandpass-filtered segment via a dedicated AudioContext graph.
   * @param {number} startSec
   * @param {number} endSec
   * @param {number} freqMinHz
   * @param {number} freqMaxHz
   * @param {Object} [options]
   * @param {string} [options.labelId]
   */
  playBandpassedSegment(startSec: number, endSec: number, freqMinHz: number, freqMaxHz: number, options: any = {}) {
    if (!this.audioBuffer) return;
    const dur = this.audioBuffer.duration;
    const start = clamp(startSec, 0, dur);
    const end = clamp(endSec, 0, dur);
    if (end - start < 0.01) return;
    const nyquist = Math.max(100, this.audioBuffer.sampleRate * 0.5 - 10);
    const fLo = Math.max(20, Math.min(freqMinHz, freqMaxHz, nyquist - 5));
    const fHi = clamp(Math.max(freqMinHz, freqMaxHz), fLo + 5, nyquist);

    this._startCustomPlayback({ start, end, freqMinHz: fLo, freqMaxHz: fHi, labelId: options?.labelId || null });
  }

  /**
   * Plays [start, end] through a dedicated AudioContext graph: bandpassed when
   * frequencies are given, through the bat detector in heterodyne / division
   * mode. `full` is ordinary playback of the whole file in a detector mode.
   */
  _startCustomPlayback({ start, end, freqMinHz = null, freqMaxHz = null, labelId = null, full = false, startAt = start }: {
    start: number; end: number; freqMinHz?: number | null; freqMaxHz?: number | null;
    labelId?: string | null; full?: boolean; startAt?: number;
  }) {
    this._stopCustomSegmentPlayback('stopped', startAt);
    this._clearPlaybackFilter();

    if (this.wavesurfer?.isPlaying()) {
      this._suppressNextPauseHandler = true;
      this.wavesurfer.pause();
    }
    this.seekToTime(startAt, false, { allowCustomPlayback: true });

    const Ctor: any = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) {
      if (!this._isDetectorMode()) this.playSegment(start, end, { labelId });
      return;
    }

    const filtered = freqMinHz != null && freqMaxHz != null;
    const token = ++this._segmentPlayToken;
    if (!full) {
      this.playbackMode = 'segment';
      this._activeSegmentLabelId = labelId;
      this._activeSegmentStart = start;
      this._activeSegmentEnd = end;
      this._activeSegmentFilter = filtered ? { type: 'bandpass', freqMinHz, freqMaxHz } : null;
    }

    const ctx = new Ctor();
    const bandpass = ctx.createBiquadFilter();
    if (filtered) {
      const bp = this._bandpassParams(freqMinHz!, freqMaxHz!);
      bandpass.frequency.value = bp.frequency;
      bandpass.Q.value = bp.q;
    }

    const gain = ctx.createGain();
    gain.gain.value = this.muted ? 0 : this.volume;

    bandpass.connect(gain);
    gain.connect(ctx.destination);

    /** @type {SegmentPlayback} */
    const playback = {
      token,
      ctx,
      source: null,
      bandpass,
      gain,
      startSec: start,
      endSec: end,
      freqMinHz,
      freqMaxHz,
      filtered,
      full,
      detectorSources: [] as AudioBufferSourceNode[],
      chunkCache: new Map<string, Promise<DetectorChunk>>(),
      timeExpansion: this.timeExpansion,
      startAtCtx: 0,
      runStartSec: startAt,
      sourceGeneration: 0,
      rafId: 0,
      currentTimeSec: startAt,
    };
    this._customSegmentPlayback = playback;
    this._startCustomSegmentSource(playback, null, startAt);
    if (this._customSegmentPlayback !== playback) return;
    if (full) {
      this._emit('play', {});
      this._emit('transportstatechange', { state: this.loopPlayback ? 'playing_loop' : 'playing', reason: 'detector-start' });
    } else {
      this._emit('transportstatechange', { state: 'playing_segment', reason: 'bandpass-segment-start' });
      this._emit('segmentstart', { start, end, ...(filtered ? { filter: { type: 'bandpass', freqMinHz, freqMaxHz } } : {}) });
    }

    const onFrame = () => {
      if (!this._customSegmentPlayback || this._customSegmentPlayback.token !== token) return;
      const elapsed = Math.max(0, ctx.currentTime - playback.startAtCtx) / playback.timeExpansion;
      const t = Math.min(playback.endSec, playback.runStartSec + elapsed);
      playback.currentTimeSec = t;
      this._emit('uiupdate', { time: t, fromPlayback: true });
      if (t >= playback.endSec - 0.002) {
        if (this.loopPlayback) {
          this._loopCustomSegmentPlayback(playback);
          playback.rafId = requestAnimationFrame(onFrame);
          return;
        }
        this._stopCustomSegmentPlayback('stopped', playback.endSec, { emitEnd: true });
        return;
      }
      playback.rafId = requestAnimationFrame(onFrame);
    };

    playback.rafId = requestAnimationFrame(onFrame);
  }

  /** Detector-mode playback of the whole file from `fromSec`. */
  _playDetectorFull(fromSec: number) {
    if (!this.audioBuffer) return;
    const dur = this.audioBuffer.duration;
    const t = fromSec >= dur - 0.01 ? 0 : clamp(fromSec, 0, dur);
    this._startCustomPlayback({ start: 0, end: dur, full: true, startAt: t });
  }

  _isDetectorMode() {
    return this.listenMode.kind !== 'expansion';
  }

  /** Worker that renders the detector modes, loaded on first use. */
  _loadDetector(): Promise<DetectorRenderer> {
    this._detectorLoading ??= import('./detectorWorkerClient.ts')
      .then((m) => m.DetectorRenderer.create())
      .then((r) => (this._detector = r));
    this._detectorLoading.catch(() => { this._detectorLoading = null; });
    return this._detectorLoading;
  }

  /** Detector output for [atSec, endSec), from the playback's cache or the worker. */
  _detectorRender(playback: any, atSec: number, endSec: number): Promise<DetectorChunk> {
    const mode = this.listenMode;
    if (mode.kind === 'expansion' || !this.audioBuffer || !this._detector) {
      return Promise.reject(new Error('detector not ready'));
    }
    const cache: Map<string, Promise<DetectorChunk>> = playback.chunkCache;
    const key = `${listenModeKey(mode)}|${atSec.toFixed(6)}|${endSec.toFixed(6)}`;
    let chunk = cache.get(key);
    if (!chunk) {
      chunk = this._detector.render(this.audioBuffer, mode, atSec, endSec, this._heterodyneGain());
      chunk.catch(() => cache.delete(key));
      cache.set(key, chunk);
      if (cache.size > DETECTOR_CACHE_CHUNKS) cache.delete(cache.keys().next().value!);
    }
    return chunk;
  }

  /**
   * Detector playback from `runStart`: chunks render in the worker and play back
   * to back on the AudioContext clock, each requested DETECTOR_LOOKAHEAD_SEC
   * before the previous one runs out. The playhead (runStartSec + elapsed)
   * waits for the first chunk; a late chunk shifts it by the gap.
   */
  _startDetectorChain(playback: any, runStart: number, generation: number) {
    const ctx = playback.ctx;
    this._stopDetectorSources(playback);
    playback.bandpass.type = 'allpass'; // the detector selects the band itself
    playback.timeExpansion = 1;
    playback.runStartSec = runStart;
    playback.startAtCtx = Infinity;
    const live = () => this._customSegmentPlayback === playback && playback.sourceGeneration === generation;

    const schedule = (atSec: number, whenCtx: number | null, lenSec: number) => {
      this._detectorRender(playback, atSec, Math.min(playback.endSec, atSec + lenSec)).then((chunk) => {
        if (!live()) return;
        let when = whenCtx ?? ctx.currentTime + 0.01;
        const late = ctx.currentTime + 0.005 - when;
        if (late > 0) {
          when += late;
          if (Number.isFinite(playback.startAtCtx)) playback.startAtCtx += late;
        }
        if (!Number.isFinite(playback.startAtCtx)) playback.startAtCtx = when;
        const until = Math.min(playback.endSec, chunk.endSec);
        const src = ctx.createBufferSource();
        src.buffer = chunk.buffer;
        src.connect(playback.bandpass);
        src.start(when, atSec - chunk.startSec, Math.max(0.001, until - atSec));
        playback.detectorSources.push(src);
        if (playback.detectorSources.length > 3) playback.detectorSources.shift(); // long finished
        if (until >= playback.endSec - 0.001) return; // the frame loop ends or loops
        const endsAt = when + (until - atSec);
        const delayMs = Math.max(0, (endsAt - ctx.currentTime - DETECTOR_LOOKAHEAD_SEC) * 1000);
        setTimeout(() => { if (live()) schedule(until, endsAt, DETECTOR_CHUNK_SEC); }, delayMs);
      }).catch((err) => {
        if (!live()) return;
        this._stopCustomSegmentPlayback('paused', playback.currentTimeSec);
        this._emit('error', { message: `Detector playback failed: ${err?.message || err}` });
      });
    };
    schedule(runStart, null, DETECTOR_FIRST_CHUNK_SEC);
  }

  _stopDetectorSources(playback: any) {
    for (const src of playback.detectorSources || []) {
      try { src.stop(); } catch { /**/ }
      try { src.disconnect(); } catch { /**/ }
    }
    playback.detectorSources = [];
  }

  /** Make-up gain so the loudest call reaches about -2 dBFS after heterodyning / pitch shifting. */
  _heterodyneGain() {
    if (!this.audioBuffer) return 1;
    if (this._peakFor !== this.audioBuffer) {
      const ch = this.audioBuffer.getChannelData(0);
      let peak = 0;
      for (let i = 0; i < ch.length; i++) {
        const a = Math.abs(ch[i]);
        if (a > peak) peak = a;
      }
      this._peakFor = this.audioBuffer;
      this._peak = peak;
    }
    return clamp(0.8 / Math.max(this._peak, 1e-4), 1, 30);
  }

  /**
   * Stops active segment playback.
   * @param {string} [reason]
   * @param {number|null} [targetTimeSec]
   */
  stopSegmentPlayback(reason = 'stopped', targetTimeSec = null) {
    this._stopCustomSegmentPlayback(reason, targetTimeSec);
  }

  /**
   * Slows playback down by `factor` without preserving pitch, so ultrasonic
   * content drops by the same factor. Only the output changes: times stay in
   * recording time. Browsers cap playbackRate at 1/16.
   * @param {number} factor
   */
  setTimeExpansion(factor: number) {
    this.setListenMode({ kind: 'expansion', factor });
  }

  /**
   * How playback makes ultrasound audible: time expansion, a heterodyne /
   * frequency-division detector as in field work, or real-time pitch shift. Spectrogram, labels and
   * playhead stay in recording time. Playing audio continues at the same spot.
   */
  setListenMode(mode: ListenMode) {
    const next = normalizeListenMode(mode);
    if (listenModeKey(next) === listenModeKey(this.listenMode)) return;
    if (next.kind !== 'expansion' && !this._detector) {
      this._loadDetector().then(() => this.setListenMode(next)).catch((err) => {
        this._emit('error', { message: `Detector DSP failed to load: ${err?.message || err}` });
      });
      return;
    }

    const custom = this._customSegmentPlayback;
    const wsPlaying = !custom && !!this.wavesurfer?.isPlaying();
    const t = this.getCurrentTime();
    this.listenMode = next;
    this.timeExpansion = next.kind === 'expansion' ? next.factor : 1;
    this._applyPlaybackRate();
    this._emit('listenmodechange', { mode: next });

    if (custom) {
      if (custom.full && next.kind === 'expansion') {
        this._stopCustomSegmentPlayback('paused', t);
        this.wavesurfer?.play();
        return;
      }
      if (custom.filtered) {
        // The bandpass sits behind the source: re-centre it on the new output frequencies.
        const bp = this._bandpassParams(custom.freqMinHz, custom.freqMaxHz);
        custom.bandpass.frequency.value = bp.frequency;
        custom.bandpass.Q.value = bp.q;
      }
      this._restartCustomSegmentSource(custom, t);
    } else if (wsPlaying && next.kind !== 'expansion') {
      const segment = this.playbackMode === 'segment' && this._activeSegmentEnd != null
        ? { start: this._activeSegmentStart ?? 0, end: this._activeSegmentEnd, labelId: this._activeSegmentLabelId }
        : null;
      this._suppressNextPauseHandler = true;
      this.wavesurfer.pause();
      if (segment) this._startCustomPlayback({ ...segment, startAt: t });
      else this._playDetectorFull(t);
    }
  }

  _applyPlaybackRate() {
    if (!this.wavesurfer) return;
    try { this.wavesurfer.setPlaybackRate(1 / this.timeExpansion, this.timeExpansion === 1); } catch { /**/ }
  }

  /**
   * Bandpass centre and Q for [fLo, fHi] in recording frequencies. The filter
   * sits behind the slowed-down source, so it is centred on output frequencies.
   */
  _bandpassParams(fLo: number, fHi: number) {
    const center = Math.sqrt(fLo * fHi);
    const bandwidth = Math.max(10, fHi - fLo);
    return { frequency: center / this.timeExpansion, q: clamp(center / bandwidth, 0.25, 40) };
  }

  /**
   * Sets the playback volume.
   * @param {number} val - 0 to 1
   */
  setVolume(val: number) {
    this.volume = clamp(val, 0, 1);
    if (this.wavesurfer) this.wavesurfer.setVolume(this.volume);
    if (this._customSegmentPlayback?.gain) {
      this._customSegmentPlayback.gain.gain.value = this.muted ? 0 : this.volume;
    }
  }

  /**
   * Toggles mute on/off.
   */
  toggleMute() {
    if (this.muted) {
      this.muted = false;
      this.setVolume(this.preMuteVolume);
    } else {
      this.preMuteVolume = this.volume;
      this.muted = true;
      if (this.wavesurfer) this.wavesurfer.setVolume(0);
      if (this._customSegmentPlayback?.gain) this._customSegmentPlayback.gain.gain.value = 0;
    }
  }

  /**
   * Returns whether audio is currently playing.
   * @returns {boolean}
   */
  isPlaying() {
    return this.wavesurfer?.isPlaying() || this._customSegmentPlayback !== null;
  }

  /**
   * Updates the active segment based on a label.
   * @param {Object} label - Label with start, end, freqMin, freqMax
   */
  updateActiveSegmentFromLabel(label: any) {
    if (!label || this.playbackMode !== 'segment') return;
    const labelId = label.id || null;
    if (this._activeSegmentLabelId && labelId && this._activeSegmentLabelId !== labelId) return;
    const dur = this.audioBuffer?.duration || 0;
    if (dur <= 0) return;

    const start = clamp(Number(label.start ?? 0), 0, dur);
    const end = clamp(Number(label.end ?? start + 0.01), start + 0.01, dur);
    this._activeSegmentStart = start;
    this._activeSegmentEnd = end;

    if (this._customSegmentPlayback) {
      this._retargetCustomSegmentPlayback({ start, end, freqMinHz: Number(label.freqMin), freqMaxHz: Number(label.freqMax) });
      return;
    }

    const now = this.getCurrentTime();
    if (now < start || now > end) {
      this.seekToTime(start, false, { allowCustomPlayback: true });
      if (this.loopPlayback && !this.wavesurfer?.isPlaying()) this.wavesurfer?.play();
    }
  }

  /**
   * Ends a normal (non-bandpass) segment, resets segment state, and pauses playback.
   * Called by PlayerState when the segment end is reached during normal WaveSurfer playback.
   * @param {number} targetTimeSec
   */
  endNormalSegment(targetTimeSec?: number) {
    this._clearActiveSegment();
    this._suppressNextPauseHandler = true;
    if (this.wavesurfer) {
      this.wavesurfer.pause();
      this.seekToTime(Number(targetTimeSec ?? 0), false);
    }
  }

  /**
   * Destroys the engine and releases all resources.
   */
  destroy() {
    if (this._customSegmentPlayback) {
      this._stopCustomSegmentPlayback('stopped', 0);
    }
    if (this.wavesurfer) {
      this.wavesurfer.destroy();
      this.wavesurfer = null;
    }
    this.audioBuffer = null;
  }

  // ── WaveSurfer Setup ─────────────────────────────────────────────────

  /**
   * @param {string|File|Blob|null} source - URL string, File/Blob, or null
   * @param {string} [name] - display name
   */
  _setupWaveSurfer(source: any, name: any) {
    if (this.wavesurfer) this.wavesurfer.destroy();

    // Support WaveSurfer builds that expose a static `create()` or are constructible.
    const WaveSurferCtor = /** @type {any} */ (this._WaveSurferCtor);
    const wsOptions = {
      container: this._container,
      height: 1,
      waveColor: '#38bdf8',
      progressColor: '#0ea5e9',
      cursorColor: '#ef4444',
      normalize: true,
      minPxPerSec: this.pixelsPerSecond,
      autoScroll: false,
      autoCenter: false,
    };
    const ws = (WaveSurferCtor && typeof WaveSurferCtor.create === 'function')
      ? WaveSurferCtor.create(wsOptions)
      : new WaveSurferCtor(wsOptions);

    // Accept both URL strings (data:, http:, blob:) and File/Blob objects
    if (typeof source === 'string') {
      ws.load(source);
    } else if (source instanceof Blob) {
      // File extends Blob — works for both File and raw Blob
      ws.loadBlob(source);
    }

    ws.on('ready', () => {
      ws.zoom(this.pixelsPerSecond);
      ws.setVolume(this.volume);
      this._applyPlaybackRate();
      this.seekToTime(0, true);
      this._lastTimeupdateEmitAt = 0;
      this._emit('ready', {
        duration: this.audioBuffer?.duration || 0,
        sampleRate: this.audioBuffer?.sampleRate || 0,
      });
    });

    ws.on('timeupdate', (t: number) => {
      // Drive the UI on every frame during normal WaveSurfer playback
      this._emit('uiupdate', { time: t, fromPlayback: true });
      const now = performance.now();
      if (now - this._lastTimeupdateEmitAt >= TIMEUPDATE_THROTTLE_MS) {
        this._lastTimeupdateEmitAt = now;
        this._emit('timeupdate', {
          currentTime: t,
          duration: this.audioBuffer?.duration || 0,
        });
      }
    });

    ws.on('play', () => {
      this._emit('play', {});
      if (this.playbackMode === 'segment') {
        this._emit('transportstatechange', { state: 'playing_segment', reason: 'engine-play' });
        return;
      }
      this._emit('transportstatechange', { state: this.loopPlayback ? 'playing_loop' : 'playing', reason: 'engine-play' });
    });

    ws.on('pause', () => {
      if (this._suppressNextPauseHandler) {
        this._suppressNextPauseHandler = false;
        return;
      }
      this._emit('pause', {});
      if (this.playbackMode === 'segment' && this._activeSegmentEnd != null) {
        this._emit('transportstatechange', { state: 'paused_segment', reason: 'engine-pause' });
      } else if (this.audioBuffer) {
        const atEnd = ws.getCurrentTime() >= this.audioBuffer.duration - 0.01;
        this._emit('transportstatechange', { state: atEnd ? 'stopped' : 'paused', reason: 'engine-pause' });
      } else {
        this._emit('transportstatechange', { state: 'paused', reason: 'engine-pause' });
      }
    });

    ws.on('finish', () => {
      if (this.playbackMode === 'segment') {
        this._clearActiveSegment();
      }
      if (this.loopPlayback) {
        this.seekToTime(0, this.loopPlayback);
        ws.play();
        return;
      }
      this._emit('finish', {});
      this._emit('transportstatechange', { state: 'stopped', reason: 'engine-finish' });
      if (this.audioBuffer) this._emit('uiupdate', { time: this.audioBuffer.duration, fromPlayback: false, immediate: true });
    });

    this.wavesurfer = ws;
  }

  // ── Custom Segment Playback (AudioContext) ──────────────────────────

  /**
   * @param {SegmentPlayback} playback
   * @param {AudioBufferSourceNode|null} [source]
   * @param {number|null} [startAtSec]
   */
  _startCustomSegmentSource(playback: any, source: AudioBufferSourceNode | null = null, startAtSec: number | null = null) {
    if (!playback || !this._customSegmentPlayback || this._customSegmentPlayback.token !== playback.token) return;
    playback.sourceGeneration = (playback.sourceGeneration || 0) + 1;
    const generation = playback.sourceGeneration;
    const runStart = startAtSec == null ? playback.startSec : clamp(startAtSec, playback.startSec, playback.endSec - 0.001);
    if (this._isDetectorMode()) {
      if (!this._detector) {
        this._stopCustomSegmentPlayback('paused', runStart);
        this._emit('error', { message: 'Detector DSP is still loading, try again in a moment.' });
        void this._loadDetector();
        return;
      }
      playback.source = null;
      this._startDetectorChain(playback, runStart, generation);
      return;
    }
    this._stopDetectorSources(playback);
    const nextSource = source || playback.ctx.createBufferSource();
    nextSource.buffer = this.audioBuffer;
    nextSource.playbackRate.value = 1 / this.timeExpansion;
    playback.timeExpansion = this.timeExpansion;
    playback.bandpass.type = playback.filtered ? 'bandpass' : 'allpass';
    nextSource.connect(playback.bandpass);
    nextSource.onended = () => {
      if (!this._customSegmentPlayback || this._customSegmentPlayback.token !== playback.token) return;
      if (playback.sourceGeneration !== generation) return;
      if (this.loopPlayback) {
        this._loopCustomSegmentPlayback(playback);
        return;
      }
      this._stopCustomSegmentPlayback('stopped', playback.endSec, { emitEnd: true });
    };
    playback.source = nextSource;
    playback.runStartSec = runStart;
    playback.startAtCtx = playback.ctx.currentTime + 0.005;
    nextSource.start(playback.startAtCtx, runStart, playback.endSec - runStart);
  }

  /**
   * @param {SegmentPlayback} playback
   */
  _loopCustomSegmentPlayback(playback: any) {
    if (!playback || !this._customSegmentPlayback || this._customSegmentPlayback.token !== playback.token) return;
    playback.currentTimeSec = playback.startSec;
    this._emit('uiupdate', { time: playback.startSec, fromPlayback: false, immediate: true });
    this._emit('segmentloop', { start: playback.startSec, end: playback.endSec, filter: 'bandpass' });
    this._startCustomSegmentSource(playback);
  }

  /**
   * @param {{ start: number, end: number, freqMinHz?: number, freqMaxHz?: number }} opts
   */
  _retargetCustomSegmentPlayback({ start, end, freqMinHz, freqMaxHz }: { start: number; end: number; freqMinHz?: number; freqMaxHz?: number }) {
    const playback = this._customSegmentPlayback;
    if (!playback || !this.audioBuffer) return;

    playback.startSec = start;
    playback.endSec = end;

    const hasFreq = Number.isFinite(freqMinHz) && Number.isFinite(freqMaxHz);
    if (hasFreq) {
      const nyquist = Math.max(100, this.audioBuffer.sampleRate * 0.5 - 10);
      const fMin = Number(freqMinHz);
      const fMax = Number(freqMaxHz);
      const fLo = Math.max(20, Math.min(fMin, fMax, nyquist - 5));
      const fHi = clamp(Math.max(fMin, fMax), fLo + 5, nyquist);
      const bp = this._bandpassParams(fLo, fHi);
      playback.bandpass.frequency.value = bp.frequency;
      playback.bandpass.Q.value = bp.q;
      playback.freqMinHz = fLo;
      playback.freqMaxHz = fHi;
      this._activeSegmentFilter = { type: 'bandpass', freqMinHz: fLo, freqMaxHz: fHi };
    }

    const desiredStart = clamp(playback.currentTimeSec || start, start, end - 0.001);
    this._restartCustomSegmentSource(playback, desiredStart);
  }

  /**
   * @param {SegmentPlayback} playback
   * @param {number} atSec
   */
  _restartCustomSegmentSource(playback: any, atSec: number) {
    if (!playback || !this._customSegmentPlayback || this._customSegmentPlayback.token !== playback.token) return;
    playback.sourceGeneration = (playback.sourceGeneration || 0) + 1;
    if (playback.source) {
      playback.source.onended = null;
      try { playback.source.stop(); } catch { /**/ }
      try { playback.source.disconnect(); } catch { /**/ }
      playback.source = null;
    }
    this._stopDetectorSources(playback);
    playback.currentTimeSec = atSec;
    this._emit('uiupdate', { time: atSec, fromPlayback: false, immediate: true });
    this._startCustomSegmentSource(playback, null, atSec);
  }

  /**
   * @param {string} [reason]
   * @param {number|null} [targetTimeSec]
   * @param {Object} [options]
   */
  _stopCustomSegmentPlayback(reason: string = 'stopped', targetTimeSec: number | null = null, options: any = {}) {
    const active = this._customSegmentPlayback;
    if (!active) return;

    if (active.rafId) cancelAnimationFrame(active.rafId);
    active.rafId = 0;
    if (active.source) {
      active.source.onended = null;
      try { active.source.stop(); } catch { /**/ }
      try { active.source.disconnect(); } catch { /**/ }
    }
    this._stopDetectorSources(active);
    try { active.bandpass?.disconnect(); } catch { /**/ }
    try { active.gain.disconnect(); } catch { /**/ }
    try { active.ctx.close(); } catch { /**/ }

    this._customSegmentPlayback = null;
    this._clearActiveSegment();

    if (Number.isFinite(targetTimeSec as number)) {
      // Detector playback of the whole file resumes from here.
      if (active.full) this.wavesurfer?.setTime(targetTimeSec as number);
      this._emit('uiupdate', { time: targetTimeSec as number, fromPlayback: false, immediate: true });
    }
    this._emit('pause', {});
    const paused = reason === 'paused';
    this._emit('transportstatechange', {
      state: paused ? (active.full ? 'paused' : 'paused_segment') : 'stopped',
      reason: active.full ? 'detector-stop' : 'bandpass-segment-stop',
    });
    if (options && (options as any).emitEnd) {
      if (active.full) this._emit('finish', {});
      else this._emit('segmentend', { end: targetTimeSec ?? 0 });
    }
  }

  _clearPlaybackFilter() {
    if (!this.wavesurfer) return;
    if (typeof this.wavesurfer.setFilter === 'function') {
      try { this.wavesurfer.setFilter(null); } catch { /**/ }
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  /**
   * Reset all active-segment state to idle.
   * Call this from every path that ends or cancels segment playback.
   */
  _clearActiveSegment() {
    this._activeSegmentLabelId = null;
    this._activeSegmentFilter = null;
    this._activeSegmentStart = null;
    this._activeSegmentEnd = null;
    this.playbackMode = 'normal';
    this._segmentPlayToken++;
  }

  /**
   * @param {string} eventName
   * @param {any} detail
   */
  _emit(eventName: string, detail: any) {
    this.dispatchEvent(new CustomEvent(String(eventName), { detail }));
  }

}