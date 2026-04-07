// ═══════════════════════════════════════════════════════════════════════
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

// ─── DSP Profiles ───────────────────────────────────────────────────
// Pre-configured parameter sets for quick switching.
// UI overrides (fftSize, windowSize, hopSize, windowFunction) are
// merged on top of these when the user changes individual controls.

export const DSP_PROFILES = {
    perch: {
        scale: 'mel',
        fftSize: 2048,
        nMels: PERCH_N_MELS,
        frameRate: PERCH_FRAME_RATE,
        usePcen: true,
        pcenGain: PERCH_PCEN_GAIN,
        pcenBias: PERCH_PCEN_BIAS,
        pcenRoot: PERCH_PCEN_ROOT,
        pcenSmoothing: PERCH_PCEN_SMOOTHING,
        windowFunction: 'hann',
        colorScheme: 'grayscale',
    },
    classic: {
        scale: 'linear',
        fftSize: 2048,
        nMels: CLASSIC_N_MELS,
        frameRate: CLASSIC_FRAME_RATE,
        usePcen: false,
        pcenGain: 0,
        pcenBias: 0,
        pcenRoot: 1,
        pcenSmoothing: 0,
        windowFunction: 'hann',
        colorScheme: 'xenocanto',
    },
};
