// constants.ts — Shared configuration constants
// constants.js — Shared configuration constants
// ═══════════════════════════════════════════════════════════════════════

export const DEFAULT_SAMPLE_RATE = 32000;
export const DEFAULT_AXIS_WIDTH = 64;
export const DEFAULT_ZOOM_PPS = 100;
export const DEFAULT_WAVEFORM_HEIGHT = 100;
export const DEFAULT_SPECTROGRAM_DISPLAY_HEIGHT = DEFAULT_WAVEFORM_HEIGHT * 2;
export const MIN_WAVEFORM_HEIGHT = 64;
export const MIN_SPECTROGRAM_DISPLAY_HEIGHT = 140;
export const SEEK_FINE_SEC = 0.5;
export const SEEK_COARSE_SEC = 5;
export const SPECTROGRAM_HEIGHT = 160;
export const MAX_BASE_SPECTROGRAM_WIDTH = 24000;
export const MIN_WINDOW_NORM = 0.02;
export const PROGRESSIVE_CHUNK_SECONDS = 10;
export const PROGRESSIVE_MIN_DURATION_SEC = 60;

// ─── Tile-based lazy rendering (for long audio files) ──────────────
export const TILE_MODE_MIN_DURATION_SEC = Infinity; // tile mode disabled for now
export const WASM_TILE_MIN_DURATION_SEC = 10 * 60; // long WAV files use the WASM pyramid
/** Spectrogram DSP engine: 'v2' = Rust aw_dsp::v2 (dBFS / PCEN, centred
 *  frames) via WASM where the settings allow it, 'v1' = previous pipeline. */
export const SPECTROGRAM_ENGINE: 'v1' | 'v2' = 'v2';
export const TILE_SECONDS = 30;                // audio seconds covered by one tile
export const TILE_MAX_IN_MEMORY = 16;          // LRU limit (16 × 30 s = 8 min in RAM)
export const PERCH_FRAME_RATE = 100;
export const PERCH_N_MELS = 160;
export const PERCH_PCEN_GAIN = 0.8;
export const PERCH_PCEN_BIAS = 0.01;
export const PERCH_PCEN_ROOT = 4.0;
export const PERCH_PCEN_SMOOTHING = 0.025;

// Classic (Xeno-Canto-style) spectrogram defaults
export const CLASSIC_FRAME_RATE = 100;
export const CLASSIC_N_MELS = 160;
export const CLASSIC_DB_FLOOR = -80;   // dB below peak to clip
export const CLASSIC_DB_REF = 1.0;     // reference power for dB conversion

// ─── Window Overlap / Oversampling (SV-style) ──────────────────────
// Overlap level → hop size (matches Sonic Visualiser getWindowIncrement)
// Level 0 = none, 1 = 25%, 2 = 50%, 3 = 75%, 4 = 87.5%, 5 = 93.75%
export function windowHopFromOverlap(windowSize: number, overlapLevel: number): number {
    if (overlapLevel <= 0) return windowSize;
    if (overlapLevel === 1) return (windowSize * 3) >> 2;  // 75% of window
    return windowSize >> (overlapLevel - 1);                // 2^(level-1)
}

// Oversampling level → fft size (zero-padding)
// Level 0 = 1×, 1 = 2×, 2 = 4×, 3 = 8×
export function fftSizeFromOversampling(windowSize: number, oversamplingLevel: number): number {
    return windowSize << oversamplingLevel;
}

// ─── DSP Profiles ───────────────────────────────────────────────────
// Pre-configured parameter sets for quick switching.
// windowSize + overlapLevel + oversamplingLevel determine hop and FFT.


export interface DspProfile {
    scale: string;
    windowSize: number;
    overlapLevel: number;
    oversamplingLevel: number;
    nMels: number;
    frameRate?: number;
    usePcen: boolean;
    pcenGain: number;
    pcenBias: number;
    pcenRoot: number;
    pcenSmoothing: number;
    windowFunction: string;
    colorScheme: string;
    colourScale?: string;
    reassigned: boolean;
    noiseReduction?: boolean;
    clahe?: boolean;
    gainMode?: string;
    gainFloor?: number;
    gainCeil?: number;
    maxFreqMode: string;
}

export interface QualityLevel {
    label: string;
    windowSize: number;
    overlapLevel: number;
    oversamplingLevel: number;
    nMels?: number;
}

