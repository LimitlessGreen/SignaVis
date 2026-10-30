


## 1. Import Mapping

| XC Field(s) | AW Label | Notes |
|-------------|----------|-------|
| `start\|begin\|t0\|start_time` | `start` | seconds |
| `end\|stop\|t1\|end_time` | `end` | seconds |
| `freq_min\|low_freq\|f_low` | `freqMin` | Hz |
| `freq_max\|high_freq\|f_high` | `freqMax` | Hz |
| `scientific_name` | `scientificName` | |
| `sound_type\|type` | `tags.soundType` | fallback `label` |
| `sex\|Sex` | `tags.sex` | |
| `stage\|age\|life_stage` | `tags.lifeStage` | |
| `annotation_remarks` | `tags.remarks` | |
| `annotator\|annotator_name` | `author` | |

**Returns:** `{xcId, recording, rawLabels, labels[], recordingMeta}`

```json
// Normalized label
{
  "id": "xc123_lbl_1",
  "start": 12.34,
  "end": 13.57,
  "freqMin": 1000,
  "freqMax": 5000,
  "label": "Rufous-faced Warbler",
  "scientificName": "Abroscopus albogularis",
  "origin": "xeno-canto",
  "readonly": true,
  "author": "Annotator Name",
  "tags": {
    "sex": "male",
    "soundType": "song",
    "lifeStage": "adult"
  }
}
```

## 2. Export Payload (Annota-JSON Fv0)

Built by `buildAnnotaPayload()` in `src/infrastructure/xeno-canto/annotaPayload.ts`
(the XC panel resolves the active set + annotator profile and calls it).
Recording metadata (location, date, device) is **not** part of the payload — XC takes it from `xc_nr`.

```json
{
  "set_source": "",
  "set_uri": "",
  "set_name": "My annotation set",
  "annotation_software_name_and_version": "SignaVis 1.2.3",
  "set_creator": "Annotator Name",
  "set_creator_id": "ABCDEFGHIJ",
  "set_owner": "Org A, Org B",
  "set_license": "CC-BY-NC",
  "project_uri": "",
  "project_name": "",
  "funding": "",
  "set_remarks": "",
  "scope": [{ "taxon_coverage": "Aves", "completeness": "part" }],
  "annotations": [{
    "annotation_source_id": "slabel_k3j9x0aa",
    "xc_nr": "123456",
    "sound_file": "",
    "annotator": "Annotator Name",
    "annotator_xc_id": "ABCDEFGHIJ",
    "start_time": "12.340000",
    "end_time": "13.570000",
    "frequency_low": "1000.0",
    "frequency_high": "5000.0",
    "scientific_name": "Abroscopus albogularis",
    "sound_type": "song",
    "date_identified": "2026-10-29",
    "sex": "male",
    "life_stage": "adult",
    "animal_seen": "y",
    "playback_used": "n",
    "collection_date": "",
    "collection_specimen": "",
    "temperature": "",
    "annotation_remarks": "short remark",
    "overlap": ""
  }]
}
```

- `annotation_source_id` = stable label ID; `date_identified` = label `updatedAt`/`createdAt` (date).
- `frequency_low/high` are omitted when the label has no frequency range.
- `animal_seen`, `playback_used`, `overlap`: `y` / `n` / empty.
- `scope.completeness`: `all` | `part` (legacy `complete`/`partial` are mapped).
- `set_owner`: comma-separated list (exact XC format still to be confirmed with a real upload).

**Validation** (`validateAnnotaPayload`, mirrors XC "Verify"):
errors block the upload — `xc_nr`, `start_time`, `end_time`, `scientific_name`;
warnings — `set_name`, `set_creator`, `set_owner`, `set_license`, `annotator`, `frequency_low/high`,
`sound_type`, `sex`, `life_stage`, `annotation_remarks`.

**Import:** `original_set_metadata` is read as an array (Fv0) or a single object (older exports);
labels are grouped into one locked set per original set.

**Target:** `POST /api/3/upload/annotation-set`

## 3. API Usage

```js
// Import
importXenoCantoSpectrogramLabels("XC123456", {sampleRate: 44100})

// Export
const payload = buildAnnotationSetPayload(labels, sets, meta)
uploadToXenoCanto(payload, apiKey)
```

---

## !!! warning "Notes"

- Field aliases = **importer conveniences**, **not** official XC spec
- Time: `.toFixed(6)`, Freq: `.toFixed(1)`
- `annotationSet` metadata preserved on re-import
- Requires XC API key for upload