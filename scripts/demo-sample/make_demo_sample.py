"""Generate the bundled SignaVis demo recording (demo/samples/signavis-demo.wav).

Same idea as the profile banner: the word "SignaVis" is written *into the
sound* (every bitmap row becomes a sine tone), surrounded by synthetic bird
calls and a few classic signal-processing "specimens" that show off the
spectrogram, harmonic and filter tools.  Everything is synthesized; a
spectrogram (0-24 kHz, 12 s) reveals the text.

    uv run --with numpy --with pillow scripts/demo-sample/make_demo_sample.py [--png preview.png]
"""

import sys
import wave
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

SR = 48_000
DUR = 12.0
RNG = np.random.default_rng(11)
OUT = Path(__file__).resolve().parents[2] / "demo" / "samples" / "signavis-demo.wav"
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

t_all = np.arange(int(SR * DUR)) / SR
signal = np.zeros_like(t_all)


def add(start, f_of_u, dur, amp=1.0, harmonics=(1.0, 0.2), env_pow=1.5):
    """Add a syllable with instantaneous frequency f_of_u(u), u in [0, 1]."""
    n = int(dur * SR)
    i0 = int(start * SR)
    n = min(n, len(signal) - i0)
    u = np.arange(n) / max(n - 1, 1)
    jitter = np.cumsum(RNG.normal(0, 1, n))
    jitter = (jitter - np.linspace(0, jitter[-1], n)) / (np.sqrt(n) + 1e-9)
    f = f_of_u(u) * (1 + 0.003 * jitter)
    phase = 2 * np.pi * np.cumsum(f) / SR
    env = np.sin(np.pi * u) ** env_pow
    s = sum(a * np.sin((k + 1) * phase) * ((k + 1) * f < 0.95 * SR / 2)
            for k, a in enumerate(harmonics))
    signal[i0:i0 + n] += amp * env * s


def place(start, x, amp, fade=0.02):
    """Mix x into the signal with raised-cosine fades, normalized to amp."""
    n = len(x)
    nf = int(fade * SR)
    env = np.ones(n)
    ramp = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, nf))
    env[:nf], env[-nf:] = ramp, ramp[::-1]
    i0 = int(start * SR)
    signal[i0:i0 + n] += amp * env * x / np.abs(x).max()


def tt(dur):
    return np.arange(int(dur * SR)) / SR


# --- "SignaVis" written into the sound ------------------------------------
TEXT, TEXT_T, TEXT_F = "SignaVis", (3.2, 10.6), (9500, 17500)


def write_text():
    font = ImageFont.truetype(FONT, 200) if Path(FONT).exists() else ImageFont.load_default(200)
    x0, y0, x1, y1 = font.getbbox(TEXT)
    mask = Image.new("L", (x1 - x0 + 20, y1 - y0 + 20))
    ImageDraw.Draw(mask).text((10 - x0, 10 - y0), TEXT, font=font, fill=255)
    # tones on every 3rd bin centre of a 2048-pt FFT (23.4 Hz bins) -> each
    # bin is fed by one tone only, no beating, clean letters for nfft 1024-2048
    bin_hz = SR / 2048
    freqs = np.arange(np.ceil(TEXT_F[0] / bin_hz / 3) * 3, TEXT_F[1] / bin_hz, 3) * bin_hz
    n_cols = int((TEXT_T[1] - TEXT_T[0]) * 400)
    mask = mask.resize((n_cols, len(freqs)), Image.LANCZOS).filter(ImageFilter.GaussianBlur(0.8))
    m = np.flipud(np.asarray(mask, dtype=float) / 255)
    i0, i1 = int(TEXT_T[0] * SR), int(TEXT_T[1] * SR)
    t = t_all[i0:i1]
    cols = np.linspace(0, n_cols - 1, len(t))
    for j, f in enumerate(freqs):
        if m[j].max() < 0.05:
            continue
        env = np.interp(cols, np.arange(n_cols), m[j])
        signal[i0:i1] += 0.11 * env * np.sin(2 * np.pi * f * t + RNG.uniform(0, 2 * np.pi))


# --- synthetic birds (0-3 s: a little dawn chorus as overture) -------------
# descending whistles
for k, st in enumerate(np.arange(0.25, 1.4, 0.28)):
    hi = 5200 - 250 * (k % 2) + RNG.normal(0, 80)
    add(st, lambda u, hi=hi: hi - 2400 * u ** 0.8, 0.14, 0.8)
# fast trill: rapid up-sweeps
for st in np.arange(1.55, 2.45, 0.045):
    add(st, lambda u: 3600 + 1800 * u, 0.03, 0.55, harmonics=(1.0,))
# two-note "tsip-tsap" pattern
for k, st in enumerate(np.arange(0.2, 2.9, 0.38)):
    f0 = 6800 if k % 2 == 0 else 5900
    add(st, lambda u, f0=f0: f0 + 500 * np.cos(np.pi * u), 0.09, 0.45, harmonics=(1.0,))
