# Plan: Call-Detector (NN-Boxdetektor) in die Workbench

Stand 2026-11-06. Modell und Training: Repo `call-detector` (Plan `../plans/call-detector-plan.md`,
Befunde `call-detector/docs/findings.md`). Ziel: ein Klick („Rufe erkennen“) zieht Boxen um alle Rufe
der Aufnahme bzw. des sichtbaren Ausschnitts, als eigene Label-Quelle, die man übernehmen/verwerfen kann.
Später Nachfolger bzw. Ergänzung von „Snap to call“.

## Ausgangslage

**Modell** (v14 field-epoch=8, Powdermill mit TTA 0,545 / 0,213, Just-Bird 0,382 / 0,202):
- WSL `CallDetector`: `~/data/models/v14/call_detector_fp32.onnx` (11,7 MB) und `call_detector_fp16.onnx`
  (5,9 MB, Box-Recall 1,0 gegen PyTorch), `export.json` mit Metadaten. Erzeugt mit
  `python -m call_detector.export.onnx <ckpt> --out <dir>` (FP16 = Conv+BN fusioniert, dann `.half()`).
  INT8 (PTQ) verworfen: 17–19 % Boxverlust (Ursache vermutlich riesige Neck-Aktivierungen) -> ggf. später QAT.
- Lizenz: eigenes Modell (kein Ultralytics/BirdBox-Code), Trainingsdaten XC (CC-Lizenzen je Aufnahme) + Zenodo
  (CC-BY) -> Modell-Lizenz/Attribution vor Auslieferung klären (Phase 6).
- Ggf. kommt ein kleineres Modell: v16 (`mobilenetv3_small` + Destillation, läuft auf Kaggle) bzw. v15 (GIoU).
  Plan ist modellunabhängig, Modell-URL + Metadaten aus `export.json`.

**ONNX-Schnittstelle**
- Eingang `spec` float32 `[1, 1, 128, T]`, T = Frames (100 fps, Export auf 1024 = 10,24 s aufgefüllt; dynamisch,
  T sollte durch 32 teilbar sein -> auf Vielfaches von 32 auffüllen, Auffüllung = 0).
- Ausgänge `peaks [1,1,32,T/4]` (Sigmoid × Maxpool-Peak-Maske, schon im Graph), `size [1,2,32,T/4]`
  (log Breite/Höhe in Eingangspixeln), `offset [1,2,32,T/4]`. Stride 4.
- Dekodierung (wie `call_detector.export.onnx.decode_np`): Top-K (100) der Peaks ≥ Schwelle, je Peak
  `cx = (ix + off_x) * 4`, `cy = (iy + off_y) * 4`, `w,h = exp(size)`, Box = cx ± w/2 (Frames), cy ± h/2 (Mel-Zeilen).
- Zeilen oberhalb der Nyquist-Frequenz der Quelle (`valid_bins`) im Training maskiert -> Peaks dort verwerfen.

**Eingangsspektrogramm = `call-detector/configs/spectrogram_v1.json`** (muss bitgenau zum Training passen):
32 kHz mono (soxr HQ resampelt), win/nFft 1024, hop 320 (100 fps), Hann, Mel 128 Bänder 50–16 000 Hz,
PCEN (T 0,4 / gain 0,98 / bias 2 / power 0,5), Ausgabe dB. Training rendert die GANZE Datei mit
`aw_dsp::v2` (PyO3) – PCEN-Zustand ab Dateianfang. Die Workbench hat dieselbe Engine als WASM:
`WasmStft(params_json)` + `blockValues(samples, first, f0, n, total)` mit PCEN-Warm-up
(`src-tauri/crates/aw-dsp-wasm/src/lib.rs`). Werte je Frame: 128 Zeilen tief -> hoch, Layout im Modell `[R, T]`.

**Workbench-Anknüpfung**
- Label-Quellen: `src/app/label-sources.ts` (`own`, `birdnet`, `xc-set:*`, `file:*`) -> neue Quelle `detector`.
- BirdNET-Browser-Inferenz als Vorbild: `src/infrastructure/birdnetInference.ts` (Worker, Modell per URL,
  Laufzeit vom CDN bzw. `vendorUrl` für Tauri).
- Snap to call: `src/domain/snapToCall.ts`, `src/app/snapPatch.ts`.
- Labels-Tab / Tabelle zeigen Quellen schon getrennt ([[labels-tab]], [[label-table-view]]).

## Phasen

