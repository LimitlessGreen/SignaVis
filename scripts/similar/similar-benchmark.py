"""Find repeats of a labelled call in the same recording: correlation vs BirdBox-gated vs Perch.

For every species with >= 3 boxes in a segment, up to 6 boxes serve as exemplar in turn; the
targets are the other boxes of that species. Each method returns a ranked list of intervals.

Call metric (localisation): greedy matching, hit if time-IoU >= 0.3 with an unmatched target.
Region metric (finding): interval positive if it contains a target centre; recall = targets
whose centre lies in an interval above threshold. Both report AP and recall at precision >= 0.8.
usage: uv run --with onnxruntime --with numpy --with scipy python scripts/similar/similar-benchmark.py <powdermill dir> <fused.json> <segment> [...]
PERCH_MODEL=<perch_v2_embed.onnx>, PERCH_CACHE=<dir>; fused.json from dump-fused.mjs
"""
import json, os, sys
import numpy as np
import onnxruntime as ort
from scipy.io import wavfile
from scipy.signal import stft, correlate, find_peaks

SR, NFFT, HOP = 32000, 512, 128
DT, DF = HOP / SR, SR / NFFT
PERCH = os.environ.get('PERCH_MODEL', '../models/perch-v2/perch_v2_embed.onnx')
PERCH_HOP = 0.5

root, fused_path, segs = sys.argv[1], sys.argv[2], sys.argv[3:]
fused = json.load(open(fused_path))
perch = ort.InferenceSession(PERCH)


def load(seg):
    rec = seg.split('_Segment')[0]
    sr, x = wavfile.read(f'{root}/wav_Files/{rec}/{seg}.wav')
    assert sr == SR
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
    return s - np.median(s, axis=1, keepdims=True)          # band floor removed, like snap


def snr(s, b):
    r0, r1 = int(b['f0'] / DF), int(np.ceil(b['f1'] / DF)) + 1
    c0, c1 = int(b['t0'] / DT), max(int(b['t0'] / DT) + 1, int(b['t1'] / DT))
    return float(s[r0:r1, c0:c1].max())


def ncc_curve(s, ex, shift=2):
    """Normalised cross-correlation of the exemplar patch over time; max over ±shift bins."""
    r0, r1 = max(shift, int(ex['f0'] / DF) - 3), min(s.shape[0] - shift, int(np.ceil(ex['f1'] / DF)) + 4)
    c0, c1 = int(ex['t0'] / DT), int(ex['t1'] / DT)
    p = s[r0:r1, c0:c1].copy()
    p -= p.mean(); p /= np.linalg.norm(p) + 1e-9
    n, T = p.size, p.shape[1]
    best = None
    for d in range(-shift, shift + 1):
        x = s[r0 + d:r1 + d]
        num = correlate(x, p, mode='valid', method='fft')[0]
        cs, cs2 = np.cumsum(np.pad(x.sum(0), (1, 0))), np.cumsum(np.pad((x ** 2).sum(0), (1, 0)))
        sm, sm2 = cs[T:] - cs[:-T], cs2[T:] - cs2[:-T]
        var = np.maximum(sm2 - sm ** 2 / n, 1e-9)
        c = num / np.sqrt(var)
        best = c if best is None else np.maximum(best, c)
    return best, (c1 - c0) * DT


def ncc_peaks(curve, dur):
    pk, _ = find_peaks(curve, distance=max(1, int(0.6 * dur / DT)))
    return [(i * DT, i * DT + dur, float(curve[i])) for i in pk]


def tiou(a0, a1, b0, b1):
    i = max(0, min(a1, b1) - max(a0, b0))
    return i / (max(a1, b1) - min(a0, b0))


def ap_and_recall(hits, n_targets):
    """hits: list of booleans in rank order (True = new target found)."""
    tp = np.cumsum(hits); k = np.arange(1, len(hits) + 1)
    prec, rec = tp / k, tp / max(1, n_targets)
    ap = float(sum(prec[i] for i in range(len(hits)) if hits[i]) / max(1, n_targets))
    ok = prec >= 0.8
    return ap, float(rec[ok].max()) if ok.any() else 0.0


def call_metric(dets, targets):
    dets = sorted(dets, key=lambda d: -d[2])[:400]
    used, hits, found = set(), [], set()
    for t0, t1, _ in dets:
        best, bi = 0.3, None
        for i, g in enumerate(targets):
            if i in used: continue
            v = tiou(t0, t1, g['t0'], g['t1'])
            if v >= best: best, bi = v, i
        hits.append(bi is not None)
        if bi is not None: used.add(bi); found.add(bi)
    return ap_and_recall(hits, len(targets)), found


def region_metric(dets, targets):
    dets = sorted(dets, key=lambda d: -d[2])[:400]
    found, hits = set(), []
    for t0, t1, _ in dets:
        inside = {i for i, g in enumerate(targets) if t0 <= (g['t0'] + g['t1']) / 2 <= t1}
        new = inside - found
        hits.append(bool(inside))
        found |= new
    # precision over windows, recall over targets: count a window as hit once, recall from 'found'
    tp = np.cumsum(hits); k = np.arange(1, len(hits) + 1); prec = tp / k
    rec_curve, f2 = [], set()
    for t0, t1, _ in dets:
        f2 |= {i for i, g in enumerate(targets) if t0 <= (g['t0'] + g['t1']) / 2 <= t1}
        rec_curve.append(len(f2) / max(1, len(targets)))
    rec_curve = np.array(rec_curve)
    ok = prec >= 0.8
    return float(rec_curve[ok].max()) if ok.any() else 0.0, float(rec_curve[-1]) if len(rec_curve) else 0.0