// Every built-in profile sets clahe / noiseReduction / gainMode explicitly:
// applyDspSettings leaves absent fields untouched, so a profile that omits
// them inherits whatever the previous preset left behind.
export const DSP_PROFILES: Record<string, DspProfile> = {
    // Xeno-canto-like sonogram: short window for fast song (11.6 ms @ 44.1 kHz),
    // 75 % overlap, 2× zero-padding, dBFS with noise-floor auto contrast.
    xc: {
        scale: 'linear',
        colourScale: 'dbSquared',
        windowSize: 512,
        overlapLevel: 3,       // 75 %
        oversamplingLevel: 1,  // 2× → fft 1024
        nMels: CLASSIC_N_MELS,
        usePcen: false,
        pcenGain: PERCH_PCEN_GAIN,
        pcenBias: PERCH_PCEN_BIAS,
        pcenRoot: PERCH_PCEN_ROOT,
        pcenSmoothing: PERCH_PCEN_SMOOTHING,
        windowFunction: 'hann',
        colorScheme: 'grayscale',
        reassigned: false,
        noiseReduction: false,
        clahe: false,
        gainMode: 'auto',
        maxFreqMode: 'nyquist',
    },
    perch: {
        scale: 'mel',
        windowSize: 1024,
        overlapLevel: 2,       // 50 %
        oversamplingLevel: 1,  // 2× → fft 2048
        nMels: PERCH_N_MELS,
        frameRate: PERCH_FRAME_RATE,
        usePcen: true,
        pcenGain: PERCH_PCEN_GAIN,
        pcenBias: PERCH_PCEN_BIAS,
        pcenRoot: PERCH_PCEN_ROOT,
        pcenSmoothing: PERCH_PCEN_SMOOTHING,
        windowFunction: 'hann',
        colorScheme: 'grayscale',
        reassigned: false,
        noiseReduction: false,
        clahe: false,
        gainMode: 'auto',
        maxFreqMode: 'nyquist',
    },
    classic: {
        scale: 'linear',
        colourScale: 'dbSquared',
        // Was 2048 / 50 %: a 46 ms window with 23 ms hop smears fast song.
        windowSize: 1024,
        overlapLevel: 3,       // 75 %
        oversamplingLevel: 1,  // 2× → fft 2048
        nMels: CLASSIC_N_MELS,
        frameRate: CLASSIC_FRAME_RATE,
        usePcen: false,
        pcenGain: 0,
        pcenBias: 0,
        pcenRoot: 1,
        pcenSmoothing: 0,
        windowFunction: 'hann',
        colorScheme: 'xenocanto',
        reassigned: false,
        noiseReduction: false,
        clahe: false,
        gainMode: 'auto',
        maxFreqMode: 'nyquist',
    },
    birder: {
        scale: 'linear',
        colourScale: 'dbSquared',
        windowSize: 2048,
        overlapLevel: 4,       // 93.75 %
        oversamplingLevel: 0,  // 1× → fft 2048
        nMels: 200,
        usePcen: true,
        pcenGain: 0.8,
        pcenBias: 0.01,
        pcenRoot: 4,
        pcenSmoothing: 0.025,
        windowFunction: 'blackmanHarris',
        colorScheme: 'inferno',
        reassigned: false,
        noiseReduction: false,
        // CLAHE and a fixed floor overrode the noise-floor contrast of the v2 engine.
        clahe: false,
        gainMode: 'auto',
        maxFreqMode: 'nyquist',
    },
};

// ─── Interaction timing ─────────────────────────────────────────────
// Click-suppression windows after drag/pointer events.
// Tuned empirically for touch and mouse interaction reliability.
export const SEEK_CLICK_BLOCK_MS     = 220;  // after drag-seek: block accidental clicks
export const OVERVIEW_CLICK_BLOCK_MS = 260;  // after overview drag: block accidental clicks

// Throttle interval for 'timeupdate' events (~15 fps).
export const TIMEUPDATE_THROTTLE_MS = 66;

// ─── CQT Defaults ──────────────────────────────────────────────────
export const CQT_FMIN = 32.7;           // C1
export const CQT_BINS_PER_OCTAVE = 24;

// ─── Time ↔ Frequency resolution (former quality slider) ──────────
// Window length is a trade-off, not a quality setting: long windows resolve
// frequency but smear fast song in time. Every stop uses 75 % overlap and
// 2× zero-padding, which are the settings that actually cost quality when
// lowered. nMels is left alone (unset).

export const QUALITY_LEVELS: QualityLevel[] = [
    { label: 'Time',      windowSize: 256,  overlapLevel: 3, oversamplingLevel: 1 },
    { label: 'Time+',     windowSize: 512,  overlapLevel: 3, oversamplingLevel: 1 },
    { label: 'Balanced',  windowSize: 1024, overlapLevel: 3, oversamplingLevel: 1 },
    { label: 'Freq+',     windowSize: 2048, overlapLevel: 3, oversamplingLevel: 1 },
    { label: 'Frequency', windowSize: 4096, overlapLevel: 3, oversamplingLevel: 1 },
];

// ─── Colour Scales (SV-style amplitude mapping) ────────────────────
// Determines how raw FFT magnitude/power values map to pixel brightness.
// Modelled after Sonic Visualiser's ColourScaleType.

export const COLOUR_SCALES = {
    linear:  { label: 'Linear',  description: 'Raw magnitude (|X|), proportional pixel mapping' },
    meter:   { label: 'Meter',   description: 'IEC 60268-18 meter law (perceptual loudness)' },
    dbSquared: { label: 'dB²',   description: '10·log₁₀(|X|²) — power spectrum in dB' },
    db:      { label: 'dB',      description: '20·log₁₀(|X|) — voltage/amplitude in dB' },
    phase:   { label: 'Phase',   description: 'atan2(imag, real) — phase angle (−π … +π)' },
};


