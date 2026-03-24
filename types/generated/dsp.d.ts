export function hzToMel(hz: any): number;
export function melToHz(mel: any): number;
/**
 * Return an array of `nMels` frequencies (Hz) evenly spaced in mel scale
 * from 0 Hz to sampleRate/2.
 */
export function buildMelFrequencies(sampleRate: any, nMels: any): Float32Array<any>;
export function createMelFilterbank(sampleRate: any, fftSize: any, nMels: any, fMin: any, fMax: any): Float32Array<ArrayBuffer>[];
export function applyMelFilterbank(powerSpectrum: any, melFilterbank: any): Float32Array<any>;
export function iterativeFFT(real: any, imag: any): void;
/**
 * Compute the magnitude spectrum of a windowed (Hann) frame via FFT.
 * Returns a Float32Array of length fftSize/2.
 */
export function fftMagnitudeSpectrum(audio: any, offset: any, winLength: any, fftSize: any): Float32Array<ArrayBuffer>;
/**
 * Compute a full spectrogram from raw audio samples.
 *
 * @param {Object} params
 * @param {ArrayBuffer|Float32Array} params.channelData - mono audio samples
 * @param {number} params.fftSize
 * @param {number} params.sampleRate
 * @param {number} params.frameRate      - frames per second
 * @param {number} params.nMels          - mel bins (Perch mode)
 * @param {number} params.pcenGain
 * @param {number} params.pcenBias
 * @param {number} params.pcenRoot
 * @param {number} params.pcenSmoothing
 * @param {string} [params.spectrogramMode='perch'] - 'perch' or 'classic'
 * @param {Float32Array} [params.initialSmooth] - carry-over PCEN smooth state from previous chunk
 *
 * @returns {{ data: Float32Array, nFrames: number, nMels: number, smoothState?: Float32Array }}
 */
export function computeSpectrogram(params: {
    channelData: ArrayBuffer | Float32Array;
    fftSize: number;
    sampleRate: number;
    frameRate: number;
    nMels: number;
    pcenGain: number;
    pcenBias: number;
    pcenRoot: number;
    pcenSmoothing: number;
    spectrogramMode?: string | undefined;
    initialSmooth?: Float32Array<ArrayBufferLike> | undefined;
}): {
    data: Float32Array;
    nFrames: number;
    nMels: number;
    smoothState?: Float32Array;
};
