# Plan: Stream-Erkennung, Fusion und Pacer (aus der BirdNET-Website)

Stand 2026-11-16. Quelle: `birdnet-team/birdnet-website`, `public/js/demo/` (MIT, © 2025/2026 BirdNET-Team),
lokal unter `BIRD-Workspace/external/birdnet-website`. Ergänzt `call-detector-integration-plan.md`
(Phasen 3 und 4) — ersetzt ihn nicht.

## Ziel

Boxdetektoren (BirdBox Just-Bird, eigener call-detector) laufen fensterweise als Stream:
Boxen erscheinen während der Erkennung, Regler (Konfidenz, Phrasenlücke) wirken sofort ohne
neue Inferenz, Fortschritt läuft gleichmäßig. Alles als Domain-Module ohne UI, damit SignaVis
später auch den Player der Website ersetzen kann (die Logik ist dann identisch).

## Was übernommen wird

| Website-Datei | Neu in SignaVis | Art |
|---|---|---|
| `birdbox-fusion.js` | `src/domain/detector/fusion.ts` | Port nach TS, generalisiert |
| `birdbox-pacer.js` | `src/domain/detector/pacer.ts` | Port nach TS, unverändert |
| `birdbox-stream.js` | `src/domain/detector/stream.ts` (Fensterplanung, Rows, „final ab“) + `src/infrastructure/detector/birdboxGraph.ts` | aufgeteilt |
| `birdbox-worker.js`, `ort-pool.js` | `src/infrastructure/detector/detector.worker.ts` | Muster, nicht 1:1 |
| `recording-time.js` | — | schon übernommen (`domain/recordingTime.ts`) |

Nicht übernommen: `spec-view.js` (eigener Viewer bleibt; nur Ideen, s. unten), Tab-UI, i18n.

## Kernidee: Rohzeilen einmal, Fusion beliebig oft

1. Der Detektor läuft pro Fenster **einmal bei niedrigster Konfidenz** und liefert Rohzeilen.
2. NMS lässt nur stärkere Boxen schwächere unterdrücken → Filtern der Rohzeilen nach Schwelle
   == Lauf mit dieser Schwelle. Fusion danach reproduziert die Modell-Ausgabe für jede Einstellung.
3. Fusion ist lokal in der Zeit → bei Lücken > Linkweite wird stückweise fusioniert und
   abgeschlossene Teile gecacht (wichtig für lange Aufnahmen und Live).

### Datenformat

```ts
// Eine Rohzeile, unabhängig vom Modell (BirdBox raw_all hat genau diese 9 Spalten)
interface RawRow {
  window: number;        // Fensterindex
  t0: number; t1: number;          // s, absolut
  fLo: number; fHi: number;        // Hz
  score: number;
  cls: number;           // -1/0 = "Vogel" bei Just-Bird
  windowStart: number;   // s
  fileEnd: number;       // s, wächst bei Live-Aufnahme
}
// gespeichert als Float32Array mit 9 Spalten (spart GC bei 10^5 Zeilen)

interface FusionParams {
  conf: number;          // Schwelle
  phraseGap: number;     // s; 0 = Rufe einzeln, nur Überlappung ≥ 0,05 s verbindet
  // modellspezifisch, Default = BirdBox:
  ownFraction: number;   // 0,25–0,75 des Fensters "besitzt" eine Box (Mitte)
  wbfIou: number;        // 0,4
  joinFreqIou: number;   // 0,8
  nestedRatio: number;   // 0,8
}
```

`fuseBoxes(rows, params, cache?) -> Box[]` als reine Funktion, float32-genau wie das Original.

### Generalisierung für den call-detector
Unser Modell: Kacheln 10,24 s, Überlappung 0,75, eigenes WBF (`merge_tiles/_wbf`). Zwei Wege:
- **A (empfohlen):** Fensterbesitz + WBF parametrisieren (`ownFraction`, `wbfIou`), Join/Nested
  gleich lassen. Paritätstest gegen `call_detector.train.module.merge_tiles` mit den Fixtures aus
  Phase 1 des Integrationsplans. Weicht es ab → B.
- **B:** `Fusion`-Interface mit zwei Implementierungen (`birdboxFusion`, `callDetectorMerge`),
  gemeinsam bleiben Rows, Cache-Teilung und Pacer.

## Stream-Ablauf

```
AudioSource (Datei | Live-Mikro)
  └─ BlockSource: liefert Audio blockweise an den Worker (keine Kopie der ganzen Datei)
      └─ Worker: Spektrogramm-Frames inkrementell → Fenster sobald Frames da → Rohzeilen
          └─ Main: Pacer gibt Fenster gleichmäßig frei → fuseBoxes (inkrementell, Cache)
              └─ Label-Quelle `detector` → Overlay im Viewer
```

