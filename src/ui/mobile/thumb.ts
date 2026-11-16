/**
 * Small spectrogram pictures for the recording cards (phone UI).
 * Rendered once per recording into a JPEG data URL, so the cards stay cheap.
 */

const W = 320;          // columns (CSS width ~ card width; drawn at 2× height for sharpness)
const H = 104;          // pixel rows (shown at 52 px)
const FFT = 512;
const F_MAX = 12000;    // birds live below this; keeps the picture readable

// Dark → red → orange → yellow, like the app's default spectrogram.
const STOPS: [number, number, number, number][] = [
  [0, 8, 6, 14], [0.35, 90, 14, 40], [0.6, 200, 50, 20], [0.82, 245, 140, 30], [1, 252, 240, 160],
];
const LUT = (() => {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    let k = 0;
    while (k < STOPS.length - 2 && x > STOPS[k + 1][0]) k++;
    const [x0, r0, g0, b0] = STOPS[k];
    const [x1, r1, g1, b1] = STOPS[k + 1];
    const f = Math.min(1, Math.max(0, (x - x0) / (x1 - x0)));
    lut[i * 3] = r0 + (r1 - r0) * f;
    lut[i * 3 + 1] = g0 + (g1 - g0) * f;
    lut[i * 3 + 2] = b0 + (b1 - b0) * f;
  }
  return lut;
})();

/** In-place radix-2 FFT (re/im of length n, n a power of two). */
function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** Mono samples of an AudioBuffer (first channel is enough for a thumbnail). */
export function renderThumb(buffer: AudioBuffer): string | null {
  if (typeof document === 'undefined' || !buffer?.length) return null;
  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const fTop = Math.min(F_MAX, sr / 2);
  const bins = Math.max(2, Math.floor(fTop / (sr / FFT)));
  const win = new Float32Array(FFT);
  for (let i = 0; i < FFT; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT - 1));

  const mag = new Float32Array(W * H);
  const re = new Float32Array(FFT), im = new Float32Array(FFT);
  const step = Math.max(1, (data.length - FFT) / W);
  for (let x = 0; x < W; x++) {
    const off = Math.floor(x * step);
    for (let i = 0; i < FFT; i++) { re[i] = (data[off + i] || 0) * win[i]; im[i] = 0; }
    fft(re, im);
    for (let y = 0; y < H; y++) {
      // y = 0 is the top row (high frequency)
      const b0 = Math.floor((1 - (y + 1) / H) * bins) + 1;
      const b1 = Math.max(b0 + 1, Math.floor((1 - y / H) * bins) + 1);
      let m = 0;
      for (let b = b0; b < b1; b++) m = Math.max(m, re[b] * re[b] + im[b] * im[b]);
      mag[y * W + x] = 10 * Math.log10(m + 1e-12);
    }
  }
  // Contrast from percentiles: the noise floor goes dark, calls stand out.
  const sorted = Float32Array.from(mag).sort();
  const lo = sorted[Math.floor(sorted.length * 0.55)];
  const hi = sorted[Math.floor(sorted.length * 0.995)];
  const span = Math.max(1, hi - lo);

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    // gamma < 1 lifts quiet calls a little
    const v = Math.round(255 * Math.pow(Math.max(0, Math.min(1, (mag[i] - lo) / span)), 0.75));
    img.data[i * 4] = LUT[v * 3];
    img.data[i * 4 + 1] = LUT[v * 3 + 1];
    img.data[i * 4 + 2] = LUT[v * 3 + 2];
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.72);
}

/** Fetch + decode a recording that is not open, then render its thumbnail. */
export async function thumbFromUrl(url: string): Promise<{ thumb: string | null; duration: number } | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const bytes = await res.arrayBuffer();
  const Ctx = (window as any).OfflineAudioContext || (window as any).webkitOfflineAudioContext;
  const ctx = new Ctx(1, 1, 22050);
  const buf: AudioBuffer = await ctx.decodeAudioData(bytes);
  return { thumb: renderThumb(buf), duration: buf.duration };
}
