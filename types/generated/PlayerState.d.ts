export class PlayerState {
    /**
     * @param {HTMLElement} container
     * @param {any} WaveSurfer
     * @param {((event: string, detail: any) => void) | null} [emitHostEvent]
     * @param {PlayerOptions} [options]
     */
    constructor(container: HTMLElement, WaveSurfer: any, emitHostEvent?: ((event: string, detail: any) => void) | null, options?: PlayerOptions);
    container: HTMLElement;
    d: {
        openFileBtn: any;
        toolbarRoot: any;
        compactMoreBtn: any;
        toolbarSecondary: any;
        audioFile: any;
        playPauseBtn: any;
        stopBtn: any;
        jumpStartBtn: any;
        jumpEndBtn: any;
        backwardBtn: any;
        forwardBtn: any;
        followToggleBtn: any;
        loopToggleBtn: any;
        fitViewBtn: any;
        resetViewBtn: any;
        currentTimeDisplay: any;
        totalTimeDisplay: any;
        playStateDisplay: any;
        viewRangeDisplay: any;
        spectrogramCanvas: any;
        spectrogramContainer: any;
        waveformContainer: any;
        waveformWrapper: any;
        waveformContent: any;
        amplitudeLabels: any;
        amplitudeCanvas: any;
        waveformTimelineCanvas: any;
        waveformPlayhead: any;
        audioEngineHost: any;
        playhead: any;
        canvasWrapper: any;
        viewSplitHandle: any;
        spectrogramResizeHandle: any;
        overviewCanvas: any;
        overviewContainer: any;
        overviewWindow: any;
        overviewHandleLeft: any;
        overviewHandleRight: any;
        fileInfo: any;
        sampleRateInfo: any;
        spectrogramModeSelect: any;
        fftSizeSelect: any;
        zoomSlider: any;
        zoomValue: any;
        maxFreqSelect: any;
        colorSchemeSelect: any;
        freqLabels: any;
        volumeToggleBtn: any;
        volumeIcon: any;
        volumeWaves: any;
        volumeSlider: any;
        floorSlider: any;
        ceilSlider: any;
        autoContrastBtn: any;
        autoFreqBtn: any;
    };
    WaveSurfer: any;
    _emitHostEvent: ((event: string, detail: any) => void) | null;
    options: PlayerOptions;
    _viewMode: string;
    _showWaveform: boolean;
    _showSpectrogram: boolean;
    _showOverview: boolean;
    _transportOverlay: boolean;
    _compactToolbarMode: string;
    _compactToolbarOpen: boolean;
    _compactToolbarLayoutRaf: number;
    _showWaveformTimeline: boolean;
    _playbackViewportConfig: any;
    processor: {
        compute: (channelData: any, options: any) => Promise<any>;
        computeProgressive: (channelData: any, options: any) => AsyncGenerator<{
            chunk: number;
            totalChunks: number;
            percent: number;
            result: any;
        }, void, unknown>;
        dispose: () => void;
    };
    colorizer: GpuColorizer;
    audioBuffer: AudioBuffer | null;
    wavesurfer: any;
    spectrogramData: any;
    spectrogramFrames: number;
    spectrogramMels: number;
    spectrogramBaseCanvas: HTMLCanvasElement | null;
    spectrogramGrayInfo: {
        gray: Uint8Array<ArrayBuffer>;
        width: number;
        height: number;
    } | null;
    _gpuReady: boolean;
    spectrogramAbsLogMin: number;
    spectrogramAbsLogMax: number;
    sampleRateHz: number;
    _externalSpectrogram: boolean;
    amplitudePeakAbs: number;
    currentColorScheme: any;
    volume: number;
    muted: boolean;
    preMuteVolume: number;
    pixelsPerSecond: number;
    _zoomRedrawRafId: number;
    scrollSyncLock: boolean;
    windowStartNorm: number;
    windowEndNorm: number;
    followMode: string;
    followPlayback: boolean;
    loopPlayback: boolean;
    playbackMode: string;
    transportState: string;
    _activeSegmentLabelId: any;
    _activeSegmentFilter: {
        type: string;
        freqMinHz: number;
        freqMaxHz: number;
    } | {
        type: string;
        freqMinHz: number;
        freqMaxHz: number;
    } | null;
    _activeSegmentStart: number | null;
    _activeSegmentEnd: number | null;
    _suppressNextPauseHandler: boolean;
    _segmentPlayToken: number;
    _customSegmentPlayback: {
        token: number;
        ctx: AudioContext;
        /** @type {AudioBufferSourceNode | null} */
        source: AudioBufferSourceNode | null;
        bandpass: BiquadFilterNode;
        gain: GainNode;
        startSec: number;
        endSec: number;
        startAtCtx: number;
        runStartSec: number;
        sourceGeneration: number;
        rafId: number;
        currentTimeSec: number;
    } | null;
    _smoothSeekFocusUntil: number;
    _lastTimeupdateEmitAt: number;
    _lastSelectionEmitAt: number;
    _lastSelectionStart: number;
    _lastSelectionEnd: number;
    _lastViewRangeTextStart: number;
    _lastViewRangeTextEnd: number;
    _lastTimeReadoutText: string;
    _uiFrameId: number;
    _uiPending: any;
    _followCatchupRafId: number;
    _followCatchupAnim: {
        start: any;
        target: number;
        startedAt: number;
        duration: any;
    } | null;
    _perf: {
        enabled: boolean;
        /** @type {HTMLDivElement | null} */
        panel: HTMLDivElement | null;
        intervalId: number;
        frames: number;
        fps: number;
        lastFrameTs: number;
        longFrames: number;
        maxFrameMs: number;
        uiFlushes: number;
        timeupdateEvents: number;
        selectionEvents: number;
        seekEvents: number;
        transitionEvents: number;
        blockedTransitions: number;
        lastTransition: string;
    };
    interaction: InteractionState;
    _overviewViewportRafId: number;
    _overviewNeedsFinalRedraw: boolean;
    waveformDisplayHeight: number;
    spectrogramDisplayHeight: number;
    _viewResizeFrameId: number;
    _viewResizeNeedsWaveformRedraw: boolean;
    _viewResizeNeedsSpectrogramRedraw: boolean;
    _cleanups: any[];
    _emit(event: any, detail?: {}): void;
    _sanitizePlaybackViewportConfig(partial?: {}): any;
    updatePlaybackViewportConfig(partial?: {}): any;
    getPlaybackViewportConfig(): any;
    _initPerfOverlay(): void;
    _perfOnFrame(ts: any): void;
    _renderPerfOverlay(): void;
    _setTransportState(nextState: any, reason?: string): void;
    _scheduleUiUpdate({ time, fromPlayback, centerView, emitSeek, immediate, }?: {
        time?: any;
        fromPlayback?: boolean | undefined;
        centerView?: boolean | undefined;
        emitSeek?: boolean | undefined;
        immediate?: boolean | undefined;
    }): void;
    _flushUiUpdate(_ts: any): void;
    _queryDom(root: any): {
        openFileBtn: any;
        toolbarRoot: any;
        compactMoreBtn: any;
        toolbarSecondary: any;
        audioFile: any;
        playPauseBtn: any;
        stopBtn: any;
        jumpStartBtn: any;
        jumpEndBtn: any;
        backwardBtn: any;
        forwardBtn: any;
        followToggleBtn: any;
        loopToggleBtn: any;
        fitViewBtn: any;
        resetViewBtn: any;
        currentTimeDisplay: any;
        totalTimeDisplay: any;
        playStateDisplay: any;
        viewRangeDisplay: any;
        spectrogramCanvas: any;
        spectrogramContainer: any;
        waveformContainer: any;
        waveformWrapper: any;
        waveformContent: any;
        amplitudeLabels: any;
        amplitudeCanvas: any;
        waveformTimelineCanvas: any;
        waveformPlayhead: any;
        audioEngineHost: any;
        playhead: any;
        canvasWrapper: any;
        viewSplitHandle: any;
        spectrogramResizeHandle: any;
        overviewCanvas: any;
        overviewContainer: any;
        overviewWindow: any;
        overviewHandleLeft: any;
        overviewHandleRight: any;
        fileInfo: any;
        sampleRateInfo: any;
        spectrogramModeSelect: any;
        fftSizeSelect: any;
        zoomSlider: any;
        zoomValue: any;
        maxFreqSelect: any;
        colorSchemeSelect: any;
        freqLabels: any;
        volumeToggleBtn: any;
        volumeIcon: any;
        volumeWaves: any;
        volumeSlider: any;
        floorSlider: any;
        ceilSlider: any;
        autoContrastBtn: any;
        autoFreqBtn: any;
    };
    dispose(): void;
    _handleFileSelect(e: any): Promise<void>;
    loadUrl(url: any): Promise<void>;
    _setupWaveSurfer(source: any): void;
    _togglePlayPause(): void;
    _stopPlayback(): void;
    playSegment(startSec: any, endSec: any, options?: {}): void;
    playBandpassedSegment(startSec: any, endSec: any, freqMinHz: any, freqMaxHz: any, options?: {}): void;
    _startCustomSegmentSource(playback: any, source?: null, startAtSec?: null): void;
    _loopCustomSegmentPlayback(playback: any): void;
    updateActiveSegmentFromLabel(label: any): void;
    _retargetCustomSegmentPlayback({ start, end, freqMinHz, freqMaxHz }: {
        start: any;
        end: any;
        freqMinHz: any;
        freqMaxHz: any;
    }): void;
    _restartCustomSegmentSource(playback: any, atSec: any): void;
    /**
     * @param {string} [reason]
     * @param {number | null} [targetTimeSec]
     * @param {Object} [options]
     */
    _stopCustomSegmentPlayback(reason?: string, targetTimeSec?: number | null, options?: Object): void;
    _clearPlaybackFilter(): void;
    _seekToTime(timeSec: any, centerView?: boolean, options?: {}): void;
    _seekByDelta(deltaSec: any): void;
    _seekRelative(deltaSec: any): void;
    _getCurrentTime(): any;
    _updateTimeReadout(t: any): void;
    _updateAriaPlaybackPosition(currentTimeSec: any): void;
    _updatePlayhead(currentTime: any, fromPlayback: any): void;
    _generateSpectrogram(): Promise<void>;
    /**
     * Mode 1: Raw data — enter pipeline at Stage 1 (grayscale → colorize → render).
     * Contrast sliders, color map selection, and frequency controls all remain functional.
     */
    _setExternalSpectrogram(data: any, nFrames: any, nMels: any, options?: {}): void;
    /**
     * Mode 2: Pre-rendered image — bypasses entire DSP + colorization pipeline.
     * Contrast/color controls have no effect; the image is drawn as-is.
     */
    _setExternalSpectrogramImage(image: any, options?: {}): Promise<void>;
    _mergeProgressiveResults(chunkResults: any, nMels: any): {
        data: Float32Array<ArrayBuffer>;
        nFrames: number;
        nMels: any;
    };
    _updateSpectrogramStats(): void;
    /** Compute optimal floor/ceil from percentiles.
     *  Pass redraw=true when called from a button click. */
    _autoContrast(redraw?: boolean): void;
    /** Detect best maxFreq. Pass redraw=true when called from button click. */
    _autoFrequency(redraw?: boolean): void;
    _setVolume(val: any): void;
    _toggleMute(): void;
    _updateVolumeIcon(): void;
    /** Stage 1 — expensive: PCEN → 8-bit grayscale. Run once per audio/fft/freq change. */
    _buildSpectrogramGrayscale(): void;
    /** Stage 2 — fast: grayscale → colored canvas.
     *  GPU path: ~0.1 ms.  JS fallback: ~20-80 ms. */
    _buildSpectrogramBaseImage(): HTMLCanvasElement | null;
    _drawSpectrogram(): void;
    _requestSpectrogramRedraw(): void;
    _drawMainWaveform(): void;
    _drawOverviewWaveform(): void;
    _createFrequencyLabels(): void;
    _updateAmplitudeLabels(): void;
    _getPrimaryScrollWrapper(): any;
    _getSecondaryScrollWrapper(): any;
    _getPrimaryScrollLeft(): any;
    _getViewportWidth(): number;
    _setLinkedScrollLeft(nextLeft: any): void;
    _setPixelsPerSecond(nextPps: any, redraw: any, anchorTime: any, anchorPixel: any): void;
    _fitEntireTrackInView(): void;
    _zoomByScale(scale: any, centerClientX: any, source?: string): void;
    _centerViewportAtTime(timeSec: any): void;
    _clientXToTime(clientX: any, source?: string): number;
    _syncOverviewWindowToViewport(): void;
    _updateOverviewWindowElement(): void;
    _getOverviewSpanConstraints(): {
        minSpanNorm: number;
        maxSpanNorm: number;
    };
    _startOverviewDrag(mode: any, clientX: any): void;
    _updateOverviewDrag(clientX: any): void;
    _queueOverviewViewportApply(redrawFinal?: boolean): void;
    _applyOverviewWindowToViewport(redraw?: boolean): void;
    _handleCanvasClick(e: any): void;
    _handleWaveformClick(e: any): void;
    _blockSeekClicks(ms?: number): void;
    _startPlayheadDrag(event: any, source: any): void;
    _seekFromClientX(clientX: any, source?: string): void;
    _startViewportPan(event: any, source: any): void;
    _updateViewportPan(clientX: any): void;
    _handleWheel(event: any, source: any): void;
    _applyLocalViewHeights(): void;
    _getEffectiveWaveformHeight(): number;
    _getEffectiveSpectrogramHeight(): number;
    _startViewResize(mode: any, clientY: any): void;
    _updateViewResize(clientY: any): void;
    _stopViewResize(): void;
    _queueResizeRedraw({ redrawWaveform, redrawSpectrogram }?: {
        redrawWaveform?: boolean | undefined;
        redrawSpectrogram?: boolean | undefined;
    }): void;
    _flushResizeRedraw(force: any): void;
    _setPlayState(text: any): void;
    _shouldCompactToolbarBeActive(): boolean;
    _isCompactToolbarActive(): boolean;
    _queueCompactToolbarLayoutRefresh(): void;
    _refreshCompactToolbarLayout(): void;
    _setCompactToolbarOpen(nextOpen: any): void;
    _setTransportEnabled(enabled: any): void;
    _updateToggleButtons(): void;
    _cycleFollowMode(): void;
    _cancelFollowCatchupAnimation(): void;
    _animateFollowCatchupTo(targetScrollLeft: any): void;
    _applySmoothFollow(position: any, viewportWidth: any): void;
    _setInitialPlayheadPositions(): void;
    _handleKeyboardShortcuts(event: any): void;
    _bindEvents(): void;
    _bindTouchGestures(): void;
}
export type PlayerOptions = {
    viewMode?: string | undefined;
    showOverview?: boolean | undefined;
    transportOverlay?: boolean | undefined;
    compactToolbar?: string | undefined;
    showWaveformTimeline?: boolean | undefined;
    enableTouchGestures?: boolean | undefined;
    enablePerfOverlay?: boolean | undefined;
    followGuardLeftRatio?: number | undefined;
    followGuardRightRatio?: number | undefined;
    followTargetRatio?: number | undefined;
    followCatchupDurationMs?: number | undefined;
    followCatchupSeekDurationMs?: number | undefined;
    smoothLerp?: number | undefined;
    smoothSeekLerp?: number | undefined;
    smoothMinStepRatio?: number | undefined;
    smoothSeekMinStepRatio?: number | undefined;
    smoothSeekFocusMs?: number | undefined;
    enableProgressiveSpectrogram?: boolean | undefined;
};
import { GpuColorizer } from './spectrogram.js';
import { InteractionState } from './interactionState.js';
