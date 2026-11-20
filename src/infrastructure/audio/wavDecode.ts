/**
 * WAV reading without decodeAudioData, for recordings too long for a single decode call.
 *
 * Chrome's decodeAudioData builds one AudioBuffer per channel at the context rate and rejects
 * long WAVs (already ~12 min at 48 kHz in some builds) with "Unable to decode audio data".
 * PCM needs no decoder: the header is parsed here and the samples are converted block by block
 * to mono Float32, straight into one preallocated buffer. Between blocks the loop yields so the
 * main thread stays responsive.
 *
 * Supports RIFF, RF64/BW64 (ds64 sizes), PCM 8/16/24/32 bit, IEEE float 32/64 bit and
 * WAVE_FORMAT_EXTENSIBLE with either subformat. A data chunk that claims more bytes than the
 * file holds (recorder stopped before rewriting the header) is read up to the end of the file.
 */

export interface WavInfo {
  /** 'pcm' = integer samples, 'float' = IEEE float. */
  format: 'pcm' | 'float';
  channels: number;
  sampleRate: number;
  /** Bytes per sample in the file (container size; valid bits may be fewer, left-aligned). */
  bytesPerSample: number;
  /** Bytes per frame (all channels). */
  blockAlign: number;
  /** Byte offset of the first sample. */
  dataOffset: number;
  /** Number of complete frames available in the file. */
  frames: number;
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

function fourcc(v: DataView, at: number): string {
  return String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));
}

/** True for RIFF/RF64/BW64 files of type WAVE. */
export function isWav(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 12) return false;
  const v = new DataView(buf);
  const id = fourcc(v, 0);
  return (id === 'RIFF' || id === 'RF64' || id === 'BW64') && fourcc(v, 8) === 'WAVE';
}

/** Parse the header. Returns null for WAVs this reader cannot convert (compressed formats, RIFX). */
export function parseWav(buf: ArrayBuffer): WavInfo | null {
  if (!isWav(buf)) return null;
  const v = new DataView(buf);
  const size = buf.byteLength;
  let ds64Data = -1;
  let fmt: { tag: number; channels: number; sampleRate: number; blockAlign: number; bits: number } | null = null;
  let pos = 12;
  while (pos + 8 <= size) {
    const id = fourcc(v, pos);
    let len = v.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'ds64' && body + 16 <= size) {
      // ds64: riffSize(8), dataSize(8), sampleCount(8). Sizes above 2^53 do not occur in practice.
      ds64Data = v.getUint32(body + 8, true) + v.getUint32(body + 12, true) * 2 ** 32;
    } else if (id === 'fmt ' && body + 16 <= size) {
      let tag = v.getUint16(body, true);
      if (tag === WAVE_FORMAT_EXTENSIBLE && len >= 40 && body + 26 <= size) tag = v.getUint16(body + 24, true);
      fmt = {
        tag,
        channels: v.getUint16(body + 2, true),
        sampleRate: v.getUint32(body + 4, true),
        blockAlign: v.getUint16(body + 12, true),
        bits: v.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (!fmt || fmt.channels < 1 || fmt.sampleRate < 1 || fmt.blockAlign < 1) return null;
      if (len === 0xffffffff && ds64Data >= 0) len = ds64Data;
      // 0 / 0xFFFFFFFF / too large: header not finalized, read to the end of the file.
      const avail = size - body;
      const bytes = len === 0 || len > avail ? avail : len;
      const bytesPerSample = fmt.blockAlign / fmt.channels;
      const pcm = fmt.tag === WAVE_FORMAT_PCM && [1, 2, 3, 4].includes(bytesPerSample);
      const float = fmt.tag === WAVE_FORMAT_IEEE_FLOAT && (bytesPerSample === 4 || bytesPerSample === 8);
      if (!pcm && !float) return null;
      return {
        format: pcm ? 'pcm' : 'float',
        channels: fmt.channels,
        sampleRate: fmt.sampleRate,
        bytesPerSample,
        blockAlign: fmt.blockAlign,
        dataOffset: body,
        frames: Math.floor(bytes / fmt.blockAlign),
      };
    }
    // Chunks are padded to an even length.
    pos = body + len + (len & 1);
  }
  return null;
}

