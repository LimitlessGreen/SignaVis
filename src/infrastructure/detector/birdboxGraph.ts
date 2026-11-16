// ═══════════════════════════════════════════════════════════════════════
// infrastructure/detector/birdboxGraph.ts — BirdBox streaming graphs on ONNX Runtime
//
// Adapted from StreamGraph in birdbox-stream.js of the BirdNET website demo
// (https://github.com/birdnet-team/birdnet-website, MIT License,
// Copyright (c) 2026 BirdNET-Team). Model weights: AGPL-3.0, BirdNET-Team.
//
// Two models (scripts/birdbox/fetch-model.mjs cuts them out of the BirdBox model):
//   spectrogram(audio) -> db (n_mels, frames), sound (frames)
//   detect(db, first_frame, times, conf, floor) -> raw
// The floors come from RollingFloor, so the network gets only each window's own
// frames. A window's rows equal those of one run of the whole graph.
//
// The ONNX Runtime module is passed in (onnxruntime-web in the worker and in
// Node tests), so this file imports no runtime itself.
// ═══════════════════════════════════════════════════════════════════════

import {
    analyzedTo, finishRows, floorFirstFrame, Frames, HOP_LENGTH, HOP_SECONDS, lastFrame, LEFT_PAD,
    N_FFT, N_MELS, paddedLength, readPadded, readyWindows, RollingFloor, SAMPLE_RATE, sourceOf,
    WINDOW_FRAMES, windowCount, type FrameGrid, type SampleSource,
} from '../../domain/detector/birdboxStream.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Ort = any;
type Session = any;

export interface BirdBoxConfig {
    floorWindowSeconds: number;
    frameOrigin: number;
}

export interface RowsChunk {
    /** Raw rows, 9 columns each (see domain/detector/fusion.ts). */
    data: Float32Array;
    rows: number;
    /** Windows done; a run given it as `from` continues there. */
    next: number;
    analyzedTo?: number;
}

export class BirdBoxGraph {
    private constructor(
        private readonly ort: Ort,
        private readonly spectrogram: Session,
        private readonly detect: Session,
        private readonly grid: FrameGrid,
    ) {}

    static async create(ort: Ort, models: { spectrogram: Uint8Array | ArrayBuffer; detect: Uint8Array | ArrayBuffer },
        options: object, config: BirdBoxConfig): Promise<BirdBoxGraph> {
        const spectrogram = await ort.InferenceSession.create(new Uint8Array(models.spectrogram), options);
        const detect = await ort.InferenceSession.create(new Uint8Array(models.detect), options);
        if (!detect.inputNames.includes('floor')) throw new Error('BirdBox: detect graph without a floor input (fetch-model.mjs)');
        return new BirdBoxGraph(ort, spectrogram, detect, {
            frameOrigin: config.frameOrigin,
            floorWindowSamples: config.floorWindowSeconds * SAMPLE_RATE,
        });
    }

    /**
     * Compute frames up to `upTo` from the first n samples the graph sees (silence after the
     * source's end), `block` frames at most per run. Afterwards the source may let go of the
     * samples before the next frame.
     */
    private async frames(frames: Frames, source: SampleSource, n: number, upTo: number, block: number): Promise<void> {
        const { ort } = this, origin = this.grid.frameOrigin;
        const available = Math.floor((n - origin - N_FFT) / HOP_LENGTH);
        if (upTo > available) throw new Error(`frame ${upTo} needs more than ${n} samples`);
        while (frames.end <= upTo) {
            const m0 = frames.end, m1 = Math.min(available, Math.max(upTo, m0 + block - 1));
            const s0 = m0 * HOP_LENGTH + origin, s1 = m1 * HOP_LENGTH + origin + N_FFT;
            // Before the file start: the samples the graph's left pad puts there
            let piece = await readPadded(source, Math.max(0, s0), s1);
            if (s0 < 0) {
                const pre = new Float32Array(s1 - s0);
                pre.set(await readPadded(source, LEFT_PAD + s0, LEFT_PAD));
                pre.set(piece, -s0);
                piece = pre;
            }
            const out = await this.spectrogram.run({ audio: new ort.Tensor('float32', piece, [piece.length]) });
            const count = out.db.dims[1];
            if (count !== m1 - m0 + 1) throw new Error(`${count} frames from the spectrogram, ${m1 - m0 + 1} expected`);
            frames.append(out.db.data, out.sound.data, count);
        }
        source.release?.(Math.max(0, frames.end * HOP_LENGTH + origin));
    }

