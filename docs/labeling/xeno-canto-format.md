


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

## 2. Export Payload

```json
{
  "set_name": "My annotation set",
  "set_creator": "Annotator Name",
  "set_license": "CC-BY-NC",
  "recording_context": {
    "latitude": "51.5",
    "longitude": "-0.1",
    "recording_date": "2026-04-22",
    "recording_time": "12:34"
  },
  "annotations": [{
    "annotation_source_id": "1",
    "xc_nr": "XC123456",
    "annotator": "Annotator Name",
    "annotator_xc_id": "xcuser",
    "start_time": "12.340000",
    "end_time": "13.570000",
    "frequency_low": "1000.0",
    "frequency_high": "5000.0",
    "scientific_name": "Abroscopus albogularis",
    "sound_type": "song",
    "sex": "male",
    "life_stage": "adult",
    "annotation_remarks": "short remark"
  }]
}
```

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