// Builds the fine level of the waveform min/max pyramid from pieces the main thread sends
// (see channelPeaksAsync). Messages, each answered once:
//   { type: 'start', length }                 → { type: 'ok' }
//   { type: 'piece', data, length, offset }   → { type: 'ok', data }   (buffer handed back)
//   { type: 'finish' }                        → { type: 'ok', min, max, sq }
import { reduceFineInto, PEAK_BLOCK_FINE } from '../domain/waveformEnvelope.ts';

type Ctx = { postMessage(msg: any, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null };
const ctx = self as unknown as Ctx;
let min: Float32Array | null = null, max: Float32Array | null = null, sq: Float32Array | null = null;

ctx.onmessage = (e: MessageEvent) => {
    const msg = e.data;
    try {
        if (msg.type === 'start') {
            const n = Math.ceil(msg.length / PEAK_BLOCK_FINE);
            min = new Float32Array(n); max = new Float32Array(n); sq = new Float32Array(n);
            ctx.postMessage({ type: 'ok' });
        } else if (msg.type === 'piece') {
            reduceFineInto(new Float32Array(msg.data, 0, msg.length), min!, max!, sq!, msg.offset / PEAK_BLOCK_FINE);
            ctx.postMessage({ type: 'ok', data: msg.data }, [msg.data]);
        } else if (msg.type === 'finish') {
            ctx.postMessage({ type: 'ok', min, max, sq }, [min!.buffer, max!.buffer, sq!.buffer]);
            min = max = sq = null;
        }
    } catch (err: any) {
        ctx.postMessage({ type: 'error', message: err?.message || String(err) });
    }
};
