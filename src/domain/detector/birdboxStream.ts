// ═══════════════════════════════════════════════════════════════════════
// domain/detector/birdboxStream.ts — BirdBox as a stream: windows, frames, floor
//
// Adapted from birdbox-stream.js in the BirdNET website demo
// (https://github.com/birdnet-team/birdnet-website, MIT License,
// Copyright (c) 2026 BirdNET-Team), a port of StreamGraph in BirdBox's
// docs/javascripts/demo/chunked-graph.js. The parts without ONNX Runtime live
// here; the two sessions (spectrogram, detect) follow in infrastructure/.
//
// The model takes each 3 s window's noise floor from the 60 s before the
// window's end, on one frame grid for the whole recording. So the spectrogram
// is computed once, a few seconds of audio at a time, and kept as frames
// (Frames), and each window goes through the network as soon as its frames
// are there. A window's rows are final as soon as the audio reaches its end
// (readyWindows) — in a file and in a recording still in progress alike.
//
// Frame m covers samples m·HOP_LENGTH + origin … + N_FFT; window w is frames
// 128·w … 128·w + 251.
// ═══════════════════════════════════════════════════════════════════════

const f32 = Math.fround;

export const SAMPLE_RATE = 32000;
export const CLIP_SECONDS = 3;
export const CLIP_SAMPLES = CLIP_SECONDS * SAMPLE_RATE;
export const HOP_SAMPLES = CLIP_SAMPLES / 2;
export const HOP_SECONDS = HOP_SAMPLES / SAMPLE_RATE;
/** A window owns its boxes up to here (see fusion.ts). */
export const OWNED_UNTIL = 0.75 * CLIP_SECONDS;
/** Column 0 counts the windows of each minute, as in the graph. */
export const SEGMENT_CLIPS = 60 / HOP_SECONDS;
// The model's spectrogram (onnx_export.py in BirdBox)
export const N_MELS = 256, HOP_LENGTH = 375, N_FFT = 2048, CLIP_FRAMES = 252;
/** 128 frames from one window to the next. */
export const WINDOW_FRAMES = HOP_SAMPLES / HOP_LENGTH;
/** Audio the graph mirrors in front of the file: 0.5 s. */
export const LEFT_PAD = 16000;
/** FLOOR_PERCENTILE / 100 in BirdBox's onnx_export.py, in float32. */
export const FLOOR_FRACTION = f32(20 / 100);

/** File end of rows (column 8) while the recording is still growing. */
export const NO_END = 1e9;

/** Windows whose rows are final in a recording of n samples: the audio has reached their end. */
export const readyWindows = (n: number): number => Math.max(0, Math.floor((n - CLIP_SAMPLES) / HOP_SAMPLES) + 1);

/** Samples the graph pads n samples to: the end of the last window. */
export const paddedLength = (n: number): number =>
    CLIP_SAMPLES + Math.ceil(Math.max(0, n - CLIP_SAMPLES) / HOP_SAMPLES) * HOP_SAMPLES;

/** Windows in a recording of n samples. */
export const windowCount = (n: number): number => (paddedLength(n) - CLIP_SAMPLES) / HOP_SAMPLES + 1;

/** File end of rows (column 8) for a recording of n samples: where its last window ends. */
export const fileEnd = (n: number): number => f32(paddedLength(n) / SAMPLE_RATE);

/** Seconds up to which every window that owns a box has been seen, after `windows` windows. */
export const analyzedTo = (windows: number): number => (windows - 1) * HOP_SECONDS + OWNED_UNTIL;

// ── Audio sources ─────────────────────────────────────────────────────

/** Samples for the stream: read(from, to) gives (or resolves to) samples from..to-1, reads move forward. */
export interface SampleSource {
    readonly length: number;
    read(from: number, to: number): Float32Array | Promise<Float32Array>;
    /** The samples before `before` are done with. */
    release?(before: number): void;
}

