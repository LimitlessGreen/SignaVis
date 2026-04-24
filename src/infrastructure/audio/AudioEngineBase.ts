// ═══════════════════════════════════════════════════════════════════════
// AudioEngineBase.ts — Abstract base class / interface for audio engines
//
// Defines the method contract that AudioEngine and MockAudioEngine must satisfy.
// Extends EventTarget so PlayerState can register event listeners on any
// implementing class without knowing which implementation is active.
// ═══════════════════════════════════════════════════════════════════════

export interface AudioEngineLoadResult {
    duration: number;
    sampleRate: number;
}

export abstract class AudioEngineBase extends EventTarget {
    // ── Load ─────────────────────────────────────────────────────────

    loadFromArrayBuffer(_buf: ArrayBuffer, _name?: string): Promise<AudioEngineLoadResult> {
        return this._niAsync('loadFromArrayBuffer');
    }
    loadFromUrl(_url: string): Promise<AudioEngineLoadResult> {
        return this._niAsync('loadFromUrl');
    }
    loadFromFile(_file: File): Promise<AudioEngineLoadResult> {
        return this._niAsync('loadFromFile');
    }

    // ── Transport ────────────────────────────────────────────────────

    playPause(): void  { this._ni('playPause'); }
    stop(): void       { this._ni('stop'); }

    seekToTime(_timeSec: number, _centerView?: boolean, _options?: object): void {
        this._ni('seekToTime');
    }
    seekByDelta(_deltaSec: number): void { this._ni('seekByDelta'); }
    getCurrentTime(): number { this._ni('getCurrentTime'); return 0; }
    isPlaying(): boolean     { this._ni('isPlaying');      return false; }

    // ── Segment playback ─────────────────────────────────────────────

    playSegment(_startSec: number, _endSec: number, _options?: object): void {
        this._ni('playSegment');
    }
    playBandpassedSegment(
        _startSec: number, _endSec: number,
        _freqMinHz: number, _freqMaxHz: number,
        _options?: object,
    ): void { this._ni('playBandpassedSegment'); }
    stopSegmentPlayback(_reason?: string, _targetTimeSec?: number | null): void {
        this._ni('stopSegmentPlayback');
    }
    endNormalSegment(_targetTimeSec: number): void { this._ni('endNormalSegment'); }

    // ── Volume ───────────────────────────────────────────────────────

    setVolume(_val: number): void { this._ni('setVolume'); }
    toggleMute(): void            { this._ni('toggleMute'); }

    // ── Label sync ───────────────────────────────────────────────────

    updateActiveSegmentFromLabel(_label: object): void {
        this._ni('updateActiveSegmentFromLabel');
    }

    // ── Lifecycle ────────────────────────────────────────────────────

    destroy(): void { this._ni('destroy'); }

    // ── Package-internal ─────────────────────────────────────────────

    _clearPlaybackFilter(): void { this._ni('_clearPlaybackFilter'); }
    _clearActiveSegment(): void  { this._ni('_clearActiveSegment');  }

    // ── Helpers ──────────────────────────────────────────────────────

    protected _ni(name: string): never {
        throw new Error(`${this.constructor.name}: '${name}' not implemented`);
    }
    protected _niAsync(name: string): Promise<never> {
        return Promise.reject(new Error(`${this.constructor.name}: '${name}' not implemented`));
    }
}
