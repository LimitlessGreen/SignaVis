/**
 * Chunked MP3 decoding for recordings too long for a single decodeAudioData call.
 *
 * decodeAudioData builds one AudioBuffer for the whole file; a 2 h stereo MP3 at 44.1 kHz needs
 * ~2.8 GB of Float32 PCM, and Chrome rejects that with a generic "Unable to decode audio data".
 * Here the MP3 is split at frame boundaries into blocks of a few minutes, each block is decoded
 * on its own and mixed down to mono straight into one preallocated AudioBuffer (no resampling).
 *
 * Each block after the first starts a few frames early (overlap): the decoder lacks the bit
 * reservoir for those frames, so their output is discarded. Only the last
 * (frames in block × samples per frame) samples of every decoded block are kept.
 */

/** Files above this size use the chunked path directly (smaller ones try a normal decode first). */
export const CHUNKED_DECODE_MIN_BYTES = 40 * 1024 * 1024;
/** Length of one decoded block. */
const BLOCK_SEC = 300;
/** Extra frames decoded before each block and discarded (bit reservoir warm-up). */
const OVERLAP_FRAMES = 10;
/** Decoder delay ffmpeg/Chrome add on top of the LAME encoder delay when trimming. */
const DECODER_DELAY = 529;

const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

export interface Mp3FrameIndex {
  /** Byte offset of every audio frame (Info/Xing frame excluded). */
  offsets: Uint32Array;
  /** Byte offset just past the last frame. */
  end: number;
  sampleRate: number;
  samplesPerFrame: number;
  /** Samples to drop at the start (LAME encoder delay + decoder delay), 0 without a LAME tag. */
  startTrim: number;
}

interface FrameHeader { length: number; sampleRate: number; samplesPerFrame: number; mono: boolean; v1: boolean }

function parseHeader(b: Uint8Array, i: number): FrameHeader | null {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const ver = (b[i + 1] >> 3) & 3;          // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const layer = (b[i + 1] >> 1) & 3;        // 1 = Layer III
  if (ver === 1 || layer !== 1) return null;
  const brIdx = b[i + 2] >> 4;
  const srIdx = (b[i + 2] >> 2) & 3;
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const v1 = ver === 3;
  const bitrate = (v1 ? BITRATES_V1 : BITRATES_V2)[brIdx] * 1000;
  const sampleRate = SAMPLE_RATES[ver][srIdx];
  const pad = (b[i + 2] >> 1) & 1;
  const samplesPerFrame = v1 ? 1152 : 576;
  const length = Math.floor((samplesPerFrame / 8) * bitrate / sampleRate) + pad;
  return { length, sampleRate, samplesPerFrame, mono: (b[i + 3] >> 6) === 3, v1 };
}

/** True when the buffer looks like an MP3 (ID3 tag or a Layer III frame header at the start). */
export function isMp3(buf: ArrayBuffer): boolean {
  const b = new Uint8Array(buf, 0, Math.min(buf.byteLength, 4096));
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return true; // "ID3"
  for (let i = 0; i < b.length - 4; i++) if (parseHeader(b, i)) return true;
  return false;
}

/** Index all frames. Resyncs over garbage between frames; stops at a trailing ID3v1/APE tag. */
export function indexMp3Frames(buf: ArrayBuffer): Mp3FrameIndex {
  const b = new Uint8Array(buf);
  let i = 0;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
    const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
    i = 10 + size + ((b[5] & 0x10) ? 10 : 0);
  }
  let offsets = new Uint32Array(Math.max(1024, Math.ceil(b.length / 200)));
  let n = 0;
  let sampleRate = 0, samplesPerFrame = 0, startTrim = 0, end = i;
  let first = true;
  while (i + 4 <= b.length) {
    const h = parseHeader(b, i);
    // A header only counts if the next frame also starts where it says (or the file ends there).
    const ok = h && (sampleRate === 0 || h.sampleRate === sampleRate)
      && (i + h.length >= b.length || parseHeader(b, i + h.length) !== null || i + h.length + 128 >= b.length);
    if (!h || !ok) { i++; continue; }
    if (first) {
      first = false;
      sampleRate = h.sampleRate; samplesPerFrame = h.samplesPerFrame;
      // Xing/Info frame: metadata only, not audio. Read the LAME encoder delay if present.
      const sideInfo = h.v1 ? (h.mono ? 17 : 32) : (h.mono ? 9 : 17);
      const tagAt = i + 4 + sideInfo;
      const tag = String.fromCharCode(b[tagAt], b[tagAt + 1], b[tagAt + 2], b[tagAt + 3]);
      if (tag === 'Xing' || tag === 'Info') {
        // Xing block: tag + flags, then optional frames(4), bytes(4), TOC(100), quality(4).
        const flags = b[tagAt + 7];
        const lameAt = tagAt + 8 + ((flags & 1) ? 4 : 0) + ((flags & 2) ? 4 : 0) + ((flags & 4) ? 100 : 0) + ((flags & 8) ? 4 : 0);
        const lame = String.fromCharCode(b[lameAt], b[lameAt + 1], b[lameAt + 2], b[lameAt + 3]);
        if (lame === 'LAME' || lame === 'Lavf' || lame === 'Lavc') {
          const d = lameAt + 21; // encoder delay: 12 bits at offset 0x15 of the LAME tag
          const encDelay = (b[d] << 4) | (b[d + 1] >> 4);
          startTrim = encDelay + DECODER_DELAY;
        }
        i += h.length; end = i;
        continue;
      }
    }
    if (n === offsets.length) { const grown = new Uint32Array(n * 2); grown.set(offsets); offsets = grown; }
    offsets[n++] = i;
    i += h.length;
    end = Math.min(i, b.length);
  }
  if (!n) throw new Error('No MP3 audio frames found.');
  return { offsets: offsets.subarray(0, n), end, sampleRate, samplesPerFrame, startTrim };
}

