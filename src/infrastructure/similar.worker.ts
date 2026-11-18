// similar.worker.ts — one search session off the main thread (app/similarSpectrogram.ts SimilarSession).
//   { type: 'find', spec, exemplar, opts } → { id, hits }      spec.values transferred, kept for re-ranking
//   { type: 'findAudio', module, channels, length, sampleRate, loHz, hiHz, exemplar, opts } → { id, hits | null }
//                                                              spectrogram computed here as well (bandSpectrogramOf)
//   { type: 'decide', i, accepted, moved? } → { id, ranks }     Reranker (domain/similar/ncc.ts)
// Errors come back as { id, error }.
import { createSearch, type SearchState } from '../domain/similar/ncc.ts';
import { bandSpectrogramOf } from '../app/similarBand.ts';
import { initSync, WasmStft } from './wasm-dsp/pkg/aw_dsp_wasm.js';

let wasmReady = false;

let search: SearchState | null = null;

self.onmessage = async (e: MessageEvent) => {
    const { id, type } = e.data;
    try {
        if (type === 'find') {
            search = createSearch(e.data.spec, e.data.exemplar, e.data.opts);
            (self as any).postMessage({ id, hits: search.hits });
        } else if (type === 'findAudio') {
            const d = e.data;
            if (!wasmReady) { initSync({ module: d.module }); wasmReady = true; }
            const spec = await bandSpectrogramOf({ WasmStft }, d.channels, d.length, d.sampleRate, d.loHz, d.hiHz);
            search = spec ? createSearch(spec, d.exemplar, d.opts) : null;
            (self as any).postMessage({ id, hits: search ? search.hits : null });
        } else if (type === 'decide') {
            if (!search) throw new Error('no search');
            const ranks = search.reranker.decide(e.data.i, e.data.accepted, e.data.moved);
            (self as any).postMessage({ id, ranks }, [ranks.buffer]);
        }
    } catch (err: any) {
        (self as any).postMessage({ id, error: String(err?.message || err) });
    }
};
