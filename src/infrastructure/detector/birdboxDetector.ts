// ═══════════════════════════════════════════════════════════════════════
// infrastructure/detector/birdboxDetector.ts — BirdBox Just-Bird for the app
//
// Runs birdbox.worker.ts and collects the raw rows of a file or a live
// recording; fuse them with domain/detector/fusion.ts for any (confidence,
// phrase gap) setting. Audio must be mono at 32 kHz.
//
// The model (AGPL-3.0, BirdNET-Team) is fetched at build time by
// scripts/birdbox/fetch-model.mjs into models/birdbox-just-bird/ and loaded by
// URL, like the BirdNET models.
// ═══════════════════════════════════════════════════════════════════════

import { RAW_COLS } from '../../domain/detector/fusion.ts';
import { fileEnd, HOP_SECONDS, SAMPLE_RATE } from '../../domain/detector/birdboxStream.ts';
import { onDemandUrl, vendorUrl } from '../tauri/runtime.ts';
import BirdBoxWorker from './birdbox.worker.ts?worker&inline';

const ORT_VERSION = '1.30.0';
const ORT_BASE = vendorUrl('ort/', `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`);
/** Like the BirdNET presets: relative to the demo page in the browser, the data protocol in Lite. */
export const BIRDBOX_MODEL_URL = onDemandUrl('models/birdbox-just-bird/', '../models/birdbox-just-bird/');
/** The run's confidence: the lowest the slider allows; fusion filters above it. */
export const BIRDBOX_RAW_CONF = 0.05;

export interface BirdBoxModelConfig {
    name: string;
    license: string;
    defaultConf: number;
    defaultPhraseGap: number;
    classNames: Record<string, string>;
    [key: string]: unknown;
}

/** Raw rows collected so far; `next` is the next window (its start: next × 1.5 s). */
export interface RawRows {
    data: Float32Array;
    rows: number;
    next: number;
    /** Seconds up to which every window that owns a box has been seen. */
    analyzedTo: number;
    done: boolean;
}

/** Earliest start of a box in rows still to come (fuseBoxes' `later`). */
export const laterOf = (raw: RawRows): number => (raw.done ? Infinity : raw.next * HOP_SECONDS);

class RowStore {
    data = new Float32Array(0);
    rows = 0;
    append(chunk: Float32Array, rows: number) {
        const need = (this.rows + rows) * RAW_COLS;
        if (need > this.data.length) {
            const grown = new Float32Array(Math.max(need, 2 * this.data.length, 64 * RAW_COLS));
            grown.set(this.data.subarray(0, this.rows * RAW_COLS));
            this.data = grown;
        }
        this.data.set(chunk.subarray(0, rows * RAW_COLS), this.rows * RAW_COLS);
        this.rows += rows;
    }
}

