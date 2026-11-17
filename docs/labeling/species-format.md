# BirdNET taxonomy & Labeling App formats

This page documents the BirdNET species label source files and the JSON formats used by the Labeling App (taxonomy JSON and exported label objects).

## 1) Sources

The taxonomy is built from three sources (later ones win for names):

1. **BirdNET V2.4 label files** (optional, `--v24-labels`): `BirdNET_GLOBAL_6K_V2.4_Labels_<lang>.txt`,
   one `<scientific name>_<common name>` per line. Kept for languages V3 lacks (af, el, ro, th, …)
   and for species only V2.4 knows, so older labels still resolve.
2. **BirdNET taxonomy** (`https://birdnet.cornell.edu/taxonomy/api/download/json`, cached as
   `demo/data/cornell-taxonomy.json`): ~16 000 species with names, scientific synonyms, images and
   IDs for eBird, iNaturalist, GBIF, Xeno-canto and others.
3. **BirdNET+ V3.0 Global 12K labels** (Zenodo record 24162518, downloaded to
   `demo/data/BirdNET+_V3.0_Global_12K_Labels.csv`): the model's 11 725 classes with names in ~35 languages.

## 2) Generated taxonomy JSON (input for the Labeling App)

```
npm run taxonomy:build
# or
node ./scripts/build-birdnet-taxonomy.js --output ./demo/data/birdnet-taxonomy.json \
  [--v24-labels <BirdNET-Analyzer>/birdnet_analyzer/labels/V2.4] [--v3-labels <csv>] [--skip-images]
```

Top-level JSON structure produced:

```json
{
  "modelVersion": "BirdNET+ V3.0",
  "sourceUrl": "https://zenodo.org/records/24162518",
  "sources": ["BirdNET+ V3.0 Global 12K labels", "BirdNET taxonomy (birdnet.cornell.edu)", "BirdNET V2.4 labels"],
  "updatedAt": "2026-11-17T00:00:00.000Z",
  "languages": ["en_uk", "de", "fr"],
  "speciesCount": 11725,
  "extraCount": 4980,
  "records": [
    { "s": "Pseudacris regilla", "a": ["Hyliola regilla"], "n": { "en_uk": "Pacific Chorus Frog", "de": "Pazifischer Laubfrosch" },
      "birdnet_id": "BN25450", "taxon_group": "Amphibia" },
    { "s": "Zosterops borbonicus", "x": 1, "n": { "en_uk": "Reunion Grey White-eye" } }
  ]
}
```

Field mapping:
- `modelVersion` — the species list's BirdNET version (shown in the app footer).
- `speciesCount` — classes of the BirdNET+ V3.0 12K model; `extraCount` — further species (`x: 1`).
- `records[]`:
  - `s`: scientific name (key)
  - `a`: alternative scientific names (synonyms, V2.4 spelling); the resolver matches them too
  - `n`: language code → common name; names equal to `en_uk` are omitted (resolver falls back to `en_uk`)
  - `x: 1`: not a V3 class (V2.4-only or other BirdNET-taxonomy species), still available for manual labels
  - `birdnet_id`, `taxon_group`, `img*`: from the BirdNET taxonomy

Who consumes this JSON:
- The demo and Labeling App load `demo/data/birdnet-taxonomy.json` (see `demo/labeling-app.html`).
- `src/taxonomyResolver.js` expects the format shown above and provides lookup + fuzzy resolution by scientific name.

## 3) Label object format used by the Labeling App (export & runtime)

The Labeling App stores and exports annotations as plain JSON objects. The export function (`toLabelExport()` in the demo) produces this shape:

```json
{
  "labels": [
    {
      "id": "lbl_abc123",
      "label": "Rufous-faced Warbler",
      "scientificName": "Abroscopus albogularis",
      "commonName": "Rufous-faced Warbler",
      "start": 12.34,
      "end": 13.57,
      "freqMin": 1000,
      "freqMax": 5000,
      "color": "#aabbcc",
      "confidence": 0.87,
      "origin": "BirdNET",
      "author": "detector",
      "tags": { "sex": "male", "soundType": "song" }
    }
  ]
}
```

Field notes (types & semantics):
- `id` (string): annotation id. If missing the player generates one on normalize.
- `label` (string): display name shown in UI (usually the localized common name).
- `scientificName` (string): canonical scientific name (Genus species).
- `commonName` (string): localized common name (redundant with `label` but preserved).
- `start` / `end` (number): seconds, required for meaningful annotations; normalized to valid ranges by the player.
- `freqMin` / `freqMax` (number): Hz; optional — normalized by the player to sensible bounds.
- `color` (string): CSS color or hex used for overlays.
- `confidence` (number): optional 0..1 score (e.g. from detectors like BirdNET).
- `origin` / `author` (string): provenance metadata (e.g. `BirdNET`, `xeno-canto`, `manual`).
- `tags` (object): user-defined key/value pairs (preset keys include `sex`, `lifeStage`, `soundType`, etc.).

Normalization behaviour:
- The player normalizes missing ids, clamps `start`/`end` and `freqMin`/`freqMax`, and assigns a fallback `color` when none is provided.
- See `src/BirdNETPlayer.js` / `_normalizeLinkedLabel` for exact rules.

## 4) UI taxonomy (player presets)

Separately from the large BirdNET taxonomy, the player supports a small `labelTaxonomy` array used for quick presets (toolbar / numeric shortcuts). The expected shape is:

```json
[ { "name": "Species A", "color": "#ef4444", "shortcut": "1" },
  { "name": "Noise",     "color": "#ef4444", "shortcut": "4" } ]
```

- `name` (string): label shown on the preset button.
- `color` (string, optional): overlay color.
- `shortcut` (string, optional): single-digit string `"1".."9"` that maps to numeric keyboard shortcuts.

The player will normalize this list (keeps up to 9 items) and `applyTaxonomyToLabel()` uses either an index or the `shortcut` value to apply a preset to the focused label.

## 5) How to regenerate / update the taxonomy JSON

- Locally (V2.4 labels from a BirdNET-Analyzer checkout in `_birdnet_upstream`; V3 labels and the BirdNET taxonomy are downloaded):

```
npm run taxonomy:build
```

This runs `scripts/build-birdnet-taxonomy.js` and writes `demo/data/birdnet-taxonomy.json`.
- There is also a CI workflow `.github/workflows/update-birdnet-taxonomy.yml` that can update the file automatically in the repository.

## 6) Migration / differences summary

- BirdNET original files are per-language plain text maps (`scientificName_commonName`).
- The build script consolidates them into a single JSON used by `TaxonomyResolver`.
- The Labeling App consumes that JSON for name resolution and search, but uses a distinct small `labelTaxonomy` for quick presets.
- Annotation exports are plain JSON objects (see section 3) and include both display & scientific names plus time/frequency ranges and optional tags.

---

If you want, I can:
- add example JSON files into `demo/data/` (small samples),
- or add a short conversion example and a minimal script to produce a flattened list of {name, scientificName, color} for UI presets.
