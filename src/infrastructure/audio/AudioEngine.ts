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
import { TIMEUPDATE_THROTTLE_MS } from '../../shared/constants.ts';

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
  const Ctor = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
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
  /**
   * @param {Function} WaveSurferCtor - WaveSurfer constructor (loaded at runtime)
   * @param {Object} [options]
   * @param {HTMLElement} [options.container] - Container element for WaveSurfer
   */
  constructor(WaveSurferCtor: unknown, options = {}) {
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
  async loadFromArrayBuffer(arrayBuffer: unknown, name: unknown) {
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
  async loadFromUrl(url: unknown) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
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
  async loadFromFile(file: unknown) {
    const arrayBuffer = await file.arrayBuffer();
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
    if (this.wavesurfer && this.audioBuffer) this.wavesurfer.playPause();
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
  seekToTime(timeSec: unknown, centerView = false, options = {}) {
    if (!this.audioBuffer) return;
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
  seekByDelta(deltaSec: unknown) {
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
  playSegment(startSec: unknown, endSec: unknown, options = {}) {
    if (!this.audioBuffer || !this.wavesurfer) return;
    this._clearPlaybackFilter();
    const dur = this.audioBuffer.duration;
    const start = clamp(startSec, 0, dur);
    const end = clamp(endSec, 0, dur);
    if (end - start < 0.01) return;
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
  playBandpassedSegment(startSec: unknown, endSec: unknown, freqMinHz: unknown, freqMaxHz: unknown, options = {}) {
    if (!this.audioBuffer) return;
    const dur = this.audioBuffer.duration;
    const start = clamp(startSec, 0, dur);
    const end = clamp(endSec, 0, dur);
    if (end - start < 0.01) return;
    const nyquist = Math.max(100, this.audioBuffer.sampleRate * 0.5 - 10);
    const fLo = Math.max(20, Math.min(freqMinHz, freqMaxHz, nyquist - 5));
    const fHi = clamp(Math.max(freqMinHz, freqMaxHz), fLo + 5, nyquist);
    const center = Math.sqrt(fLo * fHi);
    const bandwidth = Math.max(10, fHi - fLo);
    const q = clamp(center / bandwidth, 0.25, 40);

    this._stopCustomSegmentPlayback('stopped', start);
    this._clearPlaybackFilter();

    if (this.wavesurfer?.isPlaying()) {
      this._suppressNextPauseHandler = true;
      this.wavesurfer.pause();
    }
    this.seekToTime(start, false, { allowCustomPlayback: true });

    const Ctor = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
    if (!Ctor) {
      this.playSegment(start, end, { labelId: options?.labelId });
      return;
    }

    const token = ++this._segmentPlayToken;
    this.playbackMode = 'segment';
    this._activeSegmentLabelId = options?.labelId || null;
    this._activeSegmentStart = start;
    this._activeSegmentEnd = end;
    this._activeSegmentFilter = {
      type: 'bandpass',
      freqMinHz: fLo,
      freqMaxHz: fHi,
    };

    const ctx = new Ctor();
    const bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.value = center;
    bandpass.Q.value = q;

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
      startAtCtx: 0,
      runStartSec: start,
      sourceGeneration: 0,
      rafId: 0,
      currentTimeSec: start,
    };
    this._customSegmentPlayback = playback;
    this._startCustomSegmentSource(playback);
    this._emit('transportstatechange', { state: 'playing_segment', reason: 'bandpass-segment-start' });
    this._emit('segmentstart', { start, end, filter: { type: 'bandpass', freqMinHz: fLo, freqMaxHz: fHi } });

    const onFrame = () => {
      if (!this._customSegmentPlayback || this._customSegmentPlayback.token !== token) return;
      const elapsed = Math.max(0, ctx.currentTime - playback.startAtCtx);
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

  /**
   * Stops active segment playback.
   * @param {string} [reason]
   * @param {number|null} [targetTimeSec]
   */
  stopSegmentPlayback(reason = 'stopped', targetTimeSec = null) {
    this._stopCustomSegmentPlayback(reason, targetTimeSec);
  }

  /**
   * Sets the playback volume.
   * @param {number} val - 0 to 1
   */
  setVolume(val: unknown) {
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
  updateActiveSegmentFromLabel(label: unknown) {
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
  endNormalSegment(targetTimeSec: unknown) {
    this._clearActiveSegment();
    this._suppressNextPauseHandler = true;
    if (this.wavesurfer) {
      this.wavesurfer.pause();
      this.seekToTime(targetTimeSec, false);
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
  _setupWaveSurfer(source: unknown, name: unknown) {
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
      this.seekToTime(0, true);
      this._lastTimeupdateEmitAt = 0;
      this._emit('ready', {
        duration: this.audioBuffer?.duration || 0,
        sampleRate: this.audioBuffer?.sampleRate || 0,
      });
    });

    ws.on('timeupdate', (t: unknown) => {
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
  _startCustomSegmentSource(playback: unknown, source = null, startAtSec = null) {
    if (!playback || !this._customSegmentPlayback || this._customSegmentPlayback.token !== playback.token) return;
    playback.sourceGeneration = (playback.sourceGeneration || 0) + 1;
    const generation = playback.sourceGeneration;
    const nextSource = source || playback.ctx.createBufferSource();
    nextSource.buffer = this.audioBuffer;
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
    playback.runStartSec = startAtSec == null ? playback.startSec : clamp(startAtSec, playback.startSec, playback.endSec - 0.001);
    playback.startAtCtx = playback.ctx.currentTime + 0.005;
    nextSource.start(playback.startAtCtx, playback.runStartSec, playback.endSec - playback.runStartSec);
  }

  /**
   * @param {SegmentPlayback} playback
   */
  _loopCustomSegmentPlayback(playback: unknown) {
    if (!playback || !this._customSegmentPlayback || this._customSegmentPlayback.token !== playback.token) return;
    playback.currentTimeSec = playback.startSec;
    this._emit('uiupdate', { time: playback.startSec, fromPlayback: false, immediate: true });
    this._emit('segmentloop', { start: playback.startSec, end: playback.endSec, filter: 'bandpass' });
    this._startCustomSegmentSource(playback);
  }

  /**
   * @param {{ start: number, end: number, freqMinHz?: number, freqMaxHz?: number }} opts
   */
  _retargetCustomSegmentPlayback({ start, end, freqMinHz, freqMaxHz }) {
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
      const center = Math.sqrt(fLo * fHi);
      const bandwidth = Math.max(10, fHi - fLo);
      const q = clamp(center / bandwidth, 0.25, 40);
      playback.bandpass.frequency.value = center;
      playback.bandpass.Q.value = q;
      this._activeSegmentFilter = { type: 'bandpass', freqMinHz: fLo, freqMaxHz: fHi };
    }

    const desiredStart = clamp(playback.currentTimeSec || start, start, end - 0.001);
    this._restartCustomSegmentSource(playback, desiredStart);
  }

  /**
   * @param {SegmentPlayback} playback
   * @param {number} atSec
   */
  _restartCustomSegmentSource(playback: unknown, atSec: unknown) {
    if (!playback || !this._customSegmentPlayback || this._customSegmentPlayback.token !== playback.token) return;
    playback.sourceGeneration = (playback.sourceGeneration || 0) + 1;
    if (playback.source) {
      playback.source.onended = null;
      try { playback.source.stop(); } catch { /**/ }
      try { playback.source.disconnect(); } catch { /**/ }
      playback.source = null;
    }
    playback.currentTimeSec = atSec;
    this._emit('uiupdate', { time: atSec, fromPlayback: false, immediate: true });
    this._startCustomSegmentSource(playback, null, atSec);
  }

  /**
   * @param {string} [reason]
   * @param {number|null} [targetTimeSec]
   * @param {Object} [options]
   */
  _stopCustomSegmentPlayback(reason = 'stopped', targetTimeSec = null, options = {}) {
    const active = this._customSegmentPlayback;
    if (!active) return;

    if (active.rafId) cancelAnimationFrame(active.rafId);
    active.rafId = 0;
    if (active.source) {
      active.source.onended = null;
      try { active.source.stop(); } catch { /**/ }
      try { active.source.disconnect(); } catch { /**/ }
    }
    try { active.bandpass?.disconnect(); } catch { /**/ }
    try { active.gain.disconnect(); } catch { /**/ }
    try { active.ctx.close(); } catch { /**/ }

    this._customSegmentPlayback = null;
    this._clearActiveSegment();

    if (Number.isFinite(targetTimeSec)) {
      this._emit('uiupdate', { time: targetTimeSec, fromPlayback: false, immediate: true });
    }
    this._emit('pause', {});
    this._emit('transportstatechange', { state: reason === 'paused' ? 'paused_segment' : 'stopped', reason: 'bandpass-segment-stop' });
    if (options.emitEnd) {
      this._emit('segmentend', { end: targetTimeSec ?? 0 });
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
  _emit(eventName: unknown, detail: unknown) {
    this.dispatchEvent(new CustomEvent(eventName, { detail }));
  }

}