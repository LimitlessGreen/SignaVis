/**
 * Chunked FLAC decoding for recordings too long for a single decodeAudioData call.
 *
 * FLAC frames decode independently, so the file is cut at frame boundaries into blocks of a few
 * minutes. Each block gets a minimal header ("fLaC" + the original STREAMINFO with the total
 * sample count and MD5 cleared) and is decoded on its own; the result is mixed down to mono and
 * appended to one preallocated buffer. No overlap and no trimming are needed.
 *
 * Frame boundaries are found near the target byte offsets by scanning for the frame sync code and
 * checking the frame header's CRC-8, so no full frame index has to be built.
 */

/** Length of one decoded block. */
const BLOCK_SEC = 300;

export interface FlacStreamInfo {
  sampleRate: number;
  channels: number;
  /** Total samples per channel, 0 when the encoder did not know it. */
  totalSamples: number;
  /** Byte offset of the STREAMINFO body (34 bytes). */
  streamInfoOffset: number;
  /** Byte offset of the first audio frame. */
  firstFrame: number;
}

export function isFlac(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 4) return false;
  const b = new Uint8Array(buf, 0, 4);
  return b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43; // "fLaC"
}

/** Skip an ID3v2 tag some taggers put before "fLaC". */
function flacStart(b: Uint8Array): number {
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33 && b.length >= 10) {
    return 10 + (((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f));
  }
  return 0;
}

export function parseFlacStreamInfo(buf: ArrayBuffer): FlacStreamInfo | null {
  const b = new Uint8Array(buf);
  const s = flacStart(b);
  if (!(b[s] === 0x66 && b[s + 1] === 0x4c && b[s + 2] === 0x61 && b[s + 3] === 0x43)) return null;
  let pos = s + 4;
  let info: FlacStreamInfo | null = null;
  for (;;) {
    if (pos + 4 > b.length) return null;
    const last = (b[pos] & 0x80) !== 0;
    const type = b[pos] & 0x7f;
    const len = (b[pos + 1] << 16) | (b[pos + 2] << 8) | b[pos + 3];
    const body = pos + 4;
    if (type === 0 && len >= 34 && body + 34 <= b.length) {
      const sampleRate = (b[body + 10] << 12) | (b[body + 11] << 4) | (b[body + 12] >> 4);
      const channels = ((b[body + 12] >> 1) & 7) + 1;
      const totalSamples = (b[body + 13] & 0x0f) * 2 ** 32
        + ((b[body + 14] << 24) >>> 0) + (b[body + 15] << 16) + (b[body + 16] << 8) + b[body + 17];
      info = { sampleRate, channels, totalSamples, streamInfoOffset: body, firstFrame: 0 };
    }
    pos = body + len;
    if (last) break;
  }
  if (!info || !info.sampleRate) return null;
  info.firstFrame = pos;
  return info;
}

/** CRC-8, polynomial x^8 + x^2 + x + 1 (FLAC frame header). */
const CRC8 = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    t[i] = c;
  }
  return t;
})();

/** True when a valid FLAC frame header (checked by its CRC-8) starts at i. */
export function isFrameHeader(b: Uint8Array, i: number): boolean {
  if (i + 6 > b.length || b[i] !== 0xff || (b[i + 1] & 0xfe) !== 0xf8) return false;
  const bsCode = b[i + 2] >> 4, srCode = b[i + 2] & 0x0f;
  const chan = b[i + 3] >> 4, ssCode = (b[i + 3] >> 1) & 7;
  if (bsCode === 0 || srCode === 15 || chan > 10 || ssCode === 3 || (b[i + 3] & 1)) return false;
  // Frame/sample number, UTF-8 style: 1–7 bytes.
  let p = i + 4;
  const lead = b[p];
  let extra = 0;
  if (lead < 0x80) extra = 0;
  else if ((lead & 0xe0) === 0xc0) extra = 1;
  else if ((lead & 0xf0) === 0xe0) extra = 2;
  else if ((lead & 0xf8) === 0xf0) extra = 3;
  else if ((lead & 0xfc) === 0xf8) extra = 4;
  else if ((lead & 0xfe) === 0xfc) extra = 5;
  else if (lead === 0xfe) extra = 6;
  else return false;
  p += 1 + extra;
  if (bsCode === 6) p += 1; else if (bsCode === 7) p += 2;
  if (srCode === 12) p += 1; else if (srCode === 13 || srCode === 14) p += 2;
  if (p >= b.length) return false;
  let crc = 0;
  for (let k = i; k < p; k++) crc = CRC8[crc ^ b[k]];
  return crc === b[p];
}

/**
 * First sample of the frame whose header starts at b[0]: the coded number is a frame number
 * (fixed block size, times `blockSize`) or a sample number (variable block size). null if unreadable.
 */
