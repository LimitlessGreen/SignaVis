// ═══════════════════════════════════════════════════════════════════════
// MockAudioEngine.ts — Headless AudioEngine for tests, Storybook,
//                      Gradio/Streamlit wrappers and desktop apps.
//
// Simulates the full AudioEngineBase contract without:
//   • AudioContext (no real audio playback)
//   • WaveSurfer (no DOM waveform rendering)
// ═══════════════════════════════════════════════════════════════════════

import { AudioEngineBase, type AudioEngineLoadResult } from './AudioEngineBase.ts';
import { parseNativeSampleRate, clamp } from '../../shared/utils.ts';

interface FakeAudioBuffer {
    duration: number;
    sampleRate: number;
    name?: string;
    url?: string;
}

interface SegmentOptions {
    labelId?: string;
    loop?: boolean;
    [key: string]: unknown;
}

export class MockAudioEngine extends AudioEngineBase {
    audioBuffer: FakeAudioBuffer | null = null;
    wavesurfer: null = null;
    volume        = 0.8;
    muted         = false;
    preMuteVolume = 0.8;
    _segmentMode  = false;
    _activeSegmentLabelId: string | null  = null;
    _activeSegmentFilter: { type: 'bandpass'; freqMinHz: number; freqMaxHz: number } | null = null;
    _activeSegmentStart: number | null    = null;
    _activeSegmentEnd:   number | null    = null;
    _customSegmentPlayback: null          = null;
    _suppressNextPauseHandler             = false;
    _segmentPlayToken                     = 0;
    loopPlayback                          = false;
    pixelsPerSecond                       = 100;

    private _currentTime     = 0;
    private _playing         = false;
    private _transportState  = 'idle';

    // ── Derived state ────────────────────────────────────────────────

    get playbackMode(): 'normal' | 'segment' { return this._segmentMode ? 'segment' : 'normal'; }
    set playbackMode(v: string) { this._segmentMode = (v === 'segment'); }

    // ── Load ─────────────────────────────────────────────────────────

    async loadFromArrayBuffer(arrayBuffer: ArrayBuffer, name = 'mock'): Promise<AudioEngineLoadResult> {
        const sampleRate   = parseNativeSampleRate(arrayBuffer) || 48000;
        const fakeDuration = 10;
        this.audioBuffer   = { duration: fakeDuration, sampleRate, name };
        this._currentTime  = 0;
        this._setTransportState('ready', 'mock-load');
        this._emit('ready', { duration: fakeDuration, sampleRate });
        return { duration: fakeDuration, sampleRate };
    }

    async loadFromUrl(url: string): Promise<AudioEngineLoadResult> {
        const fakeDuration = 10;
        const sampleRate   = 48000;
        this.audioBuffer   = { duration: fakeDuration, sampleRate, url };
        this._currentTime  = 0;
        this._setTransportState('ready', 'mock-load-url');
        this._emit('ready', { duration: fakeDuration, sampleRate });
        return { duration: fakeDuration, sampleRate };
    }

    async loadFromFile(file: File): Promise<AudioEngineLoadResult> {
        const buf = await file.arrayBuffer();
        return this.loadFromArrayBuffer(buf, file.name);
    }

    // ── Transport ────────────────────────────────────────────────────

    override playPause(): void {
        if (this._playing) {
            this._playing = false;
            this._setTransportState('paused', 'mock-pause');
            this._emit('pause', {});
        } else {
            this._playing = true;
            this._setTransportState('playing', 'mock-play');
            this._emit('play', {});
        }
    }

    override stop(): void {
        this._playing = false;
        this._currentTime = 0;
        this._clearActiveSegment();
        this._setTransportState('stopped', 'mock-stop');
        this._emit('pause', {});
    }

    override seekToTime(timeSec: number, _centerView = false): void {
        if (!this.audioBuffer) return;
        this._currentTime = clamp(timeSec, 0, this.audioBuffer.duration);
        this._emit('uiupdate', { time: this._currentTime, fromPlayback: false, centerView: _centerView, emitSeek: true, immediate: true });
    }

