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
    nMels: number;
}

export const DSP_PROFILES: Record<string, DspProfile> = {
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
        maxFreqMode: 'nyquist',
    },
    classic: {
        scale: 'linear',
        windowSize: 2048,
        overlapLevel: 2,       // 50 %
        oversamplingLevel: 0,  // 1× → fft 2048
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
        clahe: true,
        gainMode: 'fixed',
        gainFloor: 49,
        gainCeil: 100,
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

// ─── Quality Levels (NVIDIA-style Performance ↔ Quality slider) ────
// Each level fully determines DSP parameters.  The slider index (0-4)
// maps directly into this array.

export const QUALITY_LEVELS: QualityLevel[] = [
    { label: 'Performance', windowSize: 256,  overlapLevel: 1, oversamplingLevel: 0, nMels: 80  },
    { label: 'Balanced',    windowSize: 512,  overlapLevel: 2, oversamplingLevel: 0, nMels: 128 },
    { label: 'Quality',     windowSize: 1024, overlapLevel: 2, oversamplingLevel: 1, nMels: 160 },
    { label: 'High',        windowSize: 2048, overlapLevel: 3, oversamplingLevel: 1, nMels: 200 },
    { label: 'Ultra',       windowSize: 4096, overlapLevel: 3, oversamplingLevel: 2, nMels: 256 },
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