export const sourceOf = (samples: Float32Array | SampleSource): SampleSource =>
    samples instanceof Float32Array
        ? { length: samples.length, read: (from, to) => samples.subarray(from, to) }
        : samples;

/** Samples from..to-1 of a source, and silence after its end, as the graph pads the file. */
export async function readPadded(source: SampleSource, from: number, to: number): Promise<Float32Array> {
    const have = Math.min(to, source.length);
    if (have >= to) return source.read(from, to);
    const out = new Float32Array(to - from);
    if (have > from) out.set(await source.read(from, have));
    return out;
}

/**
 * A recording handed out a block at a time: ask(from, to) asks for samples
 * from..to-1, receive({ from, data }) takes them when they come. The next block
 * is asked for while half of the last one is still to be read, and samples
 * released are dropped, so only a few blocks are held at any time (a worker
 * need not hold a copy of the whole file).
 */
export class BlockSource implements SampleSource {
    private base = 0;
    private data = new Float32Array(0);
    private keep = 0;
    private asked = 0;
    private waiting: (() => void) | null = null;

    constructor(readonly length: number, private readonly ask: (from: number, to: number) => void,
        private readonly block = 10 * SAMPLE_RATE) {}

    get end(): number { return this.base + this.data.length; }

    async read(from: number, to: number): Promise<Float32Array> {
        if (from < this.base) throw new Error(`samples from ${from} on were let go (${this.base})`);
        while (this.end < to) {
            this.askNext();
            await new Promise<void>(resolve => { this.waiting = resolve; });
        }
        if (this.asked - to < this.block / 2) this.askNext();
        return this.data.subarray(from - this.base, to - this.base);
    }

    release(before: number): void { this.keep = Math.max(this.keep, before); }

    private askNext(): void {
        if (this.asked >= this.length || this.asked > this.end) return;   // all asked for, or a block is on its way
        const from = this.asked, to = Math.min(this.length, from + this.block);
        this.asked = to;
        this.ask(from, to);
    }

    /** A block; the samples let go of are dropped. */
    receive({ from, data }: { from: number; data: Float32Array }): void {
        if (from !== this.end) throw new Error(`block at ${from}, expected ${this.end}`);
        const keep = Math.min(Math.max(this.keep, this.base), this.end);
        const joined = new Float32Array(this.end - keep + data.length);
        joined.set(this.data.subarray(keep - this.base));
        joined.set(data, this.end - keep);
        this.base = keep;
        this.data = joined;
        this.waiting?.();
        this.waiting = null;
    }
}

// ── Frames ────────────────────────────────────────────────────────────

/** Spectrogram frames from frame `base` on, band by band (n_mels, frames) as the graph wants them. */
export class Frames {
    cap = 0;
    db = new Float32Array(0);
    sound = new Uint8Array(0);
    base = 0;
    count = 0;
    rolling: RollingFloor | null = null;

    constructor(readonly bands = N_MELS) {}

    get end(): number { return this.base + this.count; }

    /** Forget the frames before `frame`. */
    drop(frame: number): void {
        const k = Math.min(Math.max(0, frame - this.base), this.count);
        if (!k) return;
        for (let b = 0; b < this.bands; b++) this.db.copyWithin(b * this.cap, b * this.cap + k, b * this.cap + this.count);
        this.sound.copyWithin(0, k, this.count);
        this.base += k;
        this.count -= k;
    }

    /** Append n frames of a (bands, n) block. */
    append(db: Float32Array, sound: ArrayLike<number> & { subarray?: unknown }, n: number): void {
        if (this.count + n > this.cap) {
            const cap = Math.max(2 * this.cap, this.count + n, 4096), grown = new Float32Array(this.bands * cap);
            for (let b = 0; b < this.bands; b++) grown.set(this.db.subarray(b * this.cap, b * this.cap + this.count), b * cap);
            const s = new Uint8Array(cap);
            s.set(this.sound.subarray(0, this.count));
            this.cap = cap; this.db = grown; this.sound = s;
        }
        for (let b = 0; b < this.bands; b++) this.db.set(db.subarray(b * n, (b + 1) * n), b * this.cap + this.count);
        for (let i = 0; i < n; i++) this.sound[this.count + i] = sound[i] ? 1 : 0;
        this.count += n;
    }

