// ═══════════════════════════════════════════════════════════════════════
// domain/dsp/DspSettings.ts — Typed DSP parameter value object
//
// Single source of truth for all DSP parameter names, types, and
// defaults.  Replaces 15+ scattered parseInt/parseFloat calls with
// hardcoded per-site defaults across PresetManager and PlayerState.
// ═══════════════════════════════════════════════════════════════════════

import type { DomRefs } from '../../app/domRefs.ts';

export interface DspSettings {
    scale:             string;
    colourScale:       string;
    windowSize:        number;
    overlapLevel:      number;
    oversamplingLevel: number;
    windowFunction:    string;
    nMels:             number;
    usePcen:           boolean;
    pcenGain:          number;
    pcenBias:          number;
    pcenRoot:          number;
    pcenSmoothing:     number;
    colorScheme:       string;
    reassigned:        boolean;
    noiseReduction:    boolean;
    clahe:             boolean;
    gainMode:          string;
    gainFloor?:        number;
    gainCeil?:         number;
    maxFreqMode:       string;
    maxFreqHz?:        number;
}

export const DSP_SETTINGS_DEFAULTS: Required<DspSettings> = {
    scale:             'mel',
    colourScale:       'dbSquared',
    windowSize:        1024,
    overlapLevel:      2,
    oversamplingLevel: 0,
    windowFunction:    'hann',
    nMels:             160,
    usePcen:           true,
    pcenGain:          0.8,
    pcenBias:          0.01,
    pcenRoot:          4.0,
    pcenSmoothing:     0.025,
    colorScheme:       'grayscale',
    reassigned:        false,
    noiseReduction:    false,
    clahe:             false,
    gainMode:          'auto',
    gainFloor:         0,
    gainCeil:          100,
    maxFreqMode:       'auto',
    maxFreqHz:         10000,
};

/** Read all DSP settings from the DOM controls into a plain value object. */
export function readDspSettings(d: DomRefs): DspSettings {
    const D = DSP_SETTINGS_DEFAULTS;
    const gainMode   = d.gainModeSelect?.value    || D.gainMode;
    const maxFreqMode = d.maxFreqModeSelect?.value || D.maxFreqMode;

    const settings: DspSettings = {
        scale:             d.scaleSelect?.value              || D.scale,
        colourScale:       d.colourScaleSelect?.value        || D.colourScale,
        windowSize:        parseInt(d.windowSizeSelect?.value    ?? String(D.windowSize),        10),
        overlapLevel:      parseInt(d.overlapSelect?.value       ?? String(D.overlapLevel),      10),
        oversamplingLevel: parseInt(d.oversamplingSelect?.value  ?? String(D.oversamplingLevel), 10),
        windowFunction:    d.windowFunctionSelect?.value     || D.windowFunction,
        nMels:             parseInt(d.nMelsInput?.value          ?? String(D.nMels),             10),
        usePcen:           d.pcenEnabledCheck?.checked           ?? D.usePcen,
        pcenGain:          parseFloat(d.pcenGainInput?.value     ?? String(D.pcenGain)),
        pcenBias:          parseFloat(d.pcenBiasInput?.value     ?? String(D.pcenBias)),
        pcenRoot:          parseFloat(d.pcenRootInput?.value     ?? String(D.pcenRoot)),
        pcenSmoothing:     parseFloat(d.pcenSmoothingInput?.value ?? String(D.pcenSmoothing)),
        colorScheme:       d.colorSchemeSelect?.value        || D.colorScheme,
        reassigned:        d.reassignedCheck?.checked            ?? D.reassigned,
        noiseReduction:    d.noiseReductionCheck?.checked        ?? D.noiseReduction,
        clahe:             d.claheCheck?.checked                 ?? D.clahe,
        gainMode,
        maxFreqMode,
    };

    if (gainMode === 'fixed') {
        settings.gainFloor = parseInt(d.floorSlider?.value ?? String(D.gainFloor), 10);
        settings.gainCeil  = parseInt(d.ceilSlider?.value  ?? String(D.gainCeil),  10);
    }
    if (maxFreqMode === 'fixed') {
        settings.maxFreqHz = parseFloat(d.maxFreqSelect?.value ?? String(D.maxFreqHz));
    }

    return settings;
}

/** Write DSP settings back to the DOM controls. */
export function applyDspSettings(d: DomRefs, p: DspSettings): void {
    if (d.scaleSelect)          d.scaleSelect.value          = p.scale;
    if (d.windowSizeSelect    && p.windowSize        != null) d.windowSizeSelect.value    = String(p.windowSize);
    if (d.overlapSelect       && p.overlapLevel      != null) d.overlapSelect.value       = String(p.overlapLevel);
    if (d.oversamplingSelect  && p.oversamplingLevel != null) d.oversamplingSelect.value  = String(p.oversamplingLevel);
    if (d.windowFunctionSelect) d.windowFunctionSelect.value = p.windowFunction;
    if (d.nMelsInput)           d.nMelsInput.value           = String(p.nMels ?? DSP_SETTINGS_DEFAULTS.nMels);
    if (d.pcenEnabledCheck)     d.pcenEnabledCheck.checked   = !!p.usePcen;
    if (d.pcenGainInput)        d.pcenGainInput.value        = String(p.pcenGain      ?? DSP_SETTINGS_DEFAULTS.pcenGain);
    if (d.pcenBiasInput)        d.pcenBiasInput.value        = String(p.pcenBias      ?? DSP_SETTINGS_DEFAULTS.pcenBias);
    if (d.pcenRootInput)        d.pcenRootInput.value        = String(p.pcenRoot      ?? DSP_SETTINGS_DEFAULTS.pcenRoot);
    if (d.pcenSmoothingInput)   d.pcenSmoothingInput.value   = String(p.pcenSmoothing ?? DSP_SETTINGS_DEFAULTS.pcenSmoothing);
    if (p.colorScheme && d.colorSchemeSelect) d.colorSchemeSelect.value = p.colorScheme;
    if (d.reassignedCheck)      d.reassignedCheck.checked    = !!p.reassigned;
    if (p.colourScale    != null && d.colourScaleSelect)   d.colourScaleSelect.value     = p.colourScale;
    if (p.noiseReduction != null && d.noiseReductionCheck) d.noiseReductionCheck.checked = !!p.noiseReduction;
    if (p.clahe          != null && d.claheCheck)          d.claheCheck.checked          = !!p.clahe;

    const gainMode = p.gainMode || 'auto';
    if (d.gainModeSelect) d.gainModeSelect.value = gainMode;
    if (gainMode === 'fixed' && p.gainFloor != null && p.gainCeil != null) {
        if (d.floorSlider) d.floorSlider.value = String(p.gainFloor);
        if (d.ceilSlider)  d.ceilSlider.value  = String(p.gainCeil);
    }

    const maxFreqMode = p.maxFreqMode || 'auto';
    if (d.maxFreqModeSelect) d.maxFreqModeSelect.value = maxFreqMode;
    if (maxFreqMode === 'fixed' && p.maxFreqHz != null && d.maxFreqSelect) {
        d.maxFreqSelect.value = String(p.maxFreqHz);
    }
}
