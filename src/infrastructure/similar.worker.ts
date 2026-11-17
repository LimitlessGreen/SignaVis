// similar.worker.ts — runs findSimilar (domain/similar/ncc.ts) off the main thread.
// In: { spec, exemplar, opts } (spec.values transferred). Out: { hits } or { error }.
import { findSimilar } from '../domain/similar/ncc.ts';

self.onmessage = (e: MessageEvent) => {
    try {
        const { spec, exemplar, opts } = e.data;
        (self as any).postMessage({ hits: findSimilar(spec, exemplar, opts) });
    } catch (err: any) {
        (self as any).postMessage({ error: String(err?.message || err) });
    }
};