    /** Frames from..to-1, as new arrays. */
    slice(from: number, to: number): { db: Float32Array; sound: Uint8Array; n: number } {
        const n = to - from, o = from - this.base, db = new Float32Array(this.bands * n);
        if (o < 0 || o + n > this.count) throw new Error(`frames ${from} to ${to - 1} are not computed (${this.base} to ${this.end - 1})`);
        for (let b = 0; b < this.bands; b++) db.set(this.db.subarray(b * this.cap + o, b * this.cap + o + n), b * n);
        return { db, sound: this.sound.slice(o, o + n), n };
    }
}

/**
 * Each window's noise floor as the detect graph takes it (log_floor in
 * onnx_export.py): per band, the FLOOR_FRACTION percentile of the frames of its
 * floor window that hold sound (all of them if none does), interpolated in
 * float32 between two sorted values. The frames are kept sorted per band, and
 * from one window to the next only the frames that leave and arrive (128 of
 * about 5,100) are merged in. Bit for bit the graph's values (BirdBox
 * tests/js/demo_chunk_parity.mjs).
 */
export class RollingFloor {
    private lo = 0;
    private hi = 0;
    private count = 0;
    private cap = 0;
    private sorted: Float32Array | null = null;
    private spare: Float32Array | null = null;

    constructor(private readonly bands = N_MELS) {}

    /**
     * The floor of frames lo..hi-1 into out[b * windows + i] for every band b.
     * Windows come in order; the frames from the last call's lo on must still be in `frames`.
     */
    at(frames: Frames, lo: number, hi: number, out: Float32Array, i: number, windows: number): void {
        if (!this.sorted || lo < this.lo || lo > this.hi || hi < this.hi) this.fill(frames, lo, hi);
        else this.slide(frames, lo, hi);
        let count = this.count, cap = this.cap, sorted = this.sorted!;
        if (!count) {   // no frame with sound: all frames, as the graph does
            count = cap = hi - lo;
            sorted = new Float32Array(this.bands * count);
            for (let b = 0; b < this.bands; b++) {
                const row = sorted.subarray(b * count, (b + 1) * count);
                for (let f = lo; f < hi; f++) row[f - lo] = frames.db[b * frames.cap + f - frames.base];
                row.sort();
            }
        }
        const position = f32(f32(count - 1) * FLOOR_FRACTION), below = Math.floor(position);
        const fraction = f32(position - below), above = Math.min(below + 1, count - 1);
        for (let b = 0; b < this.bands; b++) {
            const low = sorted[b * cap + below], high = sorted[b * cap + above];
            out[b * windows + i] = f32(low + f32(f32(high - low) * fraction));
        }
    }

    private room(count: number): void {
        if (count <= this.cap) return;
        const cap = Math.max(count, Math.ceil(this.cap * 1.25)), grown = new Float32Array(this.bands * cap);
        for (let b = 0; this.sorted && b < this.bands; b++) grown.set(this.sorted.subarray(b * this.cap, b * this.cap + this.count), b * cap);
        this.cap = cap; this.sorted = grown; this.spare = new Float32Array(this.bands * cap);
    }

    /** Sort the frames with sound of lo..hi-1 anew. */
    private fill(frames: Frames, lo: number, hi: number): void {
        const { db, sound, base } = frames;
        let count = 0;
        for (let f = lo; f < hi; f++) if (sound[f - base]) count++;
        this.count = 0;
        this.room(Math.max(1, count));
        for (let b = 0; b < this.bands; b++) {
            const row = this.sorted!.subarray(b * this.cap, b * this.cap + count), from = b * frames.cap - base;
            let j = 0;
            for (let f = lo; f < hi; f++) if (sound[f - base]) row[j++] = db[from + f];
            row.sort();
        }
        this.lo = lo; this.hi = hi; this.count = count;
    }

