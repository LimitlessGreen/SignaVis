# Similar calls: label one, confirm the rest

Status: step 1 built (2026-11-17), branch `feat/similar-calls`, not pushed.

## Idea

A bird in a recording usually repeats the same call or song type. After one label, SignaVis proposes
the other occurrences in the same recording as **suggestions** (not labels). The user confirms or
rejects them in a fast review; nothing is ever adopted automatically (training-data bias).

## Workflow

1. Label an exemplar as today (template, snap, adopt).
2. In the background: badge "14 similar" on the label, ghost boxes (dashed, species colour) in the view.
3. Review (`R`): strip of spectrogram thumbnails sorted by score, each played when focused;
   `Enter` accept, `X` reject, `Shift+Enter` accept all above the threshold slider.
4. Accepted = more exemplars, rejected = negatives → re-rank immediately.
5. One undo step per accepted group.
6. Later: overview mode — cluster all candidates of a recording, label whole clusters.

## Search and boxing are separate stages

BirdBox misses many quiet calls (snap benchmark: no box for 20 % of the quiet third, IoU ≥ 0.5 only
36 % overall), so it must not decide where we look.

1. **Where:** Perch windows similar to the exemplar (Lite) ∪ spectrogram correlation over the whole
   recording (everywhere, offline).
2. **Exactly where:** correlation with the exemplar inside those regions → box in time and frequency.
3. **Refine (optional):** overlapping BirdBox box → take its bounds; else keep the correlation box.
4. **Rank:** combine correlation and Perch similarity; BirdBox only a small bonus.

Each suggestion records which source found it.

## Data and code

- Layer `suggestions` beside the labels; not exported. Rejections may be stored so they do not return.
- Accepted labels: `adoptedFrom: { kind: 'similar', sourceLabelId, score, sources }`.
  Also fix: snap labels lack `adoptedFrom.box`.
- `src/domain/similar/` pure functions (patch features, NCC, scoring); `src/app/suggest-similar.ts`
  orchestration in a worker; UI: suggestion layer, review strip, badge. Accept/reject as commands
  (architecture step 3).
- Lite: reuse `embed_similar`, optionally project-wide; confirmed/rejected suggestions feed agile modelling.

## Measurement (Powdermill, 9 segments)

Scripts: `scripts/similar/dump-fused.mjs` (BirdBox boxes from the snap-benchmark row cache),
`scripts/similar/similar-benchmark.py`. 340 exemplars (species with ≥ 3 boxes, up to 6 per species),
targets = the other boxes of that species in the segment. Runtime ~40 min (Perch dominates; cached).

| Method | AP | recall @ P ≥ 0.8 |
|---|---|---|
| NCC over the whole recording (band ±3 bins, freq shift ±2) | **0.52** | **0.40** |
| BirdBox as gate, scored by NCC | 0.34 | 0.12 |
| NCC + Perch 50/50 | 0.41 | 0.26 |

Found at any rank, by SNR third (quiet / middle / loud): NCC 0.81 / 0.84 / 0.82,
BirdBox-gated 0.66 / 0.81 / 0.86.

Region metric (interval contains a target centre): NCC 0.41, Perch 0.39 recall @ P ≥ 0.8;
top-400 recall 0.94 / 0.96. Not strictly comparable: a 5-s Perch window holds several calls.

Conclusions:
- NCC alone is the best basis for within-recording suggestions; it works equally for quiet calls.
- BirdBox as gate loses mainly quiet calls (0.66 vs 0.81) → only for refining bounds, never gating.
- Perch finds regions about as well as NCC, but the naive score mix hurts. Powdermill is a dense
  chorus, so a 5-s window rarely isolates one species. Perch stays for cross-recording search in Lite;
  if combined, use it as a second candidate source (union) rather than a score mix — not measured yet.
- Precision is the limit (40 % recall at 80 % precision): the review strip and negatives (step 2)
  matter more than a better first score.

## Step 1 as built

- `src/domain/similar/ncc.ts`: FFT, blockwise NCC (overlap-save), peak picking, `findSimilar`.
- `src/app/similarSpectrogram.ts`: band spectrogram via aw-dsp in blocks (yields to the UI), floor removed;
  `findSimilarOffThread` runs the correlation in `src/infrastructure/similar.worker.ts`.
- `src/app/suggest-similar.ts`: suggestion labels (set 'Similar calls', origin `Similar`, locked), skip own
  labels of the species and rejections, BirdBox bounds when a box matches; copies keep `adoptedFrom.similar`.
- `src/ui/components/similar-review/similar-review.ts`: review bar (Enter / X / Shift+Enter / ↑↓ / Space / Esc),
  threshold default 0.35. Start: `F` on the selected label or context menu "Find similar calls".
- Timing, 5-min recording: spectrogram 1.5–2.2 s (yielding), correlation 0.6–1.3 s (worker).
- Tests: `tests/similar-calls.test.mjs`; browser: `tools/e2e/similar-calls.py` (60-s Powdermill clip, all checks pass).

Open from step 1: suggestions look like normal labels (no dashed ghost style); the bar covers the label
tracks at the bottom; no thumbnails yet; threshold not calibrated (Powdermill scores mostly 0.2–0.6);
suggestions are saved with the session like BirdBox boxes; a search started before the recording finished
registering is cancelled silently.

## Steps

1. Correlation suggestions for one exemplar + review strip + provenance.
2. Negatives / re-ranking.
3. Overview clustering.
4. Perch in Lite (stage 1 + ranking), later cross-recording.
