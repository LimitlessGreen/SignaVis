// similar.worker.ts — one search session off the main thread (app/similarSpectrogram.ts SimilarSession).
//   { type: 'find', spec, exemplar, opts } → { id, hits }      spec.values transferred, kept for re-ranking
//   { type: 'decide', i, accepted }        → { id, ranks }     Reranker (domain/similar/ncc.ts)
// Errors come back as { id, error }.
import { createSearch, type SearchState } from '../domain/similar/ncc.ts';

let search: SearchState | null = null;

self.onmessage = (e: MessageEvent) => {
    const { id, type } = e.data;
    try {
        if (type === 'find') {
            search = createSearch(e.data.spec, e.data.exemplar, e.data.opts);
            (self as any).postMessage({ id, hits: search.hits });
        } else if (type === 'decide') {
            if (!search) throw new Error('no search');
            const ranks = search.reranker.decide(e.data.i, e.data.accepted);
            (self as any).postMessage({ id, ranks }, [ranks.buffer]);
        }
    } catch (err: any) {
        (self as any).postMessage({ id, error: String(err?.message || err) });
    }
};