    /** Move to lo..hi-1: take out the frames before lo, merge in those from the last hi on. */
    private slide(frames: Frames, lo: number, hi: number): void {
        const { db, sound, base } = frames, leave: number[] = [], arrive: number[] = [];
        for (let f = this.lo; f < lo; f++) if (sound[f - base]) leave.push(f);
        for (let f = this.hi; f < hi; f++) if (sound[f - base]) arrive.push(f);
        const old = this.count, count = old - leave.length + arrive.length;
        this.room(Math.max(old, count));
        const cap = this.cap, sorted = this.sorted!, spare = this.spare!;
        const gone = new Float32Array(leave.length), come = new Float32Array(arrive.length);
        for (let b = 0; b < this.bands; b++) {
            const from = b * frames.cap - base, row = b * cap;
            for (let j = 0; j < leave.length; j++) gone[j] = db[from + leave[j]];
            for (let j = 0; j < arrive.length; j++) come[j] = db[from + arrive[j]];
            gone.sort();
            come.sort();
            // One pass: the old values without those leaving (all among them), and the new ones in order
            let s = 0, g = 0, c = 0, d = row;
            while (s < old || c < come.length) {
                if (s < old && g < gone.length && sorted[row + s] === gone[g]) { s++; g++; continue; }
                if (c >= come.length || (s < old && sorted[row + s] <= come[c])) spare[d++] = sorted[row + s++];
                else spare[d++] = come[c++];
            }
        }
        this.lo = lo; this.hi = hi; this.count = count;
        this.sorted = spare; this.spare = sorted;
    }
}

// ── Window planning ───────────────────────────────────────────────────

export interface FrameGrid {
    /** Sample of frame 0 relative to the file start (negative: inside the left pad). */
    frameOrigin: number;
    /** Samples before a window's end its floor window starts. */
    floorWindowSamples: number;
}

/** First frame of window w's floor window. */
export const floorFirstFrame = (w: number, g: FrameGrid): number =>
    Math.max(0, Math.ceil((w * HOP_SAMPLES + CLIP_SAMPLES - g.floorWindowSamples - g.frameOrigin) / HOP_LENGTH));

/** Last frame window w needs. */
export const lastFrame = (w: number): number => w * WINDOW_FRAMES + CLIP_FRAMES - 1;

/**
 * Rows of one network run as the file's graph gives them: column 0 numbered per minute,
 * boxes past the file's content clipped (the graph padded only silence), column 8 the
 * file end. In a recording in progress (`samples` null) the file end is NO_END.
 */
export function finishRows(data: Float32Array, rows: number, samples: number | null): { data: Float32Array; rows: number } {
    for (let r = 0; r < rows; r++) data[r * 9] = Math.round(data[r * 9 + 7] / HOP_SECONDS) % SEGMENT_CLIPS;
    if (samples == null) {
        for (let r = 0; r < rows; r++) data[r * 9 + 8] = NO_END;
        return { data: data.slice(0, rows * 9), rows };
    }
    const content = f32(f32(samples) / SAMPLE_RATE), duration = f32(f32(paddedLength(samples)) / SAMPLE_RATE);
    const padded = duration > f32(content + f32(0.5 / SAMPLE_RATE));
    let kept = 0;
    for (let r = 0; r < rows; r++) {
        const o = r * 9, t0 = data[o + 1], t1 = padded ? Math.min(data[o + 2], content) : data[o + 2];
        if (padded && !(t0 < content && t1 > t0)) continue;
        if (kept !== r) data.copyWithin(kept * 9, o, o + 9);
        data[kept * 9 + 2] = t1;
        data[kept * 9 + 8] = duration;
        kept++;
    }
    return { data: data.slice(0, kept * 9), rows: kept };
}
