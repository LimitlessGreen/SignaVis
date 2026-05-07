// ═══════════════════════════════════════════════════════════════════════
// app/domRefs.ts — Typed bag of all DOM elements queried by PlayerState
//
// Generated from the _queryDom() return object.  Using DomRefs instead
// of `any` means TypeScript validates every property access against this
// interface and surfaces stale/nonexistent references at compile time.
// ═══════════════════════════════════════════════════════════════════════

export interface DomRefs {
    // ── Toolbar / file ──────────────────────────────────────────────────
    openFileBtn:             HTMLButtonElement | null;
    toolbarRoot:             HTMLElement       | null;
    compactMoreBtn:          HTMLButtonElement | null;
    toolbarSecondary:        HTMLElement       | null;
    audioFile:               HTMLInputElement  | null;

    // ── Transport controls ───────────────────────────────────────────────
    playPauseBtn:            HTMLButtonElement | null;
    stopBtn:                 HTMLButtonElement | null;
    jumpStartBtn:            HTMLButtonElement | null;
    jumpEndBtn:              HTMLButtonElement | null;
    backwardBtn:             HTMLButtonElement | null;
    forwardBtn:              HTMLButtonElement | null;
    followToggleBtn:         HTMLButtonElement | null;
    loopToggleBtn:           HTMLButtonElement | null;
    fitViewBtn:              HTMLButtonElement | null;
    resetViewBtn:            HTMLButtonElement | null;

    // ── Status displays ──────────────────────────────────────────────────
    currentTimeDisplay:      HTMLElement       | null;
    totalTimeDisplay:        HTMLElement       | null;
    playStateDisplay:        HTMLElement       | null;
    viewRangeDisplay:        HTMLElement       | null;

    // ── Spectrogram canvas ───────────────────────────────────────────────
    spectrogramCanvas:       HTMLCanvasElement | null;
    spectrogramContainer:    HTMLElement       | null;

    // ── Waveform ────────────────────────────────────────────────────────
    waveformContainer:       HTMLElement       | null;
    waveformWrapper:         HTMLElement       | null;
    waveformContent:         HTMLElement       | null;
    amplitudeLabels:         HTMLElement       | null;
    amplitudeCanvas:         HTMLCanvasElement | null;
    waveformTimelineCanvas:  HTMLCanvasElement | null;
    waveformPlayhead:        HTMLElement       | null;
    audioEngineHost:         HTMLElement       | null;

    // ── Playhead / scroll / canvas wrappers ─────────────────────────────
    playhead:                HTMLElement       | null;
    canvasWrapper:           HTMLElement       | null;
    canvasSizer:             HTMLElement       | null;
    viewSplitHandle:         HTMLElement       | null;
    spectrogramResizeHandle: HTMLElement       | null;

    // ── Overview ────────────────────────────────────────────────────────
    overviewCanvas:          HTMLCanvasElement | null;
    overviewContainer:       HTMLElement       | null;
    overviewWindow:          HTMLElement       | null;
    overviewHandleLeft:      HTMLElement       | null;
    overviewHandleRight:     HTMLElement       | null;
    overviewLabelTracks:     HTMLElement       | null;
    overviewLabelSection:    HTMLElement       | null;
    overviewLabelToggle:     HTMLButtonElement | null;

    // ── File info ────────────────────────────────────────────────────────
    fileInfo:                HTMLElement       | null;
    sampleRateInfo:          HTMLElement       | null;

    // ── DSP / scale selects ─────────────────────────────────────────────
    scaleSelect:             HTMLSelectElement | null;
    colourScaleSelect:       HTMLSelectElement | null;

    // ── Preset controls ──────────────────────────────────────────────────
    presetSelect:            HTMLSelectElement | null;
    presetSaveBtn:           HTMLButtonElement | null;
    presetFavBtn:            HTMLButtonElement | null;
    presetManageBtn:         HTMLButtonElement | null;
    presetSaveRow:           HTMLElement       | null;
    presetSaveInput:         HTMLInputElement  | null;
    presetSaveConfirm:       HTMLButtonElement | null;
    presetSaveCancel:        HTMLButtonElement | null;
    presetManagerPanel:      HTMLElement       | null;
    presetManagerList:       HTMLElement       | null;
    presetImportBtn:         HTMLButtonElement | null;
    presetExportBtn:         HTMLButtonElement | null;
    presetStatus:            HTMLElement       | null;

    // ── DSP parameter inputs ─────────────────────────────────────────────
    nMelsInput:              HTMLInputElement  | null;
    pcenGainInput:           HTMLInputElement  | null;
    pcenBiasInput:           HTMLInputElement  | null;
    pcenRootInput:           HTMLInputElement  | null;
    pcenSmoothingInput:      HTMLInputElement  | null;
    pcenEnabledCheck:        HTMLInputElement  | null;
    pcenSection:             HTMLElement       | null;
    windowSizeSelect:        HTMLSelectElement | null;
    windowFunctionSelect:    HTMLSelectElement | null;
    overlapSelect:           HTMLSelectElement | null;
    oversamplingSelect:      HTMLSelectElement | null;
    reassignedCheck:         HTMLInputElement  | null;
    noiseReductionCheck:     HTMLInputElement  | null;
    claheCheck:              HTMLInputElement  | null;
    showCentroidCheck:       HTMLInputElement  | null;
    showF0Check:             HTMLInputElement  | null;
    showRidgesCheck:         HTMLInputElement  | null;

    // ── Quality / zoom sliders ───────────────────────────────────────────
    qualitySlider:           HTMLInputElement  | null;
    qualityLevelDisplay:     HTMLElement       | null;
    zoomSlider:              HTMLInputElement  | null;
    zoomValue:               HTMLElement       | null;

    // ── Frequency controls ───────────────────────────────────────────────
    maxFreqModeSelect:       HTMLSelectElement | null;
    maxFreqSelect:           HTMLSelectElement | null;
    colorSchemeSelect:       HTMLSelectElement | null;
    freqLabels:              HTMLElement       | null;
    freqZoomResetBtn:        HTMLButtonElement | null;
    freqAxisSpacer:          HTMLElement       | null;
    freqZoomSlider:          HTMLInputElement  | null;
    freqScrollbar:           HTMLElement       | null;
    freqScrollbarThumb:      HTMLElement       | null;

    // ── Volume controls ──────────────────────────────────────────────────
    volumeToggleBtn:         HTMLButtonElement | null;
    volumeIcon:              HTMLElement       | null;
    volumeWaves:             HTMLElement       | null;
    volumeSlider:            HTMLInputElement  | null;

    // ── Gain controls ────────────────────────────────────────────────────
    gainModeSelect:          HTMLSelectElement | null;
    floorSlider:             HTMLInputElement  | null;
    ceilSlider:              HTMLInputElement  | null;
    autoContrastBtn:         HTMLButtonElement | null;
    autoFreqBtn:             HTMLButtonElement | null;

    // ── Crosshair / overlays ─────────────────────────────────────────────
    crosshairToggleBtn:      HTMLButtonElement | null;
    crosshairCanvas:         HTMLCanvasElement | null;
    crosshairReadout:        HTMLElement       | null;
    recomputingOverlay:      HTMLElement       | null;

    // ── Settings panel ───────────────────────────────────────────────────
    settingsToggleBtn:       HTMLButtonElement | null;
    settingsPanel:           HTMLElement       | null;
    settingsPanelClose:      HTMLButtonElement | null;
}
