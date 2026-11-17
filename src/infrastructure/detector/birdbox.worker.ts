// ═══════════════════════════════════════════════════════════════════════
// infrastructure/detector/birdbox.worker.ts — BirdBox stream in a worker
//
// Pattern of birdbox-worker.js in the BirdNET website demo (MIT, BirdNET-Team).
// The page keeps the audio and hands it out a block at a time (BlockSource),
// so the worker never holds a copy of a long recording.
//
// Messages in:
//   { type: 'init', modelUrl, ortBase, threads }
//   { type: 'file', id, length, conf, step, from, to }      then 'block' replies to 'ask'
//   { type: 'block', id, from, data }
//   { type: 'cancel', id }
//   { type: 'live-start', id, conf } / { type: 'live-push', id, pcm } / { type: 'live-stop', id }
// Messages out:
//   { type: 'ready', config } | { type: 'ask', id, from, to }
//   { type: 'rows', id, data, rows, next, analyzedTo? } | { type: 'done', id } | { type: 'error', id?, message }
// ═══════════════════════════════════════════════════════════════════════

import { BlockSource } from '../../domain/detector/birdboxStream.ts';
import { BirdBoxGraph, type BirdBoxConfig } from './birdboxGraph.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
const ctx = self as any;
const LIVE_MAX_WINDOWS = 8;   // windows per run when detection has fallen behind a recording

let graph: BirdBoxGraph | null = null;
let busy: Promise<void> = Promise.resolve();
const sources = new Map<number, BlockSource>();
const cancelled = new Set<number>();
let live: { id: number; conf: number; stream: ReturnType<BirdBoxGraph['live']>; next: number; running: boolean; stopping: boolean } | null = null;

const post = (msg: any, transfer: Transferable[] = []) => ctx.postMessage(msg, transfer);

async function fetchBytes(url: string): Promise<ArrayBuffer> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.arrayBuffer();
}

async function init(msg: any) {
    const ort = await import(/* @vite-ignore */ `${msg.ortBase}ort.wasm.min.mjs`);
    ort.env.wasm.wasmPaths = msg.ortBase;
    ort.env.wasm.numThreads = msg.threads ?? 1;
    ort.env.logLevel = 'error';
    const base = msg.modelUrl.endsWith('/') ? msg.modelUrl : msg.modelUrl + '/';
    const config: BirdBoxConfig & Record<string, any> = await (await fetch(base + 'model_config.json')).json();
    const [spectrogram, detect] = await Promise.all([
        fetchBytes(base + config.spectrogram.file), fetchBytes(base + config.detect.file),
    ]);
    graph = await BirdBoxGraph.create(ort, { spectrogram, detect },
        { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }, config);
    post({ type: 'ready', config });
}

async function runFile(msg: any) {
    const { id } = msg;
    if (cancelled.delete(id)) return;   // stopped while queued
    const source = new BlockSource(msg.length, (from, to) => post({ type: 'ask', id, from, to }));
    sources.set(id, source);
    try {
        for await (const chunk of graph!.run(source, msg.conf, msg.step ?? 1, msg.from ?? 0, msg.to ?? Infinity)) {
            if (cancelled.has(id)) return;
            post({ type: 'rows', id, ...chunk }, [chunk.data.buffer]);
        }
        post({ type: 'done', id });
    } catch (err) {
        if (!cancelled.has(id)) throw err;   // a cancelled read: the page no longer waits
    } finally {
        sources.delete(id);
        cancelled.delete(id);
    }
}

/** Detect the windows a live recording has ready; one run at a time. */
async function pumpLive() {
    if (!live || live.running) return;
    const l = live;
    l.running = true;
    try {
        while (live === l && l.stream.ready > l.next) {
            const count = Math.min(LIVE_MAX_WINDOWS, l.stream.ready - l.next);
            const chunk = await l.stream.windows(l.conf, l.next, count);
            l.next = chunk.next;
            if (live !== l) return;
            post({ type: 'rows', id: l.id, ...chunk }, [chunk.data.buffer]);
        }
        if (l.stopping) { post({ type: 'done', id: l.id }); if (live === l) live = null; }
    } finally {
        l.running = false;
    }
}

ctx.onmessage = (e: MessageEvent) => {
    const msg = (e.data as any);
    const fail = (err: unknown) => post({ type: 'error', id: msg.id, message: String((err as Error)?.message || err) });
    switch (msg.type) {
        case 'init':
            busy = busy.then(() => init(msg)).catch(fail);
            break;
        case 'file':
            busy = busy.then(() => runFile(msg)).catch(fail);   // runs one after another
            break;
        case 'block':
            sources.get(msg.id)?.receive({ from: msg.from, data: msg.data });
            break;
        case 'cancel':
            cancelled.add(msg.id);
            // Wake a read waiting for a block the page will no longer send
            sources.get(msg.id)?.cancel(new Error('Detection cancelled'));
            break;
        case 'live-start':
            if (!graph) { fail(new Error('model not loaded')); break; }
            live = { id: msg.id, conf: msg.conf, stream: graph.live(), next: 0, running: false, stopping: false };
            break;
        case 'live-push': {
            const l = live;
            if (l && l.id === msg.id) { l.stream.push(msg.pcm); pumpLive().catch(fail); }
            break;
        }
        case 'live-stop': {
            const l = live;
            if (l && l.id === msg.id) { l.stopping = true; pumpLive().catch(fail); }
            break;
        }
    }
};
