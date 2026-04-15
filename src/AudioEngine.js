// ═══════════════════════════════════════════════════════════════════════
// AudioEngine.js — WaveSurfer wrapper, transport & segment playback
//
// Handles all audio playback, WaveSurfer lifecycle, and AudioContext-based
// bandpass-filtered segment playback.
//
// Events emitted (via EventTarget):
//   'ready'           — { duration, sampleRate }
//   'timeupdate'      — { currentTime, duration }
//   'play'            — {}
//   'pause'           — {}
//   'finish'          — {}
//   'segmentstart'    — { start, end, loop, filter? }
//   'segmentend'      — { start, end }
//   'segmentloop'     — { start, end, filter }
//   'error'           — { message }
// ═══════════════════════════════════════════════════════════════════════

import { clamp } from './utils.js';

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
 * sample rate when possible (instead of resampling to AudioContext default).
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<AudioBuffer>}
 */
async function decodeArrayBuffer(arrayBuffer) {
  const Ctor = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
  if (!Ctor) throw new Error('No AudioContext available');
  const tempCtx = new Ctor();
  try {
    const audioBuffer = await tempCtx.decodeAudioData(arrayBuffer.slice(0));
    // Preserve native sample rate
    if (audioBuffer.sampleRate !== tempCtx.sampleRate) {
      const offlineCtx = new OfflineAudioContext(
        audioBuffer.numberOfChannels,
        audioBuffer.length,
        audioBuffer.sampleRate,
      );
      const source = offlineCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(offlineCtx.destination);
      source.start();
      const renderedBuffer = await offlineCtx.startRendering();
      tempCtx.close();
      return renderedBuffer;
    }
    const result = audioBuffer;
    tempCtx.close();
    return result;
  } catch {
    tempCtx.close();
    throw new Error('Failed to decode audio data');
  }
}

/**
 * AudioEngine — Abstrahiert WaveSurfer und Audio-Wiedergabe.
 * Erbt von EventTarget für Event-Emission.
 */