    override seekByDelta(deltaSec: number): void {
        if (!this.audioBuffer) return;
        this.seekToTime(this._currentTime + deltaSec);
    }

    override getCurrentTime(): number { return this._currentTime; }
    override isPlaying(): boolean     { return this._playing; }

    // ── Segment playback ─────────────────────────────────────────────

    override playSegment(startSec: number, endSec: number, options: SegmentOptions = {}): void {
        if (!this.audioBuffer) return;
        const dur   = this.audioBuffer.duration;
        const start = clamp(startSec, 0, dur);
        const end   = clamp(endSec,   0, dur);
        if (end - start < 0.01) return;
        this.playbackMode              = 'segment';
        this._activeSegmentLabelId     = options?.labelId || null;
        this._activeSegmentStart       = start;
        this._activeSegmentEnd         = end;
        this._currentTime              = start;
        this._playing                  = true;
        this._emit('segmentstart', { start, end, loop: this.loopPlayback });
        this._setTransportState('playing_segment', 'mock-segment');
    }

    override playBandpassedSegment(
        startSec: number, endSec: number,
        freqMinHz: number, freqMaxHz: number,
        options: SegmentOptions = {},
    ): void {
        if (!this.audioBuffer) return;
        this._activeSegmentFilter = { type: 'bandpass', freqMinHz, freqMaxHz };
        this.playSegment(startSec, endSec, options);
        this._emit('segmentstart', { start: startSec, end: endSec, filter: { type: 'bandpass', freqMinHz, freqMaxHz } });
    }

    override stopSegmentPlayback(reason = 'stopped', targetTimeSec: number | null = null): void {
        this._playing = false;
        if (targetTimeSec !== null) this._currentTime = targetTimeSec;
        this._clearActiveSegment();
        const state = reason === 'paused' ? 'paused_segment' : 'stopped';
        this._setTransportState(state, 'mock-segment-stop');
        this._emit('segmentend', { end: this._currentTime });
    }

    override endNormalSegment(targetTimeSec: number): void {
        this._clearActiveSegment();
        this._playing     = false;
        this._currentTime = targetTimeSec;
    }

    // ── Volume ───────────────────────────────────────────────────────

    override setVolume(val: number): void { this.volume = clamp(val, 0, 1); }

    override toggleMute(): void {
        if (this.muted) {
            this.muted  = false;
            this.volume = this.preMuteVolume;
        } else {
            this.preMuteVolume = this.volume;
            this.muted         = true;
        }
    }

    // ── Label sync ───────────────────────────────────────────────────

    override updateActiveSegmentFromLabel(label: Record<string, unknown>): void {
        if (!label || this.playbackMode !== 'segment' || !this.audioBuffer) return;
        const labelId = (label.id as string) || null;
        if (this._activeSegmentLabelId && labelId && this._activeSegmentLabelId !== labelId) return;
        const dur = this.audioBuffer.duration;
        this._activeSegmentStart = clamp(Number(label.start ?? 0), 0, dur);
        this._activeSegmentEnd   = clamp(
            Number(label.end ?? (this._activeSegmentStart + 0.01)),
            (this._activeSegmentStart ?? 0) + 0.01,
            dur,
        );
    }

    // ── Lifecycle ────────────────────────────────────────────────────

    override destroy(): void { this._playing = false; this.audioBuffer = null; }

    // ── Package-internal ─────────────────────────────────────────────

    override _clearPlaybackFilter(): void { this._activeSegmentFilter = null; }

    override _clearActiveSegment(): void {
        this._segmentMode          = false;
        this._activeSegmentLabelId = null;
        this._activeSegmentFilter  = null;
        this._activeSegmentStart   = null;
        this._activeSegmentEnd     = null;
    }

    // ── Private helpers ──────────────────────────────────────────────

    private _setTransportState(state: string, reason: string): void {
        if (this._transportState !== state) {
            this._transportState = state;
            this._emit('transportstatechange', { state, reason });
        }
    }

    _emit(eventName: string, detail: object = {}): void {
        this.dispatchEvent(new CustomEvent(eventName, { detail }));
    }
}