- **"final ab"**: Ein Fenster ist endgültig, sobald das Audio sein Ende erreicht (BirdBox nimmt die
  Rauschschwelle aus den 60 s *vor* Fensterende). Für unseren call-detector gilt das wegen PCEN ab
  Dateianfang genauso → Live-Modus liefert dasselbe Ergebnis wie die gespeicherte Datei.
- Box gilt als "gesetzt", wenn sie `SETTLED + phraseGap` hinter der Erkennungslinie liegt → erst dann
  in den Cache / editierbar.
- Abbruch: bisherige Rohzeilen bleiben; CSV/Raven exportierbar als Teilergebnis, Annota nur bei
  kompletter Aufnahme (Hinweis wie auf der Website).

## Pacer
1:1-Port (≈130 Zeilen, `HAND_MS 600`, `FOLLOW 0,05`, `CORRECT 0,03`, `MIN_STEP_MS 50`, `SHARE 0,25`).
Testbar ohne Browser mit simuliertem Worker (Vorbild: BirdBox `tests/js/demo_pacer.mjs`).

## Artvorschlag je Box (Phase 2)
BirdNET (vorhanden: `birdnetInference.ts`) bewertet dieselben Fenster nebenher; Box bekommt die Art
mit dem höchsten Score im überlappenden Fenster (≥ 0,35, sonst "unbestimmt", Liste bleibt).
Geänderte/neu gezeichnete Boxen → nur diese neu bewerten.

## UI-Ideen von der Website (klein, einzeln umsetzbar)
- Neue Boxen ploppen kurz ein (420 ms) → man sieht, was dazukommt.
- Herausgezoomt: Spalte = Maximum der Frames dahinter (kurze Rufe bleiben sichtbar). Prüfen, ob
  unser Kachel-Renderer das schon tut.
- Live: Spektrogramm läuft von rechts, Wegscrollen stoppt Folgen, Knopf "Zurück zu live".
- Annotator-Angaben (Name, XC-ID, Lizenz) für den nächsten Export merken.
- Hilfe-Overlay nur beim ersten Mal.

## Phasen

1. **fusion.ts + Tests** — Fixtures: auf der Website (oder BirdBox Python) für 2–3 Dateien `raw_all`
   und fusionierte Ausgaben bei mehreren (conf, gap) exportieren; vitest vergleicht bitgenau.
2. **pacer.ts + Tests** — simulierte Worker-Zeiten, gleichmäßige Abstände prüfen.
3. **stream.ts** — Fensterplanung, `readyWindows`, `analyzedTo`, Cache-Teilung; reine Funktionen.
4. **Worker + BirdBox-Graph** — onnxruntime-web, Modelle wie `fetch-models.mjs` aus dem BirdBox-Modell
   (spectrogram + detect). Lizenz BirdBox-Modell klären.
5. **Anbindung call-detector** — Weg A/B entscheiden (Paritätstest), dann Integrationsplan Phase 3/4
   darauf aufsetzen.
6. **UI** — Regler live, Pop-in, Teilexport, später Live-Modus.

## Entscheidungen 2026-11-16
- BirdBox-Modell wird in SignaVis angeboten (User sollen es testen können) → Phase 4 fest eingeplant.
- Live-Modus wird mitgeplant (s. unten).
- Referenzstand: BirdBox `24632a5` (= von der Website gepinnt, Just-Bird_fp16 SHA-256 `34b5720c…`).
  Fusion/Pacer dort identisch mit der Website.

## Live-Modus
Ablauf wie Datei, nur wächst die Quelle:
- **Audio:** `AudioWorklet` (Vorbild `recorder-worklet.js`) → Ringpuffer → 32 kHz (Resampler wie
  `resample.js`/`StreamConverter`) → `BlockSource` wächst; Aufnahme parallel als WAV gesichert.
- **Erkennung:** Fenster laufen, sobald ihr Ende da ist (`readyWindows`), höchstens
  `LIVE_MAX_WINDOWS` (8) je Lauf, damit ein Rückstand aufgeholt wird; Hinweis ab 6 s Rückstand.
  BirdBox-Rauschschwelle aus den 60 s vor Fensterende (`RollingFloor`) → Boxen sind sofort endgültig.
- **Fusion:** `fuseBoxes(raw, rows, conf, gap, cache, later = nächster Fensterstart)`; `fileEnd`
  (Spalte 8) wächst — bei Aufnahmeende ändern sich die letzten Zeilen → Cache verwirft automatisch
  (`sameRows`), Ergebnis = das der gespeicherten Datei (Paritätstest wie BirdBox `rolling_floor_live.mjs`).
