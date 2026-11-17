// boxUnder.ts — the detector's box under a point ("Snap to call" on BirdBox rows)

import { fuseBoxes, type FusedBox, type FusionCache } from './fusion.ts';

/** Fusion caches per confidence; fuseBoxes checks that the rows still match. */
export type BoxUnderCache = Map<number, FusionCache>;

/**
 * The most confident fused box containing (time, freq) at confidence `conf`.
 * `weaker`: none at `conf`, but one at `minConf` (the lowest confidence the rows hold).
 */
export function boxUnder(raw: Float32Array, rows: number, time: number, freq: number,
    { conf, gap, minConf, later = Infinity, cache = new Map() }: { conf: number; gap: number; minConf: number; later?: number; cache?: BoxUnderCache },
): { box: FusedBox | null; weaker: boolean } {
    const under = (c: number): FusedBox | null => {
        const fc = cache.get(c) ?? {};
        cache.set(c, fc);
        if (cache.size > 24) cache.delete(cache.keys().next().value as number);
        return fuseBoxes(raw, rows, c, gap, fc, later)
            .filter((b) => time >= b.t0 && time <= b.t1 && freq >= b.flo && freq <= b.fhi)
            .sort((a, b) => b.max - a.max)[0] ?? null;
    };
    const box = under(conf);
    return box ? { box, weaker: false } : { box: null, weaker: conf > minConf && !!under(minConf) };
}
