"""Paritaet aw-embed (Rust) vs. Python-Referenz (scipy resample_poly + onnxruntime).

python parity.py <model.onnx> <audio.wav> <rust_out.f32>
"""
import sys, time
from math import gcd
import numpy as np, soundfile as sf, onnxruntime as ort
from scipy.signal import resample_poly

W, DIM = 160_000, 1536
model, wav, rs_path = sys.argv[1:4]
x, sr = sf.read(wav, dtype="float32", always_2d=True)
x = x.mean(axis=1)
g = gcd(32000, sr)
y = resample_poly(x, 32000 // g, sr // g).astype(np.float32)

raw = np.fromfile(rs_path, dtype="<f4")
n = int(np.ceil(max(len(y) - W, 0) / W)) + 1
rs_emb = raw[-n * DIM:].reshape(n, DIM)
rs_y = raw[:-n * DIM]
m = min(len(y), len(rs_y))
err = rs_y[:m] - y[:m]
print(f"resample: len py={len(y)} rs={len(rs_y)}, SNR={10*np.log10((y[:m]**2).sum()/(err**2).sum()):.1f} dB")

def frames(sig):
    f = np.zeros((n, W), np.float32)
    for i in range(n):
        s = sig[i * W:(i + 1) * W]; f[i, :len(s)] = s
    return f

sess = ort.InferenceSession(model, providers=["CPUExecutionProvider"])
t = time.time()
py_emb = np.concatenate([sess.run(["embedding"], {"inputs": b})[0] for b in np.array_split(frames(y), max(1, n // 8))])
dt = time.time() - t
print(f"python ort: {dt*1000/n:.1f} ms/Fenster")
same = np.concatenate([sess.run(["embedding"], {"inputs": b})[0] for b in np.array_split(frames(rs_y), max(1, n // 8))])
cos = lambda a, b: (a * b).sum(1) / np.linalg.norm(a, axis=1) / np.linalg.norm(b, axis=1)
print(f"gleiches Audio, Rust-ORT vs Py-ORT: max|d|={np.abs(same-rs_emb).max():.2e}")
c = cos(py_emb, rs_emb)
print(f"Rust-Resampling vs scipy: cos min={c.min():.5f} mean={c.mean():.5f}")
# Bezug: wie stark aendert sich ein Embedding bei 0,1 s Versatz?
sh = frames(np.concatenate([np.zeros(3200, np.float32), y]))
cs = cos(np.concatenate([sess.run(["embedding"], {"inputs": b})[0] for b in np.array_split(sh, max(1, n // 8))]), py_emb)
print(f"Bezug 0,1 s Versatz: cos mean={cs.mean():.5f}")
