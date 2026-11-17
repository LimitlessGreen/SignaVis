"""Does re-ranking with accepted / rejected suggestions help the review? Simulation on Powdermill.

For every exemplar (as in similar-benchmark.py) the candidates are the 150 best correlation peaks.
A simulated user reviews K suggestions, one at a time: accepts if it hits a not-yet-found call of the
species (time-IoU >= 0.3), else rejects. Strategies:
  static     – initial score order (step 1)
  rerank λ   – after each decision: score = max(sim to exemplar + accepted) − λ · max(0, sim to rejected)
Similarity between two candidates: Pearson r of their patches, best over ±1 row / ±2 frames.
Reports calls found after K = 5, 10, 20 reviews (mean over exemplars, share of all targets).

usage: uv run --with numpy --with scipy python scripts/similar/rerank-sim.py <powdermill dir> <segment> [...]
"""
import sys
import numpy as np
from scipy.io import wavfile
from scipy.signal import stft, correlate, find_peaks

SR, NFFT, HOP = 32000, 512, 128
DT, DF = HOP / SR, SR / NFFT
N_CAND, KS, LAMBDAS = 150, (5, 10, 20), (0.5, 1.0)
root, segs = sys.argv[1], sys.argv[2:]


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


def band(ex, s, shift=2):
    return max(shift, int(ex['f0'] / DF) - 3), min(s.shape[0] - shift, int(np.ceil(ex['f1'] / DF)) + 4)


def ncc_curve(s, ex, r0, r1, shift=2):
    c0, c1 = int(ex['t0'] / DT), int(ex['t1'] / DT)
    p = s[r0:r1, c0:c1].copy(); p -= p.mean(); p /= np.linalg.norm(p) + 1e-9
    n, T = p.size, p.shape[1]
    best, arg = None, None
    for d in range(-shift, shift + 1):
        x = s[r0 + d:r1 + d]
        num = correlate(x, p, mode='valid', method='fft')[0]
        cs, cs2 = np.cumsum(np.pad(x.sum(0), (1, 0))), np.cumsum(np.pad((x ** 2).sum(0), (1, 0)))
        sm, sm2 = cs[T:] - cs[:-T], cs2[T:] - cs2[:-T]
        c = num / np.sqrt(np.maximum(sm2 - sm ** 2 / n, 1e-9))
        if best is None: best, arg = c, np.full(c.shape, d)
        else: m = c > best; best = np.where(m, c, best); arg = np.where(m, d, arg)
    return best, arg, T


def tiou(a0, a1, b0, b1):
    return max(0, min(a1, b1) - max(a0, b0)) / (max(a1, b1) - min(a0, b0))


def patch(s, r0, r1, c, d, T, pad=2):
    c0 = max(0, c - pad)
    return s[r0 + d - 1:r1 + d + 1, c0:c0 + T + 2 * pad]


def sim(a, b):
    """Pearson r of b's core against a, best over ±1 row / ±2 frames (a has the margins)."""
    core = b[1:-1, 2:-2]
    if core.size == 0 or a.shape[1] < core.shape[1] or a.shape[0] < core.shape[0]: return 0.0
    k = core - core.mean(); k /= np.linalg.norm(k) + 1e-9
    best = -1.0
    for dr in range(a.shape[0] - core.shape[0] + 1):
        for dc in range(a.shape[1] - core.shape[1] + 1):
            w = a[dr:dr + core.shape[0], dc:dc + core.shape[1]]
            w = w - w.mean(); nw = np.linalg.norm(w)
            if nw > 0: best = max(best, float((w * k).sum() / nw))
    return best


def review(cands, truth_of, K, score0, simf, lam):
    """Returns calls found after each of K reviews."""
    left = list(range(len(cands)))
    pos_sim = np.array(score0, dtype=float)                 # vs exemplar (+ accepted)
    neg_sim = np.full(len(cands), -np.inf)
    found, out = set(), []
    for _ in range(min(K, len(cands))):
        sc = pos_sim[left] - (lam * np.maximum(0, neg_sim[left]) if lam is not None else 0)
        i = left.pop(int(np.argmax(sc)))
        t = truth_of(i, found)
        if t is not None: found.add(t)
        if lam is not None:
            for j in left:
                v = simf(i, j)
                if t is not None: pos_sim[j] = max(pos_sim[j], v)
                else: neg_sim[j] = max(neg_sim[j], v)
        out.append(len(found))
    while len(out) < K: out.append(out[-1] if out else 0)
    return out


strategies = ['static'] + [f'rerank λ={l}' for l in LAMBDAS]
res = {k: [] for k in strategies}
n_targets = []
for seg in segs:
    x, gt = load(seg)
    s = spectrogram(x)
    by_sp = {}
    for g in gt: by_sp.setdefault(g['sp'], []).append(g)
    n_ex = 0
    for sp, calls in by_sp.items():
        if len(calls) < 3 or sp.lower() in ('unknown', '????'): continue   # as in similar-benchmark.py
        for ex in calls[:6]:
            targets = [g for g in calls if g is not ex]
            r0, r1 = band(ex, s)
            curve, arg, T = ncc_curve(s, ex, r0, r1)
            pk, _ = find_peaks(curve, distance=max(1, int(0.6 * T)))
            pk = [i for i in pk if tiou(i * DT, (i + T) * DT, ex['t0'], ex['t1']) < 0.3]
            pk = sorted(pk, key=lambda i: -curve[i])[:N_CAND]
            if not pk: continue
            n_ex += 1
            cands = [(i * DT, (i + T) * DT) for i in pk]
            patches = [patch(s, r0, r1, i, int(arg[i]), T) for i in pk]
            cache = {}
            def simf(i, j):
                k = (min(i, j), max(i, j))
                if k not in cache: cache[k] = sim(patches[j], patches[i])
                return cache[k]
            def truth_of(i, found):
                a, b = cands[i]
                best, bi = 0.3, None
                for ti, g in enumerate(targets):
                    if ti in found: continue
                    v = tiou(a, b, g['t0'], g['t1'])
                    if v >= best: best, bi = v, ti
                return bi
            score0 = [float(curve[i]) for i in pk]
            K = max(KS)
            res['static'].append(review(cands, truth_of, K, score0, simf, None))
            for l in LAMBDAS: res[f'rerank λ={l}'].append(review(cands, truth_of, K, score0, simf, l))
            n_targets.append(len(targets))
    print(f'{seg}: {n_ex} exemplars', file=sys.stderr, flush=True)

nt = np.array(n_targets, float)
print(f'\n{len(nt)} exemplars; calls found after K reviews (mean count | share of each exemplar\'s targets)')
for k in strategies:
    a = np.array(res[k], float)
    print(f'  {k:14s} ' + '  '.join(f'K={K:2d}: {a[:, K - 1].mean():5.2f} | {np.mean(a[:, K - 1] / nt):.2f}' for K in KS))