/** Convert n frames starting at byte `start` of buf to mono Float32 into dst[from ...]. */
function convertBlock(buf: ArrayBuffer, info: WavInfo, start: number, n: number, from: number, dst: Float32Array): void {
  const { channels: ch, bytesPerSample: bps, blockAlign, format } = info;
  const inv = 1 / ch;
  // Fast paths: aligned typed-array views (all browsers are little-endian).
  if (format === 'pcm' && bps === 2 && start % 2 === 0) {
    const s = new Int16Array(buf, start, n * ch);
    if (ch === 1) for (let i = 0; i < n; i++) dst[from + i] = s[i] / 32768;
    else for (let i = 0, j = 0; i < n; i++) { let acc = 0; for (let c = 0; c < ch; c++) acc += s[j++]; dst[from + i] = acc * inv / 32768; }
    return;
  }
  if (format === 'float' && bps === 4 && start % 4 === 0) {
    const s = new Float32Array(buf, start, n * ch);
    if (ch === 1) dst.set(s, from);
    else for (let i = 0, j = 0; i < n; i++) { let acc = 0; for (let c = 0; c < ch; c++) acc += s[j++]; dst[from + i] = acc * inv; }
    return;
  }
  const v = new DataView(buf, start, n * blockAlign);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let c = 0; c < ch; c++) {
      const at = i * blockAlign + c * bps;
      if (format === 'float') acc += bps === 4 ? v.getFloat32(at, true) : v.getFloat64(at, true);
      else if (bps === 1) acc += (v.getUint8(at) - 128) / 128;
      else if (bps === 2) acc += v.getInt16(at, true) / 32768;
      else if (bps === 3) acc += ((v.getUint8(at) | (v.getUint8(at + 1) << 8) | (v.getInt8(at + 2) << 16))) / 8388608;
      else acc += v.getInt32(at, true) / 2147483648;
    }
    dst[from + i] = acc * inv;
  }
}

/** Frames converted per step; ~20 s at 48 kHz, a few ms of work. */
const BLOCK_FRAMES = 1 << 20;

const yieldToEventLoop = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Read a WAV into one mono buffer at the file's sample rate.
 * `ctx` only allocates the buffer (no resampling happens).
 */
export async function decodeWavMono<B extends { getChannelData(ch: number): Float32Array }>(
  buf: ArrayBuffer,
  ctx: { createBuffer(channels: number, length: number, sampleRate: number): B },
  onProgress?: (fraction: number) => void,
): Promise<B> {
  const info = parseWav(buf);
  if (!info) throw new Error('Unsupported WAV encoding (only PCM and float WAVs can be read in blocks).');
  if (info.frames < 1) throw new Error('The WAV file contains no audio.');
  let out: B;
  try {
    out = ctx.createBuffer(1, info.frames, info.sampleRate);
  } catch (e: any) {
    const gb = (info.frames * 4 / 1e9).toFixed(1);
    throw new Error(`Recording too long to load: ${Math.round(info.frames / info.sampleRate / 60)} min needs ${gb} GB of memory (${e?.message || e}).`);
  }
  const dst = out.getChannelData(0);
  for (let a = 0; a < info.frames; a += BLOCK_FRAMES) {
    const b = Math.min(info.frames, a + BLOCK_FRAMES);
    convertBlock(buf, info, info.dataOffset + a * info.blockAlign, b - a, a, dst);
    onProgress?.(b / info.frames);
    if (b < info.frames) await yieldToEventLoop();
  }
  return out;
}

/** Where the samples of a WAV blob are, plus its other chunks for the metadata parsers. */
export interface WavBlobLayout {
  info: WavInfo;
  /**
   * The file without its audio data: RIFF header, every other chunk, and the data chunk
   * header with size 0. parseGuano/readFileMetadata/readRecordingStart read this like the file.
   */
  skeleton: ArrayBuffer;
}

