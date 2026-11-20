// Writes one OPFS file with a synchronous access handle (in place, ~2× faster than
// createWritable, which writes a swap file). Messages:
//   { type: 'open', dir, name }  → { type: 'ok' }
//   { type: 'write', data }      → { type: 'ok' }   (data: transferred ArrayBuffer, appended)
//   { type: 'close' }            → { type: 'ok' }
// Any failure answers { type: 'error', message } and closes the handle.
type Ctx = { postMessage(msg: any): void; onmessage: ((e: MessageEvent) => void) | null };
const ctx = self as unknown as Ctx;

let handle: any = null;
let at = 0;

ctx.onmessage = async (e: MessageEvent) => {
    const msg = e.data;
    try {
        if (msg.type === 'open') {
            const root = await navigator.storage.getDirectory();
            const dir = await root.getDirectoryHandle(msg.dir, { create: true });
            const file: any = await dir.getFileHandle(msg.name, { create: true });
            handle = await file.createSyncAccessHandle();
            handle.truncate(0);
            at = 0;
        } else if (msg.type === 'write') {
            const n = handle.write(new Uint8Array(msg.data), { at });
            if (n !== msg.data.byteLength) throw new Error(`short write (${n} of ${msg.data.byteLength} bytes)`);
            at += n;
        } else if (msg.type === 'close') {
            handle.flush();
            handle.close();
            handle = null;
        }
        ctx.postMessage({ type: 'ok' });
    } catch (err: any) {
        try { handle?.close(); } catch { /* already closed */ }
        handle = null;
        ctx.postMessage({ type: 'error', message: err?.message || String(err) });
    }
};
export {};
