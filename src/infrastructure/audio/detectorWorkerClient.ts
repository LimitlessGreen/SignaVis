// ═══════════════════════════════════════════════════════════════════════
// detectorWorkerClient.ts — main-thread side of detector.worker.ts
//
// Loaded on demand by AudioEngine (dynamic import), so the worker and the
// WASM URL stay out of code paths that never use a detector mode.
// ═══════════════════════════════════════════════════════════════════════

import DetectorWorker from './detector.worker.ts?worker&inline';
import { compileWasmModule, loadWasmMain } from '../wasm-dsp/WasmSpectrogramService.ts';
import { wasmMain } from '../wasm-dsp/wasmMain.ts';
import { divisionNoiseLevel, planChunk, toChunk, type DetectorChunk, type DetectorMode } from './detectorRender.ts';
import { channelData } from '../../shared/utils.ts';

export class DetectorRenderer {
    #worker: Worker;
    #pending = new Map<number, { resolve: (out: Float32Array) => void; reject: (err: Error) => void }>();
    #nextId = 0;

    static async create(): Promise<DetectorRenderer> {
        await loadWasmMain(); // plan + noise level run on the main thread (cheap)
        const module = await compileWasmModule();
        const worker = new DetectorWorker();
        worker.postMessage({ type: 'init', module });
        return new DetectorRenderer(worker);
    }

    private constructor(worker: Worker) {
        this.#worker = worker;
        worker.onmessage = (e: MessageEvent) => {
            const { id, out, error } = e.data;
            const p = this.#pending.get(id);
            if (!p) return;
            this.#pending.delete(id);
            if (error) p.reject(new Error(error));
            else p.resolve(out);
        };
    }

    /** Detector output for [startSec, endSec) of `source` (see detectorRender.ts). */
    render(source: AudioBuffer, mode: DetectorMode, startSec: number, endSec: number, gain: number): Promise<DetectorChunk> {
        const dsp = wasmMain()!;
        const plan = planChunk(dsp, source.length, source.sampleRate, startSec, endSec);
        const input = channelData(source).slice(plan.lo, plan.hi);
        const noiseLevel = mode.kind === 'division' ? divisionNoiseLevel(dsp, source) : 0;
        const id = ++this.#nextId;
        return new Promise<Float32Array>((resolve, reject) => {
            this.#pending.set(id, { resolve, reject });
            this.#worker.postMessage(
                { type: 'render', id, input, sampleRate: source.sampleRate, lo: plan.lo, mode, noiseLevel },
                [input.buffer],
            );
        }).then((out) => toChunk(out, plan, mode, gain));
    }
}
