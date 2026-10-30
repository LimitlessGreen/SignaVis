// ═══════════════════════════════════════════════════════════════════════
// detector.worker.ts — renders bat-detector listening modes off the main
// thread (a 5 s pitch-shift chunk of a 384 kHz file takes ~0.4 s).
//
//   → { type: 'init', module }
//   → { type: 'render', id, input, sampleRate, lo, mode, noiseLevel }
//   ← { id, out } | { id, error }
// ═══════════════════════════════════════════════════════════════════════

import {
    initSync, heterodyne, frequencyDivision, divisionNoiseLevel, pitchShift, detectorDecimation, detectorOutputRate,
} from '../wasm-dsp/pkg/aw_dsp_wasm.js';
import { runDetector, type DetectorDsp } from './detectorRender.ts';

const dsp: DetectorDsp = { heterodyne, frequencyDivision, divisionNoiseLevel, pitchShift, detectorDecimation, detectorOutputRate };

type Ctx = { postMessage(msg: any, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null };
const ctx = self as unknown as Ctx;

ctx.onmessage = (e: MessageEvent) => {
    const msg = e.data;
    if (msg.type === 'init') {
        initSync({ module: msg.module as WebAssembly.Module });
        return;
    }
    if (msg.type !== 'render') return;
    try {
        const out = runDetector(dsp, msg.input, msg.sampleRate, msg.lo, msg.mode, msg.noiseLevel);
        ctx.postMessage({ id: msg.id, out }, [out.buffer]);
    } catch (err: any) {
        ctx.postMessage({ id: msg.id, error: err?.message || String(err) });
    }
};
