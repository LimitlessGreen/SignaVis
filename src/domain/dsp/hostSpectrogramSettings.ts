// ═══════════════════════════════════════════════════════════════════════
// domain/dsp/hostSpectrogramSettings.ts — spectrogram settings set by the host
//
// An app that embeds the player can set some spectrogram settings from its own
// settings page (option `spectrogramSettings`, method setSpectrogramSettings()).
// They apply over the start preset and over the last-used settings.
// ═══════════════════════════════════════════════════════════════════════

import { SPECTROGRAM_COLOR_SCHEMES } from '../spectrogram.ts';
import { DB_CONTRAST } from '../../shared/constants.ts';
import type { DspSettings } from './DspSettings.ts';

export interface HostSpectrogramSettings {
    /** Colour scheme, e.g. 'viridis', 'magma', 'plasma', 'inferno', 'jet', 'grayscale'. */
    colorScheme?: string;
    /** FFT window in samples: 256 … 8192, a power of two. */
    windowSize?: number;
    /** Window overlap: 0 none, 1 25 %, 2 50 %, 3 75 %, 4 87.5 %, 5 93.75 %. */
    overlapLevel?: number;
    /** Zero-padding: 0 1×, 1 2×, 2 4×, 3 8×. */
    oversamplingLevel?: number;
    /** Frequency axis: 'linear', 'mel' or 'cqt' (logarithmic). */
    scale?: string;
    /**
     * Automatic contrast with this dynamic range in dB, measured down from the
     * loudest level (99.9th percentile of the visible values). null: the player's
     * own automatic contrast.
     */
    contrastRangeDb?: number | null;
}

const WINDOW_SIZES = [256, 512, 1024, 2048, 4096, 8192];
const SCALES = ['linear', 'mel', 'cqt'];

function intIn(key: string, v: unknown, allowed: number[]): number {
    if (typeof v !== 'number' || !allowed.includes(v)) {
        throw new TypeError(`spectrogramSettings.${key}: expected one of ${allowed.join(', ')}, got ${JSON.stringify(v)}`);
    }
    return v;
}

function oneOf(key: string, v: unknown, allowed: readonly string[]): string {
    if (typeof v !== 'string' || !allowed.includes(v)) {
        throw new TypeError(`spectrogramSettings.${key}: expected one of ${allowed.join(', ')}, got ${JSON.stringify(v)}`);
    }
    return v;
}

/**
 * Checks host settings and splits them into DSP settings for the controls and
 * the contrast range. Throws a TypeError on an unknown key or a value the
 * player has no control for, so a typo does not pass silently.
 */
export function parseHostSpectrogramSettings(s: HostSpectrogramSettings | null | undefined): {
    dsp: Partial<DspSettings>;
    contrastRangeDb: number | null;
} {
    const dsp: Partial<DspSettings> = {};
    let contrastRangeDb: number | null = null;
    if (s == null) return { dsp, contrastRangeDb };
    if (typeof s !== 'object' || Array.isArray(s)) throw new TypeError('spectrogramSettings: expected an object');
    for (const [key, v] of Object.entries(s)) {
        if (v === undefined) continue;
        switch (key) {
            case 'colorScheme': dsp.colorScheme = oneOf(key, v, SPECTROGRAM_COLOR_SCHEMES); break;
            case 'windowSize': dsp.windowSize = intIn(key, v, WINDOW_SIZES); break;
            case 'overlapLevel': dsp.overlapLevel = intIn(key, v, [0, 1, 2, 3, 4, 5]); break;
            case 'oversamplingLevel': dsp.oversamplingLevel = intIn(key, v, [0, 1, 2, 3]); break;
            case 'scale': dsp.scale = oneOf(key, v, SCALES); break;
            case 'contrastRangeDb':
                if (v === null) break;
                if (typeof v !== 'number' || !Number.isFinite(v)
                    || v < DB_CONTRAST.range.min || v > DB_CONTRAST.range.max) {
                    throw new TypeError(`spectrogramSettings.contrastRangeDb: expected ${DB_CONTRAST.range.min} … ${DB_CONTRAST.range.max} dB or null, got ${JSON.stringify(v)}`);
                }
                contrastRangeDb = v;
                break;
            default:
                throw new TypeError(`spectrogramSettings: unknown setting ${JSON.stringify(key)}`);
        }
    }
    return { dsp, contrastRangeDb };
}

/**
 * Black level (above the noise floor) and range of the automatic dB contrast
 * when the host fixes the dynamic range: white stays where the automatic
 * contrast puts it, black lies `rangeDb` below. Both are clamped to the
 * sliders; a clamped black level keeps white in place.
 */
export function contrastFromTop(whiteDb: number, noiseDb: number, rangeDb: number): { floor: number; range: number } {
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    const floor = clamp(Math.round(whiteDb - rangeDb - noiseDb), DB_CONTRAST.floor.min, DB_CONTRAST.floor.max);
    const range = clamp(Math.round(whiteDb - (noiseDb + floor)), DB_CONTRAST.range.min, DB_CONTRAST.range.max);
    return { floor, range };
}
