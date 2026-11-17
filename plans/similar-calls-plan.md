# Similar calls: label one, confirm the rest

Status: steps 1–4 built (2026-11-17), branch `feat/similar-calls`, not pushed.

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
top-400 recall 0.94 / 0.99 (rerun after review: overlapping Perch windows suppressed to one per 2.5 s; recall @ P ≥ 0.8
unchanged, top-400 was 0.96). Not strictly comparable: a 5-s Perch window holds several calls.

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

Polish after step 1: suggestions have a dotted frame (own = solid, imported = dashed); the bar sits at the
bottom of the spectrogram; ✗ on a suggestion box rejects it; F on a suggestion searches again from its exemplar.

## Step 2 as built: re-ranking with decisions

Simulated review (`scripts/similar/rerank-sim.py`, 3 Powdermill segments, 87 exemplars, 150 candidates each;
the simulated user accepts true repeats, rejects the rest):

| Strategy | found after 5 | after 10 | after 20 reviewed |
|---|---|---|---|
| fixed order (step 1) | 3.62 | 6.40 | 10.05 |
| re-rank, λ = 0.5 | 4.01 | 7.01 | 11.24 |
| re-rank, λ = 1 | **4.11** | **7.17** | **11.34** |

rank = max(similarity to exemplar and accepted) − λ · max(0, similarity to rejected); similarity = Pearson r of
the two patches, best over ±1 row / ±2 frames. Built with λ = 1: `Reranker` / `createSearch` in
`domain/similar/ncc.ts`; the worker keeps the spectrogram for the session (`SimilarSession` in
`app/similarSpectrogram.ts`), each decision returns new ranks (~0.1–0.2 s), the review re-sorts and moves on to
the new best unless the user has stepped with ↑/↓. The threshold applies to ranks, `similar.score` keeps the first
correlation score. In the browser clip one accepted song lifted 6 suggestions above 0.25 (before: 2).

Open: no thumbnails; threshold not calibrated; suggestions are saved with the session like BirdBox boxes;
undo of a copy restores the suggestions but not the review; own labels of the species found before the search
are not used as extra exemplars yet.

## Step 3 as built: overview (groups of similar calls)

Simulated on Powdermill (`scripts/similar/cluster-sim.py`, 9 segments): a group is named in one action with its
majority species, strays fixed one by one; effort relative to labelling each candidate. Patch = box ±margin
resampled to 16 × 24, cells below the floor as 0 dB; distance = 1 − r + 0.3·|Δ log duration| + 1.0·|Δ log centre freq|;
average linkage.

| Candidates | cut 0.8: effort / purity | cut 1.0 | cut 1.2 |
|---|---|---|---|
| annotated boxes (perfect finder) | 0.44 / 0.98 | **0.27 / 0.92** | 0.27 / 0.79 |
| BirdBox boxes | 0.58 / 0.95 | **0.43 / 0.84** | 0.36 / 0.71 |

Without the duration / frequency terms groups mix far more (BirdBox, cut 0.8: purity 0.77). Default cut 1.0, slider
0.6–1.4 in the bar. Calls BirdBox misses are not in the overview; F finds them from a labelled one.

Built: `domain/similar/cluster.ts` (features, NN-chain average linkage = scipy fcluster 'distance', groups with medoid),
`callPatches` in `app/similarSpectrogram.ts` (STFT around each box, floor = row median of ±0.5 s),
`ui/components/similar-review/group-review.ts`. Analyse → Call boxes → "Group similar calls": BirdBox boxes no own
label covers are grouped; the bar walks the groups largest first (↓/↑, Space, X skip, Esc); the current group shows
as dotted suggestions "Group n"; Enter names it (template species, else the name dialog) and opens the member review
(Shift+Enter copies, X rejects strays); after it the next group follows. Copies keep `adoptedFrom.similar.group`.
Tests: `tests/similar-groups.test.mjs`; browser: `tools/e2e/similar-groups.py` (annotated boxes as BirdBox boxes;
first group 4 WOTH + 1 EATO, stray rejected, all checks pass).

Open: the BirdBox box is drawn under the group box; grouping runs on the main thread (O(n²), fine for a few hundred
boxes); no own labels as seeds yet.

## Step 4 as built: other recordings, Perch in Lite

Perch inside one recording, measured again (`similar-benchmark.py`, BOOSTS): score = NCC + β · (Perch similarity of the
window − the recording's median) gives AP 0.52 → 0.53 / 0.52 / 0.49 and recall @ P ≥ 0.8 0.40 → 0.41 / 0.41 / 0.36 for
β = 0.1 / 0.25 / 0.5: no real gain, so **Perch is not used within a recording**. Its place is choosing recordings.

Built: a label's patch travels as a template (`templateFrom`, `fitTemplate` resamples onto another STFT grid /
sample rate, `findWithTemplate`, `createSearch(spec, { template })`). Context menu "Look for it in other recordings":
every recording opened next is searched once, the review opens with the label's species (`adoptedFrom.similar.sourceLabelId`
= the label in the first recording). Lite + folder project: "Find similar in project (Perch)" carries the label and runs
the Similar panel's Perch search for it (`SimilarPanel.searchFor`); opening a hit runs the template search there.
"Stop looking for …" ends it. Browser check (`tools/e2e/similar-carry.py`): Wood Thrush label from Powdermill recording 1,
in recording 2 (another day) 5 of 5 suggestions are Wood Thrush songs. Lite itself not run here (no Rust toolchain on
PATH): the Perch entry is untested in the app.

## Steps

1. Correlation suggestions for one exemplar + review strip + provenance.
2. Negatives / re-ranking.
3. Overview clustering.
4. Perch in Lite (stage 1 + ranking), later cross-recording.