    /** Raw rows of windows w0 .. w0+count-1 (column 0 and 8 not yet set, see finishRows). */
    private async detectWindows(frames: Frames, w0: number, count: number, conf: number): Promise<{ data: Float32Array; rows: number }> {
        const { ort, grid } = this, first = floorFirstFrame(w0, grid), end = lastFrame(w0 + count - 1) + 1;
        const times = new Float32Array(count);
        for (let i = 0; i < count; i++) times[i] = (w0 + i) * HOP_SECONDS;
        const floor = new Float32Array(N_MELS * count), rolling = frames.rolling ??= new RollingFloor();
        for (let i = 0; i < count; i++) rolling.at(frames, floorFirstFrame(w0 + i, grid), lastFrame(w0 + i) + 1, floor, i, count);
        frames.drop(first);   // the next windows start their floor windows later
        const from = w0 * WINDOW_FRAMES;
        const { db, n } = frames.slice(from, end);
        const raw = (await this.detect.run({
            times: new ort.Tensor('float32', times, [count]),
            conf: new ort.Tensor('float32', Float32Array.of(conf), [1]),
            floor: new ort.Tensor('float32', floor, [N_MELS, count, 1]),
            db: new ort.Tensor('float32', db, [N_MELS, n]),
            first_frame: new ort.Tensor('int64', BigInt64Array.of(BigInt(from)), []),
        })).raw;
        const rows = raw.dims[0] || 0;
        return { data: (raw.data as Float32Array).slice(), rows };
    }

    /**
     * A whole recording: yields rows after every `step` windows.
     * @param samples mono audio at 32 kHz, or a source of it (BlockSource in a worker)
     * @param conf    run at the lowest confidence the sliders allow; fusion filters above it
     * @param from    windows already done
     */
    async* run(samples: Float32Array | SampleSource, conf: number, step: number, from = 0): AsyncGenerator<RowsChunk> {
        const source = sourceOf(samples), n = source.length, target = paddedLength(n), total = windowCount(n);
        // A resumed run starts at the floor window of its first window, not at the file start
        const frames = new Frames();
        frames.base = floorFirstFrame(from, this.grid);
        for (let w = from; w < total;) {
            const k = Math.min(step, total - w);
            // Only the frames of these windows: computing the next ones too would make this run slower than the others
            await this.frames(frames, source, target, lastFrame(w + k - 1), k * WINDOW_FRAMES);
            const det = await this.detectWindows(frames, w, k, conf);
            const { data, rows } = finishRows(det.data, det.rows, n);
            w += k;
            yield { data, rows, next: w, analyzedTo: analyzedTo(w) };
        }
    }

    /**
     * A recording in progress: push() its audio as it arrives, windows() gives the final
     * rows of the next windows once they are ready (readyWindows of the samples pushed),
     * with the file end (column 8) NO_END. Only new audio is turned into frames.
     */
    live() {
        const graph = this, frames = new Frames();
        // Only the audio future frames need: samples from `offset` on (absolute indices)
        let audio = new Float32Array(30 * SAMPLE_RATE), offset = 0, n = 0;
        const source: SampleSource = {
            get length() { return n; },
            read: (from, to) => {
                if (from < offset) throw new Error(`live samples from ${from} on were let go (${offset})`);
                return audio.subarray(from - offset, to - offset);
            },
            release: (before) => {
                // The graph's left pad mirrors the first 0.5 s: keep them until the first frames are done
                const drop = Math.min(n, before) - offset;
                if (frames.end === 0 || drop <= 0) return;
                audio.copyWithin(0, drop, n - offset);
                offset += drop;
            },
        };
        return {
            get length() { return n; },
            get ready() { return readyWindows(n); },
            push(pcm: Float32Array) {
                const held = n - offset;
                if (held + pcm.length > audio.length) {
                    const grown = new Float32Array(Math.max(2 * audio.length, held + pcm.length));
                    grown.set(audio.subarray(0, held));
                    audio = grown;
                }
                audio.set(pcm, held);
                n += pcm.length;
            },
            async windows(conf: number, from: number, count: number): Promise<RowsChunk> {
                if (from + count > readyWindows(n)) throw new Error(`windows ${from} to ${from + count - 1} are not ready in ${n} samples`);
                await graph.frames(frames, source, n, lastFrame(from + count - 1), WINDOW_FRAMES);
                const det = await graph.detectWindows(frames, from, count, conf);
                const { data, rows } = finishRows(det.data, det.rows, null);
                return { data, rows, next: from + count };
            },
        };
    }
}
