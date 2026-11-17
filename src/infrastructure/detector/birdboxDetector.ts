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
    /** Stop before this window (with detect's `from`: only a stretch of the recording). */
    to?: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Operation { handle: (msg: any) => void; fail: (err: Error) => void }

const abortError = () => new DOMException('Detection cancelled', 'AbortError');

export class BirdBoxDetector {
    private worker: Worker | null = null;
    private nextId = 1;
    /** Requests in progress; each settles on its messages, or fails with the worker. */
    private ops = new Map<number, Operation>();
    private ready: Promise<BirdBoxModelConfig> | null = null;
    private failLoad: ((err: Error) => void) | null = null;
    config: BirdBoxModelConfig | null = null;

    /** Load the model into a worker (once). */
    load(modelUrl = BIRDBOX_MODEL_URL): Promise<BirdBoxModelConfig> {
        if (this.ready) return this.ready;
        const worker = this.worker = new BirdBoxWorker();
        const ready = this.ready = new Promise<BirdBoxModelConfig>((resolve, reject) => {
            this.failLoad = reject;
            worker.onmessage = (e: MessageEvent) => {
                const msg = e.data as any;
                if (msg.type === 'ready') { this.config = msg.config; this.failLoad = null; resolve(msg.config); return; }
                if (msg.type === 'error' && msg.id == null) { this.failAll(new Error(msg.message)); return; }
                this.ops.get(msg.id)?.handle(msg);
            };
            // A crash of the worker: the load, or else every request in progress, fails
            worker.onerror = (e: ErrorEvent) => this.failAll(new Error(e.message || 'BirdBox worker failed'));
        });
        const absolute = new URL(modelUrl, globalThis.location?.href).href;
        const threads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
        worker.postMessage({ type: 'init', modelUrl: absolute, ortBase: ORT_BASE, threads });
        ready.catch(() => { if (this.ready === ready) this.dispose(); });
        return ready;
    }

    /**
     * Raw rows of a whole recording (32 kHz mono). With `from`, continues a run whose
     * first `from` windows are in `store` (used when a live recording ends).
     */
    async detect(pcm: Float32Array, opts: DetectOptions = {}, from = 0, store = new RowStore()): Promise<RawRows> {
        await this.load();
        if (opts.signal?.aborted) throw abortError();
        const worker = this.worker!, id = this.nextId++;
        return new Promise<RawRows>((resolve, reject) => {
            let analyzed = 0, next = from;
            const finish = (fn: () => void) => { this.ops.delete(id); opts.signal?.removeEventListener('abort', abort); fn(); };
            const abort = () => {
                worker.postMessage({ type: 'cancel', id });
                finish(() => reject(abortError()));
            };
            opts.signal?.addEventListener('abort', abort);
            const snapshot = (done: boolean): RawRows => ({ data: store.data.subarray(0, store.rows * RAW_COLS), rows: store.rows, next, analyzedTo: analyzed, done });
            this.ops.set(id, {
                fail: err => finish(() => reject(err)),
                handle: msg => {
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
                },
            });
            worker.postMessage({ type: 'file', id, length: pcm.length, conf: BIRDBOX_RAW_CONF, from, to: opts.to, step: opts.step ?? 1 });
        });
    }

    /**
     * A recording in progress. push() 32 kHz mono audio as it arrives; rows of every
     * window are final as soon as the audio reaches its end. stop() runs the last
     * windows as in the saved file and resolves with all rows (file end set). A failure
     * of the detection is passed to `onError` and makes stop() reject.
     */
    async startLive(onRows?: (raw: RawRows) => void, onError?: (err: Error) => void) {
        await this.load();
        const worker = this.worker!, id = this.nextId++, store = new RowStore();
        let audio = new Float32Array(60 * SAMPLE_RATE), n = 0, next = 0;
        let failure: Error | null = null;
        let drained: { resolve: () => void; reject: (err: Error) => void } | null = null;
        const fail = (err: Error) => {
            if (failure) return;
            failure = err;
            this.ops.delete(id);
            drained?.reject(err);
            drained = null;
            onError?.(err);
        };
        worker.postMessage({ type: 'live-start', id, conf: BIRDBOX_RAW_CONF });
        this.ops.set(id, {
            fail,
            handle: msg => {
                if (msg.type === 'rows') {
                    store.append(msg.data, msg.rows);
                    next = msg.next;
                    onRows?.({ data: store.data.subarray(0, store.rows * RAW_COLS), rows: store.rows, next, analyzedTo: (next - 1) * HOP_SECONDS + 2.25, done: false });
                } else if (msg.type === 'done') {
                    drained?.resolve();
                    drained = null;
                } else if (msg.type === 'error') {
                    worker.postMessage({ type: 'live-stop', id });
                    fail(new Error(msg.message));
                }
            },
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
                if (!failure) worker.postMessage({ type: 'live-push', id, pcm: pcm.slice() });
            },
            /** The recording so far (32 kHz mono); kept for saving it and for stop(). */
            get audio() { return audio.subarray(0, n); },
            stop: async (opts: DetectOptions = {}): Promise<RawRows> => {
                if (failure) throw failure;
                const { signal } = opts;
                if (signal?.aborted) throw abortError();
                const onAbort = () => { drained?.reject(abortError()); drained = null; };
                signal?.addEventListener('abort', onAbort);
                try {
                    await new Promise<void>((resolve, reject) => {
                        drained = { resolve, reject };
                        worker.postMessage({ type: 'live-stop', id });
                    });
                } finally {
                    signal?.removeEventListener('abort', onAbort);
                    this.ops.delete(id);
                }
                // The rows so far equal the file's except for the file end (NO_END): set it, and
                // run only the last windows, which the audio never reached, as the file pads them
                const pcm = audio.slice(0, n), end = fileEnd(n);
                for (let r = 0; r < store.rows; r++) store.data[r * RAW_COLS + 8] = end;
                return this.detect(pcm, opts, next, store);
            },
        };
    }

    /** Fail the load (if pending) and every request in progress. */
    private failAll(err: Error): void {
        this.failLoad?.(err);
        this.failLoad = null;
        const ops = [...this.ops.values()];
        this.ops.clear();
        for (const op of ops) op.fail(err);
    }

    dispose(): void {
        const worker = this.worker;
        this.worker = null;
        this.ready = null;
        this.failAll(new Error('BirdBox detector disposed'));
        worker?.terminate();
    }
}