### Phase 1 – Referenz und Paritätstest (call-detector-Seite)
- Skript `call-detector/scripts/export_reference.py`: für 2–3 kurze Aufnahmen (eine XC, eine Powdermill)
  Eingangs-Spektrogramm (`.f32`), Roh-Ausgänge und dekodierte Boxen (s, Hz, score) als JSON ablegen ->
  `Audio-Workbench/tests/fixtures/call-detector/`. Dient als Goldstandard für JS.
- Modell + `export.json` nach `Audio-Workbench/models/call-detector-v14/` (FP16 als Standard, FP32 optional).
  Größe prüfen (Git-LFS? bisher liegt `models/birdnet-v2.4` direkt im Repo) und wie BirdNET über GitHub Pages ausliefern.

### Phase 2 – Spektrogramm in der Workbench (WASM)
- `src/domain/callDetector/input.ts`: Audio -> 32 kHz mono (vorhandenes Resampling nutzen; Abweichung zu soxr
  messen), `WasmStft(spectrogram_v1)` über die ganze Aufnahme bzw. den Bereich + Warm-up -> `Float32Array [128, T]`.
- Paritätstest (vitest) gegen die Fixtures: max. Abweichung in dB; Ziel < 0,1 dB (PCEN-Warm-up vs.
  Ganzdatei-Render beachten). Erst wenn das passt, weiter.

### Phase 3 – Inferenz-Worker (onnxruntime-web)
- `src/infrastructure/callDetectorInference.ts`: Web-Worker mit `onnxruntime-web` (WASM-Backend Standard,
  WebGPU optional, Laufzeit wie TF.js per CDN bzw. `vendorUrl` lokal für Tauri/Lite).
- Kacheln 10,24 s (1024 Frames), Gleitfenster mit Überlappung 0,75 + WBF (beste TTA-Variante; 0,25 + NMS als
  „schnell“-Modus). WBF/NMS + Dekodierung nach `call_detector.train.module.merge_tiles/_wbf` portieren
  (`src/domain/callDetector/decode.ts`, `merge.ts`) – reine Funktionen, mit Fixtures testen.
- Umrechnung Frames -> s (hop 320 / 32 kHz) und Mel-Zeile -> Hz (Mel-Bandmitten aus `binFrequencies()`);
  Boxen am Nyquist der Quelle abschneiden.
- Fortschritt + Abbruch; Laufzeit messen (CPU ~110 ms je 10 s Kachel nativ -> 0,75 Überlappung = 4 Kacheln je 10 s;
  1 h Aufnahme im Browser grob Minuten -> Bereichsauswahl anbieten).

### Phase 4 – UI
- Button „Rufe erkennen“ (Analyse-Bereich neben BirdNET), Bereich: ganze Aufnahme / sichtbarer Ausschnitt.
- Schwelle (Standard 0,25 nach Kalibrierung v10: P 0,80 / R 0,25; 0,2 = P 0,69 / R 0,42 – für v14 neu
  kalibrieren) als Schieber, Live-Filter ohne neue Inferenz.
- Ergebnisse als Label-Quelle `detector` (read-only, eigene Farbe, Score sichtbar), „übernehmen“ (einzeln,
  alle ≥ Schwelle, in aktiven Layer) -> eigene Labels. Labels-Tab/Tabelle zeigen die Quelle.
- Optional Snap: Klick auf eine Detektor-Box übernimmt sie; später Snap-to-call per Modell (Box um Klick).

### Phase 5 – Desktop (Tauri) und Lite
- Zuerst denselben Web-Worker auch in Tauri nutzen (keine Rust-Abhängigkeit). Danach messen, ob `ort` (Rust)
  nötig ist (CPU-Threads, lange Aufnahmen); dann Tauri-Command mit `aw_dsp` nativ + `ort`.
- SignaVis Lite (`src-tauri-lite`): gleiches Modul, Modell gebündelt.

### Phase 6 – Abschluss
- Lizenz/Attribution des Modells (Datenquellen) in About/Docs, Modellversion in Export-Metadaten (wie
  Build-Version in XC-Sets).
- Doku (docs/), CHANGELOG, Smoke-Test im Browser durch den User.

## Offene Entscheidungen (User)
- Modell: v14 FP16 als Standard oder auf v15/v16 warten?
- Auslieferung: Modell im Repo/Pages-Bundle oder Download bei Bedarf?
- Sollen Detektor-Boxen direkt als eigene Labels entstehen oder immer erst als Vorschlags-Quelle?