- **Kein Pacer** im Live-Modus (der Takt kommt vom Mikrofon).
- **Viewer:** Spektrogramm läuft von rechts (Spanne 20 s, rechter Rand `LIVE_EDGE` 0,13 s hinter dem
  Mikro), Wegscrollen stoppt Folgen, Knopf „Zurück zu live“. Erst prüfen, ob der Spektrogramm-Renderer
  von SignaVis inkrementell anhängen kann (WASM-STFT mit PCEN-Zustand → ja, `blockValues` mit Warm-up).
- **Tauri/Lite:** Mikrofon-Freigabe in WebView2/WKWebView/WebKitGTK prüfen (Phase-0-Matrix von Lite erweitern).

## Stand
- Phase 1: `src/domain/detector/fusion.ts` + `tests/detector-fusion.test.ts`; Fixtures per
  `scripts/birdbox/make-fusion-fixtures.mjs --birdbox=<Checkout @24632a5>` (Graph = Referenz,
  BirdBox `tests/test.wav`, erste 120 s, 4 conf × 4 gap).
- Phase 2: `src/domain/detector/pacer.ts` + `tests/detector-pacer.test.ts` (Port von `demo_pacer.mjs`), grün.
- Phase 3: `src/domain/detector/birdboxStream.ts` (Fensterplanung, `BlockSource`, `Frames`, `RollingFloor`, `finishRows`) + `tests/detector-birdbox-stream.test.ts`, grün. `StreamGraph` (ONNX-Sitzungen, `run`/`live`) folgt in Phase 4 unter `infrastructure/detector/`.
- Phase 4:
  - `scripts/birdbox/fetch-model.mjs` (`npm run models:birdbox`): Just-Bird_fp16 von BirdBox
    `24632a5` holen, SHA-256 prüfen, Cache `.cache/birdbox/`, in `spectrogram.onnx` (1,2 MB) +
    `detect.onnx` (19 MB) zerlegen (`lib/stream-graphs.mjs`, aus `fetch-models.mjs` der Website) →
    `models/birdbox-just-bird/` + `model_config.json`. Pages-CI ruft es vor dem Demo-Build (mit Cache).
  - `src/infrastructure/detector/birdboxGraph.ts` (`BirdBoxGraph.run`/`live`, ORT wird hineingereicht),
    `birdbox.worker.ts` (Vite-Modul-Worker, ORT per `vendorUrl` wie BirdNET), `birdboxDetector.ts`
    (Hauptthread: Blöcke an den Worker, Rohzeilen sammeln, Live mit `stop()` = Rest wie Datei).
  - Paritätstest `npm run test:birdbox-stream -- --audio=<BirdBox>/tests/test.wav`: Stream (Datei
    1 Fenster/Lauf, BlockSource 4/Lauf, Live in ungleichen Stücken) == Rohzeilen des ganzen Graphen.
  - **Befund:** onnxruntime-web 1.20.1 vs. 1.30.0 ändert FP16-Ergebnisse leicht (~1e-4, eine Box nahe
    0,05 mehr). Mit gleicher Laufzeit ist der Stream exakt. Fixtures deshalb mit der Laufzeit von
    SignaVis (1.30.0) erzeugt; Version steht in der Fixture, Paritätsskript warnt bei Abweichung.
  - Noch offen: Browser-Test des Workers (Vite `?worker&inline` im Demo-, Lib- und Lite-Build).

## Auslieferung des Modells (Entscheidung 2026-11-16)
- Nicht ins Repo (21 MB, AGPL-Gewichte fremder Herkunft): beim Build holen, per SHA-256 an den
  BirdBox-Commit gebunden, wie die BirdNET-Website.
- Web/Pages: liegt unter `/SignaVis/models/birdbox-just-bird/`, wird erst beim ersten Klick auf
  „BirdBox testen“ geladen (HTTP-Cache; später ggf. Cache Storage mit Hash wie `model-store.js`).
- Lite/Desktop: gleiche URL bei Bedarf (offen: mitliefern, wie bei der Paketgrößen-Frage in Lite).
- Lizenz: Gewichte AGPL-3.0 (BirdNET-Team) — passt zu SignaVis (AGPL-3.0-only). Hinweis in About/Docs
  mit Link auf BirdBox und den Commit; Modellname + Commit in Export-Metadaten.

## Lizenz
Website-Code MIT → in AGPL-SignaVis zulässig. Kopfkommentar je portierter Datei wie in
`recordingTime.ts` ("Adapted from … MIT License, Copyright (c) 2025 BirdNET-Team"), Eintrag in
`THIRD_PARTY`/About.

## Offene Entscheidungen
- Fusion für den call-detector: Weg A oder B — erst nach Paritätstest mit dessen Fixtures.
- Lite: BirdBox-Modell mitliefern oder bei Bedarf laden?
