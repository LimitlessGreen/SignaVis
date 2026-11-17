"""Overview mode: group a recording's calls, label whole groups. How much work does it save? Powdermill.

Candidates (per segment):
  truth    – the annotated boxes themselves (upper bound: perfect call finder)
  birdbox  – fused BirdBox boxes (fused.json from dump-fused.mjs); species from the best-overlapping
             annotated box (IoU >= 0.3), else 'noise'
Each candidate becomes a fixed-size patch: its box (± small margin) on the floor-removed dB spectrogram,
resampled to ROWS × COLS, z-normalised. Distance = 1 − Pearson r of the patches
+ W_DUR · |Δ log duration| + W_FREQ · |Δ log centre frequency|. Average-linkage clustering, cut at D.

Labelling effort (simulated): a group is labelled in one action with its majority species; every member of
another species is then fixed one by one. Effort = groups + wrong members. Baseline = one action per candidate.
Reported: effort / candidates (lower is better) and purity, per cut.

usage: uv run --with numpy --with scipy python scripts/similar/cluster-sim.py <powdermill dir> <fused.json> <segment> [...]
"""
import json, sys
import numpy as np
from scipy.io import wavfile
from scipy.signal import stft
from scipy.ndimage import zoom
from scipy.cluster.hierarchy import linkage, fcluster
from scipy.spatial.distance import squareform

SR, NFFT, HOP = 32000, 512, 128
DT, DF = HOP / SR, SR / NFFT
ROWS, COLS = 16, 24
import os
W_DUR, W_FREQ = float(os.environ.get('W_DUR', 0.3)), float(os.environ.get('W_FREQ', 1.0))
CUTS = (0.6, 0.8, 1.0, 1.2, 1.5, 2.0)
CLIP = os.environ.get('CLIP')   # dB: values below are set to it (None = no clipping)
root, fused = sys.argv[1], json.load(open(sys.argv[2]))
segs = sys.argv[3:]


def load(seg):
    rec = seg.split('_Segment')[0]
    sr, x = wavfile.read(f'{root}/wav_Files/{rec}/{seg}.wav')
    assert sr == SR, f'{seg}: {sr} Hz, expected {SR}'
    x = x.astype(np.float32) / 32768
    if x.ndim > 1: x = x.mean(1)
    lines = open(f'{root}/annotation_Files/{rec}/{seg}.Table.1.selections.txt').read().splitlines()
    cols = lines[0].split('\t')
    ix = [cols.index(c) for c in ('Begin Time (s)', 'End Time (s)', 'Low Freq (Hz)', 'High Freq (Hz)', 'Species')]
    gt = []
    for l in lines[1:]:
        c = l.split('\t')
        b = dict(t0=float(c[ix[0]]), t1=float(c[ix[1]]), f0=float(c[ix[2]]), f1=float(c[ix[3]]), sp=c[ix[4]].strip())
        if b['t1'] > b['t0'] and b['f1'] > b['f0']: gt.append(b)
    return x, gt


def spectrogram(x):
    _, _, z = stft(x, SR, nperseg=NFFT, noverlap=NFFT - HOP, boundary=None, padded=False)
    s = 10 * np.log10(np.abs(z) ** 2 + 1e-12)
    return s - np.median(s, axis=1, keepdims=True)


def feature(s, b):
    r0, r1 = max(0, int(b['f0'] / DF) - 1), min(s.shape[0], int(np.ceil(b['f1'] / DF)) + 2)
    c0, c1 = max(0, int(b['t0'] / DT) - 2), min(s.shape[1], int(b['t1'] / DT) + 3)
    p = s[r0:r1, c0:c1]
    if p.shape[0] < 2 or p.shape[1] < 2: p = np.zeros((2, 2))
    if CLIP is not None: p = np.maximum(p, float(CLIP))
    q = zoom(p, (ROWS / p.shape[0], COLS / p.shape[1]), order=1)[:ROWS, :COLS]
    q = q - q.mean(); q /= np.linalg.norm(q) + 1e-9
    return q.ravel(), np.log(max(1e-3, b['t1'] - b['t0'])), np.log(max(50.0, (b['f0'] + b['f1']) / 2))


def box_iou(a, b):
    it = max(0, min(a['t1'], b['t1']) - max(a['t0'], b['t0']))
    fq = max(0, min(a['f1'], b['f1']) - max(a['f0'], b['f0']))
    inter = it * fq
    ua = (a['t1'] - a['t0']) * (a['f1'] - a['f0']) + (b['t1'] - b['t0']) * (b['f1'] - b['f0']) - inter
    return inter / ua if ua > 0 else 0


def effort(labels, species):
    groups = {}
    for g, sp in zip(labels, species): groups.setdefault(g, []).append(sp)
    wrong = 0
    for members in groups.values():
        vals, counts = np.unique(members, return_counts=True)
        wrong += len(members) - counts.max()
    return len(groups) + wrong, 1 - wrong / len(species)


tot = {src: {c: [0, 0, 0.0] for c in CUTS} for src in ('truth', 'birdbox')}
for seg in segs:
    x, gt = load(seg)
    s = spectrogram(x)
    cands = {'truth': [dict(g) for g in gt]}
    bb = []
    for t0, t1, f0, f1, _ in fused.get(seg, []):
        b = dict(t0=t0, t1=t1, f0=f0, f1=f1)
        best, sp = 0.3, 'noise'
        for g in gt:
            v = box_iou(b, g)
            if v >= best: best, sp = v, g['sp']
        b['sp'] = sp; bb.append(b)
    cands['birdbox'] = bb
    for src, cs in cands.items():
        if len(cs) < 3: continue
        feats = [feature(s, b) for b in cs]
        P = np.stack([f[0] for f in feats]); ld = np.array([f[1] for f in feats]); lf = np.array([f[2] for f in feats])
        D = 1 - P @ P.T + W_DUR * np.abs(ld[:, None] - ld[None]) + W_FREQ * np.abs(lf[:, None] - lf[None])
        np.fill_diagonal(D, 0); D = np.maximum(D, 0); D = (D + D.T) / 2
        Z = linkage(squareform(D, checks=False), 'average')
        sp = [b['sp'] for b in cs]
        for c in CUTS:
            lab = fcluster(Z, c, 'distance')
            e, pur = effort(lab, sp)
            t = tot[src][c]; t[0] += e; t[1] += len(cs); t[2] += pur * len(cs)
    print(f'{seg}: {len(gt)} annotated, {len(bb)} BirdBox boxes', file=sys.stderr, flush=True)

for src, by in tot.items():
    print(f'\n{src}: effort per candidate (1.00 = label each one) | purity')
    for c, (e, n, p) in by.items():
        print(f'  cut {c:.1f}: {e / n:.2f} | {p / n:.2f}' if n else f'  cut {c:.1f}: no eligible candidates')