def perch_embed(x):
    W = 5 * SR
    starts = np.arange(0, max(1, len(x) - W + 1), int(PERCH_HOP * SR))
    batch = np.stack([np.pad(x[s:s + W], (0, max(0, W - len(x[s:s + W])))) for s in starts]).astype(np.float32)
    e = np.concatenate([perch.run(None, {'inputs': batch[i:i + 16]})[0] for i in range(0, len(batch), 16)])
    e /= np.linalg.norm(e, axis=1, keepdims=True)
    return starts / SR, e


def perch_query(starts, emb, ex):
    """Query = window centred on the exemplar (closest available start)."""
    c = (ex['t0'] + ex['t1']) / 2
    q = emb[int(np.argmin(np.abs(starts + 2.5 - c)))]
    return emb @ q


res = {k: [] for k in ('ncc', 'bbox', 'fuse')}
region = {k: [] for k in ('ncc', 'perch', 'fuse')}
target_rows = []   # (snr, found by ncc, bbox, fuse)
for seg in segs:
    x, gt = load(seg)
    s = spectrogram(x)
    for g in gt: g['snr'] = snr(s, g)

    cf = f'{os.environ.get("PERCH_CACHE", "/tmp")}/{seg}.perch.npz'
    if os.path.exists(cf):
        z = np.load(cf); starts, emb = z['s'], z['e']
    else:
        starts, emb = perch_embed(x); np.savez(cf, s=starts, e=emb)
    boxes = fused.get(seg, [])
    by_sp = {}
    for g in gt: by_sp.setdefault(g['sp'], []).append(g)
    n_ex = 0
    for sp, calls in by_sp.items():
        if len(calls) < 3 or sp.lower() in ('unknown', '????'): continue
        for ex in calls[:6]:
            n_ex += 1
            targets = [g for g in calls if g is not ex]
            ex_mask = lambda d: tiou(d[0], d[1], ex['t0'], ex['t1']) < 0.3
            curve, dur = ncc_curve(s, ex)
            ncc = [d for d in ncc_peaks(curve, dur) if ex_mask(d)]
            # BirdBox as gate: only boxes overlapping the exemplar band, scored by best NCC inside the box
            bb = []
            for t0, t1, f0, f1, _ in boxes:
                if min(f1, ex['f1']) - max(f0, ex['f0']) <= 0: continue
                i0, i1 = max(0, int((t0 - 0.2) / DT)), min(len(curve), int(t1 / DT) + 1)
                if i1 > i0 and ex_mask((t0, t1)): bb.append((t0, t1, float(curve[i0:i1].max())))
            # Perch score at each NCC peak (window containing its centre, best of overlapping windows)
            pscore = perch_query(starts, emb, ex)
            pw = [(st, st + 5, float(v)) for st, v in zip(starts, pscore)
                  if not (st <= (ex['t0'] + ex['t1']) / 2 <= st + 5)]
            def perch_at(t):
                m = (starts <= t) & (starts + 5 >= t)
                return float(pscore[m].max()) if m.any() else 0.0
            fuse = [(a, b, 0.5 * v + 0.5 * perch_at((a + b) / 2)) for a, b, v in ncc]
            for name, dets in (('ncc', ncc), ('bbox', bb), ('fuse', fuse)):
                (ap, r80), found = call_metric(dets, targets)
                res[name].append((ap, r80))
                if name == 'ncc': f_ncc = found
                elif name == 'bbox': f_bb = found
                else: f_fu = found
            for i, g in enumerate(targets):
                target_rows.append((g['snr'], i in f_ncc, i in f_bb, i in f_fu))
            for name, dets in (('ncc', ncc), ('perch', pw), ('fuse', fuse)):
                region[name].append(region_metric(dets, targets))
    print(f'{seg}: {len(gt)} boxes, {n_ex} exemplars, {len(boxes)} BirdBox boxes', file=sys.stderr, flush=True)

print('\nCall metric (time-IoU >= 0.3), mean over exemplars')
for k, v in res.items():
    a = np.array(v)
    print(f'  {k:6s} AP {a[:, 0].mean():.2f} | recall @ P>=0.8 {a[:, 1].mean():.2f}')
print('\nRegion metric (interval contains target centre)')
for k, v in region.items():
    a = np.array(v)
    print(f'  {k:6s} recall @ P>=0.8 {a[:, 0].mean():.2f} | recall top-400 {a[:, 1].mean():.2f}')
t = np.array(target_rows, dtype=float)
q1, q2 = np.quantile(t[:, 0], [1 / 3, 2 / 3])
print('\nShare of targets found at any rank (call metric), by SNR third')
for name, m in (('quiet', t[:, 0] < q1), ('middle', (t[:, 0] >= q1) & (t[:, 0] < q2)), ('loud', t[:, 0] >= q2)):
    print(f'  {name:6s} n={m.sum():5d}  ncc {t[m, 1].mean():.2f}  bbox {t[m, 2].mean():.2f}  fuse {t[m, 3].mean():.2f}')