# low hooting owl with rich harmonics (good target for the harmonic tools)
for st in (0.4, 1.3, 2.2):
    add(st, lambda u: 520 + 40 * np.sin(np.pi * u), 0.42, 0.7,
        harmonics=(1.0, 0.6, 0.35, 0.2, 0.12, 0.07), env_pow=0.8)

# --- signal-processing specimens under the text ----------------------------
# exponential sine sweep (Farina): x(t) = sin(2 pi f1 L (e^(t/L) - 1))
f1, f2, T = 400, 8000, 1.1
L = T / np.log(f2 / f1)
place(3.3, np.sin(2 * np.pi * f1 * L * (np.exp(tt(T) / L) - 1)), 0.6)
# FM synthesis (Chowning) with swelling modulation index -> Bessel sidebands
fc, fm, T = 4200, 230, 1.1
t = tt(T)
beta = 6 * np.sin(np.pi * t / T) ** 2
place(4.6, np.sin(2 * np.pi * fc * t + beta * np.sin(2 * np.pi * fm * t)), 0.6)
# harmonic stack: band-limited sawtooth, glide + vibrato -> fanning harmonics
T = 1.2
t = tt(T)
f0 = 420 + 220 * (t / T) + 18 * np.sin(2 * np.pi * 5.5 * t) * (t / T)
ph = 2 * np.pi * np.cumsum(f0) / SR
place(5.9, sum(np.sin(n * ph) / n * (n * f0 < 8000) for n in range(1, 16)), 0.7)
# sinc-shaped frequency trace
T = 1.3
t = tt(T)
f_sinc = 2400 + 4200 * np.sinc(np.linspace(-6.5, 6.5, len(t)))
place(7.3, np.sin(2 * np.pi * np.cumsum(f_sinc) / SR), 0.65)
# a melodic songbird phrase to close: whistles + trill + buzzy end note
for k, st in enumerate(np.arange(8.8, 9.6, 0.16)):
    add(st, lambda u, k=k: 3000 + 260 * k + 900 * np.sin(np.pi * u), 0.11, 0.8)
for st in np.arange(9.7, 10.25, 0.05):
    add(st, lambda u: 6200 - 2200 * u, 0.035, 0.55, harmonics=(1.0,))
T = 0.45
t = tt(T)
buzz = np.sin(2 * np.pi * 3800 * t) * (1 + 0.9 * np.sin(2 * np.pi * 90 * t))
place(10.35, buzz, 0.5)

# --- above the text: insect-like pulses at 19-21 kHz -----------------------
for st in np.arange(0.3, 11.5, 0.5):
    for p in range(4):
        add(st + p * 0.035, lambda u: 20000 - 600 * u, 0.02, 0.12, harmonics=(1.0,))

# faint background chorus everywhere
for _ in range(90):
    st = RNG.uniform(0, DUR - 0.3)
    f0 = RNG.uniform(1500, 8500)
    sweep = RNG.uniform(-1500, 1500)
    add(st, lambda u, f0=f0, sw=sweep: np.clip(f0 + sw * u, 600, 9000),
        RNG.uniform(0.04, 0.22), RNG.uniform(0.01, 0.04), harmonics=(1.0, 0.05))

# forest reverb
ir_t = tt(0.4)
ir = RNG.normal(size=len(ir_t)) * np.exp(-ir_t / 0.08)
ir[0] = 0
wet = np.fft.irfft(np.fft.rfft(signal, 2 * len(signal)) * np.fft.rfft(ir, 2 * len(signal)))
signal += 0.06 * wet[:len(signal)] / (np.abs(ir).sum() ** 0.5)

write_text()

# pink-ish background noise + low wind rumble
freqs = np.fft.rfftfreq(len(signal), 1 / SR)
spec = np.fft.rfft(RNG.normal(size=len(signal))) / np.sqrt(np.maximum(freqs, 30))
noise = np.fft.irfft(spec, n=len(signal))
signal += 0.025 * noise / noise.std()
rum = np.fft.irfft(np.fft.rfft(RNG.normal(size=len(signal))) * np.exp(-freqs / 180), n=len(signal))
signal += 0.12 * rum / rum.std()

pcm = signal / np.abs(signal).max() * 0.89
fade = int(0.02 * SR)
pcm[:fade] *= np.linspace(0, 1, fade)
pcm[-fade:] *= np.linspace(1, 0, fade)
with wave.open(str(OUT), "wb") as wf:
    wf.setnchannels(1)
    wf.setsampwidth(2)
    wf.setframerate(SR)
    wf.writeframes((pcm * 32767).astype("<i2").tobytes())
print(f"{OUT.name}: {OUT.stat().st_size / 1024:.0f} kB")

if "--png" in sys.argv:  # quick preview spectrogram
    nfft, hop = 2048, 256
    fr = np.lib.stride_tricks.sliding_window_view(pcm, nfft)[::hop]
    S = 20 * np.log10(np.abs(np.fft.rfft(fr * np.hanning(nfft), axis=1)).T + 1e-9)
    v = np.clip((S - S.max() + 80) / 80, 0, 1)
    Image.fromarray((np.flipud(v) ** 1.3 * 255).astype(np.uint8)).resize((1600, 600)).save(
        sys.argv[sys.argv.index("--png") + 1])
