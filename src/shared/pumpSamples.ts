/**
 * Hand a long Float32Array to a worker in pieces without transferring (and losing) it: each
 * piece is copied into a pooled buffer and transferred; the worker sends the buffer back when it
 * is done, and it is reused. At most `poolSize` pieces are in flight, so memory stays at
 * poolSize × pieceSamples × 4 bytes and the main thread only does memcpy.
 *
 * `send(piece, offset)` posts the piece (transferring piece.buffer) and resolves when the worker
 * has finished with it, with the buffer it returned (or nothing; then a new one is allocated).
 */
export async function pumpSamples(
    data: Float32Array,
    pieceSamples: number,
    send: (piece: Float32Array, offset: number) => Promise<ArrayBuffer | void>,
    poolSize = 2,
): Promise<void> {
    const pool: ArrayBuffer[] = [];
    const inFlight: Promise<void>[] = [];
    const bytes = pieceSamples * 4;
    for (let i = 0; i < data.length; i += pieceSamples) {
        const n = Math.min(pieceSamples, data.length - i);
        const buf = pool.pop() ?? new ArrayBuffer(bytes);
        const piece = new Float32Array(buf, 0, n);
        piece.set(data.subarray(i, i + n));
        inFlight.push(send(piece, i).then((back) => {
            if (back && back.byteLength === bytes) pool.push(back);
        }));
        if (inFlight.length >= poolSize) await inFlight.shift();
    }
    await Promise.all(inFlight);
}