/** Chunks larger than this (other than the audio data) are left out of the skeleton. */
const MAX_META_CHUNK = 16 * 1024 * 1024;

const readBytes = async (blob: Blob, a: number, b: number) => new Uint8Array(await blob.slice(a, b).arrayBuffer());

/**
 * Read the chunk structure of a WAV blob without loading its audio data (only chunk headers
 * and small chunks are read). Returns null if the blob is not a WAV this reader can convert.
 */
export async function readWavBlobLayout(blob: Blob): Promise<WavBlobLayout | null> {
  const head = await readBytes(blob, 0, 12);
  if (!isWav(head.buffer as ArrayBuffer)) return null;
  const parts: Uint8Array[] = [head];
  let ds64Data = -1;
  let dataOffset = -1, dataBytes = 0;
  let pos = 12;
  while (pos + 8 <= blob.size) {
    const h = await readBytes(blob, pos, pos + 8);
    const v = new DataView(h.buffer);
    const id = String.fromCharCode(h[0], h[1], h[2], h[3]);
    let len = v.getUint32(4, true);
    const body = pos + 8;
    if (id === 'data') {
      if (len === 0xffffffff && ds64Data >= 0) len = ds64Data;
      const avail = blob.size - body;
      dataOffset = body;
      dataBytes = len === 0 || len > avail ? avail : len;
      const empty = new Uint8Array(8);
      empty.set(h.subarray(0, 4));
      parts.push(empty);
      pos = body + dataBytes + (dataBytes & 1);
      continue;
    }
    if (len <= MAX_META_CHUNK && body + len <= blob.size) {
      const chunk = await readBytes(blob, pos, body + len + (len & 1));
      if (id === 'ds64' && len >= 16) {
        const dv = new DataView(chunk.buffer);
        ds64Data = dv.getUint32(16, true) + dv.getUint32(20, true) * 2 ** 32;
      }
      parts.push(chunk);
    }
    pos = body + len + (len & 1);
  }
  if (dataOffset < 0) return null;
  const total = parts.reduce((n, p) => n + p.length, 0);
  const skeleton = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { skeleton.set(p, at); at += p.length; }
  new DataView(skeleton.buffer).setUint32(4, total - 8, true);
  // Format from the skeleton (its data chunk is empty), position and length from the blob.
  const fmtInfo = parseWav(skeleton.buffer);
  if (!fmtInfo) return null;
  const info: WavInfo = { ...fmtInfo, dataOffset, frames: Math.floor(dataBytes / fmtInfo.blockAlign) };
  return { info, skeleton: skeleton.buffer };
}

/**
 * Like decodeWavMono, but reads the samples block by block from a Blob/File, so the raw file
 * is never held in memory as a whole (Chromium keeps large blobs outside the page, on disk).
 */
export async function decodeWavMonoFromBlob<B extends { getChannelData(ch: number): Float32Array }>(
  blob: Blob,
  info: WavInfo,
  ctx: { createBuffer(channels: number, length: number, sampleRate: number): B },
  onProgress?: (fraction: number) => void,
): Promise<B> {
  if (info.frames < 1) throw new Error('The WAV file contains no audio.');
  let out: B;
  try {
    out = ctx.createBuffer(1, info.frames, info.sampleRate);
  } catch (e: any) {
    const gb = (info.frames * 4 / 1e9).toFixed(1);
    throw new Error(`Recording too long to load: ${Math.round(info.frames / info.sampleRate / 60)} min needs ${gb} GB of memory (${e?.message || e}).`);
  }
  const dst = out.getChannelData(0);
  for (let a = 0; a < info.frames; a += BLOCK_FRAMES) {
    const n = Math.min(info.frames, a + BLOCK_FRAMES) - a;
    const start = info.dataOffset + a * info.blockAlign;
    const bytes = await blob.slice(start, start + n * info.blockAlign).arrayBuffer();
    convertBlock(bytes, info, 0, n, a, dst);
    onProgress?.((a + n) / info.frames);
  }
  return out;
}