/**
 * Write the last `want` samples of a decoded block (mono, or the mean of two channels) to
 * dst[written ...], left-padding with silence if the decoder returned fewer; positions outside
 * dst (encoder-delay trim at the start, padding at the end) are skipped.
 */
export function placeBlock(dst: Float32Array, c0: Float32Array, c1: Float32Array | null, len: number, written: number, want: number): void {
  const srcStart = Math.max(0, len - want);
  const missing = Math.max(0, want - len);
  const kLo = Math.max(0, -written);
  const kHi = Math.min(want, dst.length - written);
  if (kHi <= kLo) return;
  const zeroEnd = Math.min(kHi, missing);
  if (zeroEnd > kLo) dst.fill(0, written + kLo, written + zeroEnd);
  const k0 = Math.max(kLo, missing);
  if (k0 >= kHi) return;
  const j0 = srcStart + k0 - missing, n = kHi - k0, p0 = written + k0;
  if (!c1) { dst.set(c0.subarray(j0, j0 + n), p0); return; }
  for (let i = 0; i < n; i++) dst[p0 + i] = (c0[j0 + i] + c1[j0 + i]) * 0.5;
}

export type ChunkProgress = (fraction: number) => void;

/**
 * Decode an MP3 block by block into one mono AudioBuffer at the file's native sample rate.
 * `ctx` must run at that sample rate (decodeAudioData resamples to the context rate).
 */
export async function decodeMp3Chunked(buf: ArrayBuffer, ctx: BaseAudioContext, onProgress?: ChunkProgress, blockSec = BLOCK_SEC): Promise<AudioBuffer> {
  const idx = indexMp3Frames(buf);
  const { offsets, samplesPerFrame: spf, sampleRate } = idx;
  const nFrames = offsets.length;
  const totalSamples = nFrames * spf - idx.startTrim;
  let out: AudioBuffer;
  try {
    out = ctx.createBuffer(1, totalSamples, sampleRate);
  } catch (e: any) {
    const gb = (totalSamples * 4 / 1e9).toFixed(1);
    throw new Error(`Recording too long to load: ${Math.round(totalSamples / sampleRate / 60)} min needs ${gb} GB of memory (${e?.message || e}).`);
  }
  const dst = out.getChannelData(0);
  const framesPerBlock = Math.max(1, Math.ceil(blockSec * sampleRate / spf));
  let written = -idx.startTrim; // position of the next kept sample in the untrimmed stream

  for (let a = 0; a < nFrames; a += framesPerBlock) {
    const b = Math.min(nFrames, a + framesPerBlock);
    const from = Math.max(0, a - OVERLAP_FRAMES);
    const byteStart = offsets[from];
    const byteEnd = b < nFrames ? offsets[b] : idx.end;
    // slice() copies: decodeAudioData detaches the buffer it gets.
    const decoded = await ctx.decodeAudioData(buf.slice(byteStart, byteEnd));
    const want = (b - a) * spf;
    const len = decoded.length;
    const c1 = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : null;
    placeBlock(dst, decoded.getChannelData(0), c1, decoded.length, written, want);
    written += want;
    onProgress?.(b / nFrames);
  }
  return out;
}