export function frameFirstSample(b: Uint8Array, blockSize: number): number | null {
  if (b.length < 5 || b[0] !== 0xff || (b[1] & 0xfe) !== 0xf8) return null;
  const variable = (b[1] & 1) === 1;
  const lead = b[4];
  let extra: number, v: number;
  if (lead < 0x80) { extra = 0; v = lead; }
  else if ((lead & 0xe0) === 0xc0) { extra = 1; v = lead & 0x1f; }
  else if ((lead & 0xf0) === 0xe0) { extra = 2; v = lead & 0x0f; }
  else if ((lead & 0xf8) === 0xf0) { extra = 3; v = lead & 0x07; }
  else if ((lead & 0xfc) === 0xf8) { extra = 4; v = lead & 0x03; }
  else if ((lead & 0xfe) === 0xfc) { extra = 5; v = lead & 0x01; }
  else if (lead === 0xfe) { extra = 6; v = 0; }
  else return null;
  if (5 + extra > b.length) return null;
  for (let k = 0; k < extra; k++) {
    const c = b[5 + k];
    if ((c & 0xc0) !== 0x80) return null;
    v = v * 64 + (c & 0x3f);
  }
  return variable ? v : v * blockSize;
}

/** First frame header at or after `from`, or b.length if there is none. */
export function nextFrame(b: Uint8Array, from: number): number {
  for (let i = from; i + 6 <= b.length; i++) {
    if (b[i] === 0xff && isFrameHeader(b, i)) return i;
  }
  return b.length;
}

/** Byte offsets of block starts: the first frame, then the next frame after every blockBytes. */
export function flacBlockStarts(b: Uint8Array, firstFrame: number, blockBytes: number): number[] {
  const starts = [firstFrame];
  for (let target = firstFrame + blockBytes; target < b.length; target += blockBytes) {
    const at = nextFrame(b, Math.max(target, starts[starts.length - 1] + 1));
    if (at >= b.length) break;
    starts.push(at);
    target = at;
  }
  return starts;
}

/** "fLaC" + STREAMINFO (marked last, total samples and MD5 cleared) + the given frames. */
function blockFile(streamInfo: Uint8Array, frames: Uint8Array): ArrayBuffer {
  const head = 4 + 4 + 34;
  const out = new Uint8Array(head + frames.length);
  out.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34], 0);
  out.set(streamInfo.subarray(0, 34), 8);
  out[8 + 13] &= 0xf0;                 // total samples: upper 4 bits ...
  out.fill(0, 8 + 14, 8 + 34);         // ... lower 32 bits and MD5
  out.set(frames, head);
  return out.buffer;
}

/** Random access to the file's bytes: an ArrayBuffer in memory or a Blob read slice by slice. */
export interface ByteSource {
  size: number;
  read(from: number, to: number): Promise<Uint8Array>;
}

export function bufferSource(buf: ArrayBuffer): ByteSource {
  const b = new Uint8Array(buf);
  return { size: b.length, read: async (from, to) => b.subarray(from, to) };
}

export function blobSource(blob: Blob): ByteSource {
  return { size: blob.size, read: async (from, to) => new Uint8Array(await blob.slice(from, to).arrayBuffer()) };
}

/** Bytes read per step when looking for a frame header near a block boundary. */
const SCAN_BYTES = 1 << 16;
/** Longest frame header (sync … CRC-8): a window must overlap the next one by this much. */
const MAX_HEADER = 16;

/** First frame header at or after `from` in the source, or src.size if there is none. */
export async function nextFrameIn(src: ByteSource, from: number, scanBytes = SCAN_BYTES): Promise<number> {
  for (let at = from; at < src.size;) {
    const end = Math.min(src.size, at + Math.max(scanBytes, 2 * MAX_HEADER));
    const w = await src.read(at, end);
    const i = nextFrame(w, 0);
    if (i < w.length) return at + i;
    if (end >= src.size) break;
    at = end - MAX_HEADER; // a header cut off at the window's end is checked again
  }
  return src.size;
}

/** STREAMINFO and the first frame offset, reading only the metadata block headers. */
export async function readFlacHead(src: ByteSource): Promise<{ info: FlacStreamInfo; streamInfo: Uint8Array } | null> {
  const lead = await src.read(0, Math.min(src.size, 10));
  const s = flacStart(lead);
  const magic = await src.read(s, s + 4);
  if (!(magic[0] === 0x66 && magic[1] === 0x4c && magic[2] === 0x61 && magic[3] === 0x43)) return null;
  let pos = s + 4;
  let streamInfo: Uint8Array | null = null;
  let info: FlacStreamInfo | null = null;
  for (;;) {
    if (pos + 4 > src.size) return null;
    const h = await src.read(pos, pos + 4);
    const last = (h[0] & 0x80) !== 0;
    const type = h[0] & 0x7f;
    const len = (h[1] << 16) | (h[2] << 8) | h[3];
    const body = pos + 4;
    if (type === 0 && len >= 34 && body + 34 <= src.size) {
      streamInfo = await src.read(body, body + 34);
      const b = streamInfo;
      const sampleRate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
      const channels = ((b[12] >> 1) & 7) + 1;
      const totalSamples = (b[13] & 0x0f) * 2 ** 32 + ((b[14] << 24) >>> 0) + (b[15] << 16) + (b[16] << 8) + b[17];
      info = { sampleRate, channels, totalSamples, streamInfoOffset: body, firstFrame: 0 };
    }
    pos = body + len;
    if (last) break;
  }
  if (!info || !info.sampleRate || !streamInfo) return null;
  info.firstFrame = pos;
  return { info, streamInfo };
}

