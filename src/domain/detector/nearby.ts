// nearby.ts — BirdBox rows of the seconds around a snap click (Snap without a run)
//
// A run from window `from` to `to` starts at its first window's floor window, so its
// rows equal the whole run's (scripts/birdbox/stream-parity.mjs, check 2c).

import { CLIP_SECONDS, HOP_SECONDS } from './birdboxStream.ts';
import type { BoxUnderCache } from './boxUnder.ts';

/** Seconds around a snap click that a stretch covers: a call and its phrase. */
export const NEAR_SECONDS = 6;

export interface NearRows { data: Float32Array; rows: number; next: number; analyzedTo: number; done: boolean }
interface Stretch { t0: number; t1: number; raw: NearRows; cache: BoxUnderCache }

export interface NearbyOptions<B> {
    /** 32 kHz mono of a recording's audio (done once per recording and buffer). */
    prepare: (buf: B) => Promise<Float32Array>;
    /** Rows of windows from … to-1. */
    detect: (pcm: Float32Array, from: number, to: number) => Promise<NearRows>;
}

/** Windows that cover `time` ± NEAR_SECONDS (window w: w·1.5 s … w·1.5 s + 3 s). */
export function nearWindows(time: number): { from: number; to: number } {
    return {
        from: Math.max(0, Math.floor((time - NEAR_SECONDS - CLIP_SECONDS) / HOP_SECONDS)),
        to: Math.ceil((time + NEAR_SECONDS) / HOP_SECONDS) + 1,
    };
}

/** Whether a run's rows hold the seconds around `time`: a stopped run's only up to analyzedTo. */
export function runCovers(raw: { analyzedTo: number }, stopped: boolean, time: number): boolean {
    return !stopped || time + NEAR_SECONDS <= raw.analyzedTo;
}

export class NearbyRows<B> {
    private readonly stretches = new Map<string, Stretch[]>();
    private pending: Promise<boolean> | null = null;
    /** Bumped by forget/forgetAll: a detection started before keeps nothing. */
    private epoch = 0;
    private pcm: { id: string; buf: B; pcm: Float32Array } | null = null;

    private readonly o: NearbyOptions<B>;

    constructor(o: NearbyOptions<B>) { this.o = o; }

    /** The stretch of a recording that holds `time`. */
    at(id: string, time: number): Stretch | null {
        return this.stretches.get(id)?.find(n => time >= n.t0 && time <= n.t1) ?? null;
    }

    /** Detect the stretch around `time`; one at a time (a second call gets the running one). False if nothing was kept. */
    detect(id: string, buf: B, time: number): Promise<boolean> {
        if (this.pending) return this.pending;
        const epoch = this.epoch;
        const run = async (): Promise<boolean> => {
            if (this.pcm?.id !== id || this.pcm.buf !== buf) {
                const pcm = await this.o.prepare(buf);
                if (epoch !== this.epoch) return false;
                this.pcm = { id, buf, pcm };
            }
            const { from, to } = nearWindows(time);
            const raw = await this.o.detect(this.pcm.pcm, from, to);
            if (epoch !== this.epoch) return false;   // forgotten meanwhile
            const list = this.stretches.get(id) ?? [];
            list.push({ t0: time - NEAR_SECONDS / 2, t1: time + NEAR_SECONDS / 2, raw: { ...raw, done: true }, cache: new Map() });
            this.stretches.set(id, list.slice(-20));
            return true;
        };
        this.pending = run().finally(() => { this.pending = null; });
        return this.pending;
    }

    forget(id: string): void {
        this.stretches.delete(id);
        this.epoch++;
        if (this.pcm?.id === id) this.pcm = null;
    }

    forgetAll(): void {
        this.stretches.clear();
        this.epoch++;
        this.pcm = null;
    }
}