export interface DetectOptions {
    /** Called after every chunk of windows (feed it to a Pacer for even display). */
    onRows?: (raw: RawRows) => void;
    signal?: AbortSignal;
    /** Windows per network run (1 = boxes appear soonest). */
    step?: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export class BirdBoxDetector {
    private worker: Worker | null = null;
    private nextId = 1;
    private handlers = new Map<number, (msg: any) => void>();
    private ready: Promise<BirdBoxModelConfig> | null = null;
    config: BirdBoxModelConfig | null = null;

    /** Load the model into a worker (once). */
    load(modelUrl = BIRDBOX_MODEL_URL): Promise<BirdBoxModelConfig> {
        if (this.ready) return this.ready;
        const worker = this.worker = new BirdBoxWorker();
        this.ready = new Promise((resolve, reject) => {
            worker.onmessage = (e: MessageEvent) => {
                const msg = e.data as any;
                if (msg.type === 'ready') { this.config = msg.config; resolve(msg.config); return; }
                if (msg.type === 'error' && msg.id == null) { reject(new Error(msg.message)); return; }
                this.handlers.get(msg.id)?.(msg);
            };
            worker.onerror = (e: ErrorEvent) => reject(new Error(e.message));
        });
        const absolute = new URL(modelUrl, globalThis.location?.href).href;
        const threads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
        worker.postMessage({ type: 'init', modelUrl: absolute, ortBase: ORT_BASE, threads });
        this.ready.catch(() => this.dispose());
        return this.ready;
    }

    /**
     * Raw rows of a whole recording (32 kHz mono). With `from`, continues a run whose
     * first `from` windows are in `store` (used when a live recording ends).
     */
    async detect(pcm: Float32Array, opts: DetectOptions = {}, from = 0, store = new RowStore()): Promise<RawRows> {
        await this.load();
        const worker = this.worker!, id = this.nextId++;
        return new Promise<RawRows>((resolve, reject) => {
            let analyzed = 0, next = from;
            const finish = (fn: () => void) => { this.handlers.delete(id); opts.signal?.removeEventListener('abort', abort); fn(); };
            const abort = () => {
                worker.postMessage({ type: 'cancel', id });
                finish(() => reject(new DOMException('Detection cancelled', 'AbortError')));
            };
            if (opts.signal?.aborted) { abort(); return; }
            opts.signal?.addEventListener('abort', abort);
            const snapshot = (done: boolean): RawRows => ({ data: store.data.subarray(0, store.rows * RAW_COLS), rows: store.rows, next, analyzedTo: analyzed, done });
            this.handlers.set(id, msg => {
                if (msg.type === 'ask') {
                    const data = pcm.slice(msg.from, msg.to);
                    worker.postMessage({ type: 'block', id, from: msg.from, data }, [data.buffer]);
                } else if (msg.type === 'rows') {
                    store.append(msg.data, msg.rows);
                    next = msg.next;
                    analyzed = msg.analyzedTo ?? analyzed;
                    opts.onRows?.(snapshot(false));
                } else if (msg.type === 'done') {
                    finish(() => resolve(snapshot(true)));
                } else if (msg.type === 'error') {
                    finish(() => reject(new Error(msg.message)));
                }
            });
            worker.postMessage({ type: 'file', id, length: pcm.length, conf: BIRDBOX_RAW_CONF, from, step: opts.step ?? 1 });
        });
    }

    /**
     * A recording in progress. push() 32 kHz mono audio as it arrives; rows of every
     * window are final as soon as the audio reaches its end. stop() runs the last
     * windows as in the saved file and resolves with all rows (file end set).
     */
    async startLive(onRows?: (raw: RawRows) => void) {
        await this.load();
        const worker = this.worker!, id = this.nextId++, store = new RowStore();
        let audio = new Float32Array(60 * SAMPLE_RATE), n = 0, next = 0;
        worker.postMessage({ type: 'live-start', id, conf: BIRDBOX_RAW_CONF });
        let stopped: (() => void) | null = null;
        this.handlers.set(id, msg => {
            if (msg.type === 'rows') {
                store.append(msg.data, msg.rows);
                next = msg.next;
                onRows?.({ data: store.data.subarray(0, store.rows * RAW_COLS), rows: store.rows, next, analyzedTo: (next - 1) * HOP_SECONDS + 2.25, done: false });
            } else if (msg.type === 'done') stopped?.();
        });
        return {
            push: (pcm: Float32Array) => {
                if (n + pcm.length > audio.length) {
                    const grown = new Float32Array(Math.max(2 * audio.length, n + pcm.length));
                    grown.set(audio.subarray(0, n));
                    audio = grown;
                }
                audio.set(pcm, n);
                n += pcm.length;
                worker.postMessage({ type: 'live-push', id, pcm: pcm.slice() });
            },
            /** The recording so far (32 kHz mono). */
            get audio() { return audio.subarray(0, n); },
            stop: async (opts: DetectOptions = {}): Promise<RawRows> => {
                await new Promise<void>(resolve => { stopped = resolve; worker.postMessage({ type: 'live-stop', id }); });
                this.handlers.delete(id);
                // The rows so far equal the file's except for the file end (NO_END): set it, and
                // run only the last windows, which the audio never reached, as the file pads them
                const pcm = audio.slice(0, n), end = fileEnd(n);
                for (let r = 0; r < store.rows; r++) store.data[r * RAW_COLS + 8] = end;
                return this.detect(pcm, opts, next, store);
            },
        };
    }

    dispose(): void {
        this.worker?.terminate();
        this.worker = null;
        this.ready = null;
        this.handlers.clear();
    }
}