function mixDown(decoded: AudioBuffer, dst: Float32Array, at: number, n: number): void {
  const ch = decoded.numberOfChannels;
  if (ch === 1) { dst.set(decoded.getChannelData(0).subarray(0, n), at); return; }
  const chans = Array.from({ length: ch }, (_, c) => decoded.getChannelData(c));
  const inv = 1 / ch;
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let c = 0; c < ch; c++) acc += chans[c][i];
    dst[at + i] = acc * inv;
  }
}

/**
 * Decode a FLAC block by block into one mono AudioBuffer at the file's native sample rate.
 * `ctx` must run at that sample rate (decodeAudioData resamples to the context rate).
 * A Blob is read slice by slice, so the compressed file is never in memory as a whole.
 */
export async function decodeFlacChunked(input: ArrayBuffer | Blob, ctx: BaseAudioContext, onProgress?: (fraction: number) => void, blockSec = BLOCK_SEC): Promise<AudioBuffer> {
  const src = input instanceof ArrayBuffer ? bufferSource(input) : blobSource(input);
  const head = await readFlacHead(src);
  if (!head) throw new Error('Not a FLAC file.');
  const { info, streamInfo } = head;
  const audioBytes = src.size - info.firstFrame;
  // Byte rate estimate: from the total sample count, else ~2 bytes per sample and channel.
  const bytesPerSec = info.totalSamples > 0
    ? audioBytes / (info.totalSamples / info.sampleRate)
    : info.sampleRate * info.channels * 2;
  const blockBytes = Math.max(1 << 16, Math.round(bytesPerSec * blockSec));

  // Decode all blocks first only when the length is unknown; otherwise fill one buffer directly.
  const known = info.totalSamples > 0;
  let out: AudioBuffer | null = null;
  let dst: Float32Array | null = null;
  if (known) {
    try {
      out = ctx.createBuffer(1, info.totalSamples, info.sampleRate);
    } catch (e: any) {
      const gb = (info.totalSamples * 4 / 1e9).toFixed(1);
      throw new Error(`Recording too long to load: ${Math.round(info.totalSamples / info.sampleRate / 60)} min needs ${gb} GB of memory (${e?.message || e}).`);
    }
    dst = out.getChannelData(0);
  }
  const parts: Float32Array[] = [];
  let written = 0;
  // Blocks end at the next frame after every blockBytes (see flacBlockStarts). A part that
  // compresses far better than the average (digital silence) would make that block hours long:
  // its end moves back, halving the bytes, until it holds at most 2 × blockSec of audio.
  const fixedBlock = (streamInfo[0] << 8) | streamInfo[1];
  const maxSamples = 2 * blockSec * info.sampleRate;
  const sampleAt = async (pos: number): Promise<number | null> => pos >= src.size
    ? (known ? info.totalSamples : null)
    : frameFirstSample(await src.read(pos, Math.min(src.size, pos + MAX_HEADER)), fixedBlock);
  let fromSample: number | null = 0;
  for (let from = info.firstFrame; from < src.size;) {
    let to = from + blockBytes < src.size ? await nextFrameIn(src, from + blockBytes) : src.size;
    let toSample = await sampleAt(to);
    while (fromSample != null && toSample != null && toSample - fromSample > maxSamples) {
      const shorter = await nextFrameIn(src, from + 1 + ((to - from) >> 1));
      if (shorter >= to) break; // a single frame
      to = shorter;
      toSample = await sampleAt(to);
    }
    fromSample = toSample;
    const decoded = await ctx.decodeAudioData(blockFile(streamInfo, await src.read(from, to)));
    if (dst) {
      const n = Math.min(decoded.length, dst.length - written);
      mixDown(decoded, dst, written, n);
      written += n;
    } else {
      const part = new Float32Array(decoded.length);
      mixDown(decoded, part, 0, decoded.length);
      parts.push(part);
      written += decoded.length;
    }
    onProgress?.(to / src.size);
    from = to;
  }
  if (!out) {
    out = ctx.createBuffer(1, Math.max(1, written), info.sampleRate);
    const d = out.getChannelData(0);
    let at = 0;
    for (const p of parts) { d.set(p, at); at += p.length; }
  }
  return out;
}
