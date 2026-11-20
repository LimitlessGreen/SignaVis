// ═══════════════════════════════════════════════════════════════════════
// pcmCache.ts — decoded audio as a float WAV file in OPFS
//
// The spectrogram tile worker reads its source by slicing a WAV file. For formats it cannot
// slice (MP3, FLAC, …) the decoded samples used to be wrapped in an in-memory Blob — a second
// full copy of the audio (2 GB for 3 h at 48 kHz). Here they are written to an OPFS file in
// small pieces instead; the File from it is disk-backed. Same idea as Sonic Visualiser's
// CodedAudioFileReader "CacheInTemporaryFile" (float samples, so values are preserved).
// ═══════════════════════════════════════════════════════════════════════

import { pumpSamples } from '../../shared/pumpSamples.ts';

/** OPFS directory for the cache files. */
export const PCM_CACHE_DIR = 'signavis-pcm-cache';
/** Files of other pages/sessions older than this are removed. */
const STALE_MS = 24 * 60 * 60 * 1000;
/** Samples per write: createWritable 4 MB, worker 16 MB. */
const WRITE_SAMPLES = 1 << 20;
const WORKER_WRITE_SAMPLES = 1 << 22;

/** 44-byte header of a mono 32-bit float WAV with `samples` samples. */
export function floatWavHeader(samples: number, sampleRate: number): ArrayBuffer {
    const dataBytes = samples * 4;
    const h = new DataView(new ArrayBuffer(44));
    const tag = (at: number, s: string) => { for (let i = 0; i < 4; i++) h.setUint8(at + i, s.charCodeAt(i)); };
    tag(0, 'RIFF'); h.setUint32(4, 36 + dataBytes, true); tag(8, 'WAVE');
    tag(12, 'fmt '); h.setUint32(16, 16, true);
    h.setUint16(20, 3, true);                 // WAVE_FORMAT_IEEE_FLOAT
    h.setUint16(22, 1, true);                 // mono
    h.setUint32(24, sampleRate, true);
    h.setUint32(28, sampleRate * 4, true);    // byte rate
    h.setUint16(32, 4, true);                 // block align
    h.setUint16(34, 32, true);                // bits per sample
    tag(36, 'data'); h.setUint32(40, dataBytes, true);
    return h.buffer;
}

/** Files this page wrote; the previous one is removed when a new one is written. */
const ownFiles = new Set<string>();
let counter = 0;

/**
 * Write `channelData` as a mono float WAV into OPFS and return the (disk-backed) File.
 * Removes this page's earlier cache files and stale ones from other pages.
 * Throws if OPFS or writable files are unavailable; callers fall back to an in-memory Blob.
 */
export async function writePcmWavFile(
    channelData: Float32Array,
    sampleRate: number,
    root?: FileSystemDirectoryHandle,
    useWorker = !root && typeof Worker !== 'undefined', // the worker writes to the real OPFS root
): Promise<File> {
    const base = root ?? await navigator.storage.getDirectory();
    const dir = await base.getDirectoryHandle(PCM_CACHE_DIR, { create: true });
    await removeOldFiles(dir);
    const name = `pcm-${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}.wav`;
    const handle = await dir.getFileHandle(name, { create: true });
    ownFiles.add(name);
    try {
        if (!useWorker || !(await writeInWorker(channelData, sampleRate, name))) {
            await writeWithWritable(handle, channelData, sampleRate);
        }
        return await handle.getFile();
    } catch (err) {
        ownFiles.delete(name);
        await dir.removeEntry(name).catch(() => {});
        throw err;
    }
}

async function writeWithWritable(handle: FileSystemFileHandle, channelData: Float32Array, sampleRate: number): Promise<void> {
    const w = await (handle as any).createWritable();
    try {
        await w.write(floatWavHeader(channelData.length, sampleRate));
        for (let i = 0; i < channelData.length; i += WRITE_SAMPLES) {
            // slice(): a copy of one piece, since write() may keep the view until it resolves.
            await w.write(channelData.slice(i, Math.min(channelData.length, i + WRITE_SAMPLES)));
        }
        await w.close();
    } catch (err) {
        await w.abort?.().catch(() => {});
        throw err;
    }
}

/**
 * Write through a worker with a synchronous access handle. Pieces are copied and transferred,
 * at most two in flight. Returns false if the worker or sync handles are unavailable (caller
 * then uses createWritable); throws on a write error.
 */
async function writeInWorker(channelData: Float32Array, sampleRate: number, name: string): Promise<boolean> {
    let worker: Worker;
    try {
        const Ctor = (await import('./pcmCache.worker.ts?worker&inline')).default;
        worker = new Ctor();
    } catch {
        return false;
    }
    const replies: Array<{ resolve: (v: any) => void; reject: (e: Error) => void }> = [];
    worker.onmessage = (e: MessageEvent) => {
        const r = replies.shift();
        if (e.data.type === 'ok') r?.resolve(e.data); else r?.reject(new Error(e.data.message));
    };
    worker.onerror = (e) => { while (replies.length) replies.shift()!.reject(new Error(e.message || 'worker error')); };
    const send = (msg: any, transfer: Transferable[] = []) => new Promise<any>((resolve, reject) => {
        replies.push({ resolve, reject });
        worker.postMessage(msg, transfer);
    });
    try {
        try {
            await send({ type: 'open', dir: PCM_CACHE_DIR, name });
        } catch {
            return false; // no createSyncAccessHandle (e.g. older Safari): use createWritable
        }
        const header = floatWavHeader(channelData.length, sampleRate);
        await send({ type: 'write', data: header }, [header]);
        // Pooled pieces: the worker hands each buffer back after writing it.
        await pumpSamples(channelData, WORKER_WRITE_SAMPLES, async (piece) =>
            (await send({ type: 'write', data: piece.buffer, length: piece.byteLength }, [piece.buffer])).data);
        await send({ type: 'close' });
        return true;
    } finally {
        worker.terminate();
    }
}

async function removeOldFiles(dir: FileSystemDirectoryHandle): Promise<void> {
    const now = Date.now();
    for await (const [name, h] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
        if (h.kind !== 'file') continue;
        let stale = ownFiles.has(name);
        if (!stale) {
            try { stale = now - (await (h as FileSystemFileHandle).getFile()).lastModified > STALE_MS; } catch { /* in use elsewhere */ }
        }
        if (!stale) continue;
        try {
            await dir.removeEntry(name);
            ownFiles.delete(name);
        } catch { /* still open (e.g. a worker reading it); retried next time */ }
    }
}
