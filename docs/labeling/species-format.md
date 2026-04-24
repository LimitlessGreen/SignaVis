# BirdNET taxonomy & Labeling App formats

This page documents the BirdNET species label source files and the JSON formats used by the Labeling App (taxonomy JSON and exported label objects).

## 1) Source: BirdNET-Analyzer label files

- Location used by the build script: [BirdNET-Analyzer/birdnet_analyzer/labels/V2.4](BirdNET-Analyzer/birdnet_analyzer/labels/V2.4)
- File name pattern: `BirdNET_GLOBAL_6K_<MODEL>_Labels_<lang>.txt` (e.g. `BirdNET_GLOBAL_6K_V2.4_Labels_en_uk.txt`).
- Line format: each non-empty line is a single mapping using the first underscore (`_`) as separator: `<scientific name>_<common name>`.

Example line:

```
Abroscopus albogularis_Rufous-faced Warbler
```

Notes:
- The scientific name may contain spaces (genus + epithet). The build script splits at the first underscore so the left side is the scientific name and the right side is the localized common name.
- The project contains a helper script that parses these files and writes a machine-friendly taxonomy JSON (see next section).

## 2) Generated taxonomy JSON (input for the Labeling App)

The script `scripts/build-birdnet-taxonomy.js` converts the per-language text files into a single JSON payload. Example invocation (also available as an npm script):

```
npm run taxonomy:build:local
# or
node ./scripts/build-birdnet-taxonomy.js --source ../BirdNET-Analyzer/birdnet_analyzer/labels/V2.4 --output ./demo/data/birdnet-taxonomy.v2.4.json --model V2.4 --source-url <url>
```

Top-level JSON structure produced:

```json
{
  "modelVersion": "V2.4",
  "sourceUrl": "https://github.com/..",
  "updatedAt": "2024-01-01T00:00:00.000Z",
  "languages": ["en_uk", "de", "fr"],
  "speciesCount": 6123,
  "records": [
    { "s": "Abroscopus albogularis", "n": { "en_uk": "Rufous-faced Warbler", "de": "..." } },
    { "s": "Abroscopus schisticeps", "n": { "en_uk": "Black-faced Warbler" } }
  ]
}
```

Field mapping:
- `modelVersion` (string) — BirdNET model version.
- `sourceUrl` (string) — origin of the source label files.
- `updatedAt` (ISO string) — build timestamp.
- `languages` (array) — language codes available in `records[].n`.
- `speciesCount` (number) — number of species records.
- `records` (array) — each record has:
  - `s` (string): scientific name (used as the key)
  - `n` (object): keyed by language code → localized common name

Who consumes this JSON:
- The demo and Labeling App load `demo/data/birdnet-taxonomy.v2.4.json` (see `demo/labeling-app.html`).
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

- Locally (requires a checkout of BirdNET-Analyzer at `../BirdNET-Analyzer`):

```
npm run taxonomy:build:local
```

This runs `scripts/build-birdnet-taxonomy.js` and writes `demo/data/birdnet-taxonomy.v2.4.json`.
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