export class AudioEngine extends EventTarget {
  /**
   * @param {Function} WaveSurferCtor - WaveSurfer constructor (loaded at runtime)
   * @param {Object} [options]
   * @param {Function} [options.onUiUpdate] - Callback for UI updates: (time, fromPlayback, options) => void
   * @param {Function} [options.onTransportStateChange] - Callback: (state, reason) => void
   * @param {Function} [options.onPlayPauseBtnUpdate] - Callback: (hasPlayingClass) => void
   */
  constructor(WaveSurferCtor, options = {}) {
    super();
    this._WaveSurferCtor = WaveSurferCtor;
    this._onUiUpdate = options.onUiUpdate || (() => {});
    this._onTransportStateChange = options.onTransportStateChange || (() => {});
    this._onPlayPauseBtnUpdate = options.onPlayPauseBtnUpdate || (() => {});

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
    /** @type {'normal'|'segment'} */
    this.playbackMode = 'normal';
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

  // ── Public API ───────────────────────────────────────────────────────

  /**
   * Lädt Audio aus einem ArrayBuffer
   * @param {ArrayBuffer} arrayBuffer
   * @param {string} [name] - Dateiname für Anzeige
   * @returns {Promise<{duration: number, sampleRate: number}>}
   */
  async loadFromArrayBuffer(arrayBuffer, name) {
    const audioBuffer = await decodeArrayBuffer(arrayBuffer);
    this.audioBuffer = audioBuffer;

    const displayName = name || 'audio';
    this._setupWaveSurfer(null, displayName);
    return { duration: audioBuffer.duration, sampleRate: audioBuffer.sampleRate };
  }

  /**
   * Lädt Audio von einer URL
   * @param {string} url
   * @returns {Promise<{duration: number, sampleRate: number}>}
   */
  async loadFromUrl(url) {
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
   * Spielt ab / pausiert
   */
  playPause() {
    if (this._customSegmentPlayback) {
      this._stopCustomSegmentPlayback('paused', this._customSegmentPlayback.currentTimeSec);
      return;
    }
    this.playbackMode = 'normal';
    this._activeSegmentLabelId = null;
    this._activeSegmentFilter = null;
    this._activeSegmentStart = null;
    this._activeSegmentEnd = null;
    this._segmentPlayToken++;
    if (this.wavesurfer && this.audioBuffer) this.wavesurfer.playPause();
  }

  /**
   * Stoppt Wiedergabe
   */
  stop() {
    if (this._customSegmentPlayback) {
      this._stopCustomSegmentPlayback('stopped', 0);
    }
    if (!this.wavesurfer) return;
    this.playbackMode = 'normal';
    this._activeSegmentLabelId = null;
    this._activeSegmentFilter = null;
    this._activeSegmentStart = null;
    this._activeSegmentEnd = null;
    this._segmentPlayToken++;
    this.wavesurfer.pause();
    this.seekToTime(0);
    this._onTransportStateChange('stopped', 'stop-control');
    this._onPlayPauseBtnUpdate(false);
  }

  /**
   * Spult zu einer bestimmten Zeit
   * @param {number} timeSec
   * @param {boolean} [centerView=false]
   * @param {Object} [options]
   */
  seekToTime(timeSec, centerView = false, options = {}) {
    if (!this.audioBuffer) return;
    if (this._customSegmentPlayback && options.allowCustomPlayback !== true) {
      this._stopCustomSegmentPlayback('paused', this._customSegmentPlayback.currentTimeSec);
    }
    const t = clamp(timeSec, 0, this.audioBuffer.duration);
    if (this.wavesurfer) this.wavesurfer.setTime(t);
    this._onUiUpdate(t, false, { centerView, emitSeek: true, immediate: true });
  }

  /**
   * Spult relativ
   * @param {number} deltaSec
   */
  seekByDelta(deltaSec) {
    if (!this.audioBuffer) return;
    this.seekToTime(this.getCurrentTime() + deltaSec, false);
  }

  /**
   * Gibt aktuelle Zeit zurück
   * @returns {number}
   */
  getCurrentTime() {
    if (this._customSegmentPlayback) return this._customSegmentPlayback.currentTimeSec;
    return this.wavesurfer ? this.wavesurfer.getCurrentTime() : 0;
  }

  /**
   * Spielt ein Segment ab
   * @param {number} startSec
   * @param {number} endSec
   * @param {Object} [options]
   * @param {string} [options.labelId]
   */
  playSegment(startSec, endSec, options = {}) {
    if (!this.audioBuffer || !this.wavesurfer) return;
    this._clearPlaybackFilter();
    const dur = this.audioBuffer.duration;
    const start = clamp(startSec, 0, dur);
    const end = clamp(endSec, 0, dur);
    if (end - start < 0.01) return;
    const token = ++this._segmentPlayToken;
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
   * Spielt ein bandpass-gefiltertes Segment ab
   * @param {number} startSec
   * @param {number} endSec
   * @param {number} freqMinHz
   * @param {number} freqMaxHz
   * @param {Object} [options]
   * @param {string} [options.labelId]
   */
  playBandpassedSegment(startSec, endSec, freqMinHz, freqMaxHz, options = {}) {
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
    this._onTransportStateChange('playing_segment', 'bandpass-segment-start');
    this._emit('segmentstart', { start, end, filter: { type: 'bandpass', freqMinHz: fLo, freqMaxHz: fHi } });

    const onFrame = () => {
      if (!this._customSegmentPlayback || this._customSegmentPlayback.token !== token) return;
      const elapsed = Math.max(0, ctx.currentTime - playback.startAtCtx);
      const t = Math.min(playback.endSec, playback.runStartSec + elapsed);
      playback.currentTimeSec = t;
      this._onUiUpdate(t, true);
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
   * Stoppt Segment-Wiedergabe
   * @param {string} [reason]
   * @param {number|null} [targetTimeSec]
   */
  stopSegmentPlayback(reason = 'stopped', targetTimeSec = null) {
    this._stopCustomSegmentPlayback(reason, targetTimeSec);
  }

  /**
   * Setzt Lautstärke
   * @param {number} val - 0 bis 1
   */
  setVolume(val) {
    this.volume = clamp(val, 0, 1);
    if (this.wavesurfer) this.wavesurfer.setVolume(this.volume);
    if (this._customSegmentPlayback?.gain) {
      this._customSegmentPlayback.gain.gain.value = this.muted ? 0 : this.volume;
    }
  }

  /**
   * Toggle Stumm
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
   * Prüft ob gerade gespielt wird
   * @returns {boolean}
   */
  isPlaying() {
    return this.wavesurfer?.isPlaying() || this._customSegmentPlayback !== null;
  }

  /**
   * Aktualisiert ein aktives Segment basierend auf einem Label
   * @param {Object} label - Label mit start, end, freqMin, freqMax
   */
  updateActiveSegmentFromLabel(label) {
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
   * Zerstört Engine und gibt Ressourcen frei
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
   * @param {string|null} source - URL or null for blob
   * @param {string} [name] - display name
   */
  _setupWaveSurfer(source, name) {
    if (this.wavesurfer) this.wavesurfer.destroy();

    // Support WaveSurfer builds that expose a static `create()` or are constructible.
    const WaveSurferCtor = /** @type {any} */ (this._WaveSurferCtor);
    const wsOptions = {
      container: null, // Will be set by PlayerState
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
    if (source) {
      ws.load(source);
    } else if (this.audioBuffer) {
      // Create blob from audioBuffer for WaveSurfer
      const offlineCtx = new OfflineAudioContext(
        this.audioBuffer.numberOfChannels,
        this.audioBuffer.length,
        this.audioBuffer.sampleRate,
      );
      const sourceNode = offlineCtx.createBufferSource();
      sourceNode.buffer = this.audioBuffer;
      sourceNode.connect(offlineCtx.destination);
      sourceNode.start();
      offlineCtx.startRendering().then((renderedBuffer) => {
        const wav = this._audioBufferToWav(renderedBuffer);
        const blob = new Blob([wav], { type: 'audio/wav' });
        ws.loadBlob(blob);
      });
    }

    ws.on('ready', () => {
      ws.zoom(this.pixelsPerSecond);
      ws.setVolume(this.volume);
      this.seekToTime(0, true);
      this._lastTimeupdateEmitAt = 0;
    });

    ws.on('timeupdate', (t) => {
      const now = performance.now();
      if (now - this._lastTimeupdateEmitAt >= 66) {
        this._lastTimeupdateEmitAt = now;
        this._emit('timeupdate', {
          currentTime: t,
          duration: this.audioBuffer?.duration || 0,
        });
      }
    });

    ws.on('play', () => {
      this._onPlayPauseBtnUpdate(true);
      if (this.playbackMode === 'segment') {
        this._onTransportStateChange('playing_segment', 'engine-play');
        return;
      }
      this._onTransportStateChange(this.loopPlayback ? 'playing_loop' : 'playing', 'engine-play');
    });

    ws.on('pause', () => {
      if (this._suppressNextPauseHandler) {
        this._suppressNextPauseHandler = false;
        return;
      }
      this._onPlayPauseBtnUpdate(false);
      if (this.playbackMode === 'segment' && this._activeSegmentEnd != null) {
        this._onTransportStateChange('paused_segment', 'engine-pause');
      } else if (this.audioBuffer) {
        const atEnd = ws.getCurrentTime() >= this.audioBuffer.duration - 0.01;
        this._onTransportStateChange(atEnd ? 'stopped' : 'paused', 'engine-pause');
      } else {
        this._onTransportStateChange('paused', 'engine-pause');
      }
    });

    ws.on('finish', () => {
      if (this.playbackMode === 'segment') {
        this.playbackMode = 'normal';
        this._activeSegmentLabelId = null;
        this._activeSegmentFilter = null;
        this._activeSegmentStart = null;
        this._activeSegmentEnd = null;
        this._segmentPlayToken++;
      }
      if (this.loopPlayback) {
        this.seekToTime(0, this.loopPlayback);
        ws.play();
        return;
      }
      this._onPlayPauseBtnUpdate(false);
      this._onTransportStateChange('stopped', 'engine-finish');
      if (this.audioBuffer) this._onUiUpdate(this.audioBuffer.duration, false, { immediate: true });
    });

    this.wavesurfer = ws;
  }

  // ── Custom Segment Playback (AudioContext) ──────────────────────────

  /**
   * @param {SegmentPlayback} playback
   * @param {AudioBufferSourceNode|null} [source]
   * @param {number|null} [startAtSec]
   */
  _startCustomSegmentSource(playback, source = null, startAtSec = null) {
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
  _loopCustomSegmentPlayback(playback) {
    if (!playback || !this._customSegmentPlayback || this._customSegmentPlayback.token !== playback.token) return;
    playback.currentTimeSec = playback.startSec;
    this._onUiUpdate(playback.startSec, false, { immediate: true });
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
  _restartCustomSegmentSource(playback, atSec) {
    if (!playback || !this._customSegmentPlayback || this._customSegmentPlayback.token !== playback.token) return;
    playback.sourceGeneration = (playback.sourceGeneration || 0) + 1;
    if (playback.source) {
      playback.source.onended = null;
      try { playback.source.stop(); } catch { /**/ }
      try { playback.source.disconnect(); } catch { /**/ }
      playback.source = null;
    }
    playback.currentTimeSec = atSec;
    this._onUiUpdate(atSec, false, { immediate: true });
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
    this._activeSegmentLabelId = null;
    this._activeSegmentFilter = null;
    this._activeSegmentStart = null;
    this._activeSegmentEnd = null;
    this.playbackMode = 'normal';
    this._segmentPlayToken++;

    if (Number.isFinite(targetTimeSec)) {
      this._onUiUpdate(targetTimeSec, false, { immediate: true });
    }
    this._onPlayPauseBtnUpdate(false);
    this._onTransportStateChange(reason === 'paused' ? 'paused_segment' : 'stopped', 'bandpass-segment-stop');
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
   * @param {string} eventName
   * @param {any} detail
   */
  _emit(eventName, detail) {
    this.dispatchEvent(new CustomEvent(eventName, { detail }));
  }

  /**
   * Convert AudioBuffer to WAV format
   * @param {AudioBuffer} buffer
   * @returns {ArrayBuffer}
   */
  _audioBufferToWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const format = 1; // PCM
    const bitDepth = 16;
    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;
    const dataLength = buffer.length * blockAlign;
    const headerLength = 44;
    const totalLength = headerLength + dataLength;
    const arrayBuffer = new ArrayBuffer(totalLength);
    const view = new DataView(arrayBuffer);

    // RIFF header
    this._writeString(view, 0, 'RIFF');
    view.setUint32(4, totalLength - 8, true);
    this._writeString(view, 8, 'WAVE');
    // fmt chunk
    this._writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    // data chunk
    this._writeString(view, 36, 'data');
    view.setUint32(40, dataLength, true);

    // Interleave channels
    const channels = [];
    for (let i = 0; i < numChannels; i++) {
      channels.push(buffer.getChannelData(i));
    }
    let offset = 44;
    for (let i = 0; i < buffer.length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const sample = clamp(channels[ch][i], -1, 1);
        const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        view.setInt16(offset, intSample, true);
        offset += 2;
      }
    }
    return arrayBuffer;
  }

  /**
   * @param {DataView} view
   * @param {number} offset
   * @param {string} str
   */
  _writeString(view, offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }
}