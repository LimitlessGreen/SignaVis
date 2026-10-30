// ═══════════════════════════════════════════════════════════════════════
// wasmMain.ts — aw-dsp WASM instance on the main thread
//
// For small synchronous operations (CLAHE on the stage-1 image, the
// STFT patch behind "Snap to call", bat-detector listening modes).
// Initialised from the module WasmSpectrogramService compiles anyway, so
// nothing is fetched twice; until then wasmMain() returns null and callers
// fall back to their JS path.
// ═══════════════════════════════════════════════════════════════════════

import {
    initSync, clahe, bandFloor, WasmStft,
    heterodyne, frequencyDivision, divisionNoiseLevel, pitchShift, detectorDecimation, detectorOutputRate,
} from './pkg/aw_dsp_wasm.js';

const api = {
    clahe, bandFloor, WasmStft,
    heterodyne, frequencyDivision, divisionNoiseLevel, pitchShift, detectorDecimation, detectorOutputRate,
};
let ready = false;
const listeners: Array<() => void> = [];

export function initWasmMain(module: WebAssembly.Module): void {
    if (ready) return;
    initSync({ module });
    ready = true;
    for (const fn of listeners.splice(0)) fn();
}

/** Synchronous aw-dsp display functions, or null before initialisation. */
export function wasmMain(): typeof api | null {
    return ready ? api : null;
}

/** Calls `fn` once the main-thread instance is ready (immediately if it is). */
export function onWasmMainReady(fn: () => void): void {
    if (ready) fn(); else listeners.push(fn);
}
