# Fledermaus-Audio: Ultraschall hörbar machen

Stand: 2026-10-30 · Branch: spectrogram-v2

## Problem mit dem alten Ansatz

Das Dev-Panel „Audio“ (`demo/labeling-app.html`, `src/domain/audioTransforms.ts`) rechnete
ein neues WAV und lud es per `player.loadUrl()` als neue Aufnahme. Folgen:

- Spektrogramm, Zeit- und Frequenzachse wurden aus dem *bearbeiteten* Audio gebaut →
  Labels in falschen Koordinaten.
- `resampleDivider` war nur ein Downsampling (gleiche Dauer, Tiefpass) → Ultraschall wurde
  entfernt statt hörbar gemacht.
- Heterodyn = Ringmodulation (Summen + Differenz), fester Träger.

## Prinzip

Die Originalaufnahme ist die einzige Wahrheit für Spektrogramm, Labels und Koordinaten.
Hörbarmachen ist ein reiner **Abhörmodus** auf dem Weg zum Lautsprecher; der Playhead läuft
immer in Originalzeit.

## Phasen

### Phase 1 — Zeitdehnung (erledigt)
- `AudioEngine.setTimeExpansion(factor)`: WaveSurfer `setPlaybackRate(1/f, false)`
  (preservesPitch aus), Segment-/Bandpass-Wiedergabe via `AudioBufferSourceNode.playbackRate`;
  Bandpass-Mittenfrequenz wird durch f geteilt (Filter sitzt hinter der Quelle).
- Auswahl „×1 … ×16“ in der Transportleiste (`slowdownSelect`), Browser-Grenze 0.0625 → max ×16.
- Altes Panel + `audioTransforms.ts` entfernt.

### Phase 2 — Fledermausaufnahmen erkennen (erledigt)
- `src/domain/ultrasound.ts` (TypeScript statt Rust: nur Header-Parsing + 32 kleine FFTs,
  läuft so in Browser und Desktop gleich). Tests: `tests/ultrasound.test.mjs`.
- `parseGuano`: `guan`-Chunk → Key/Value; `TE` > 1 = schon zeitgedehnt gespeichert → kein Vorschlag.
- `analyzeUltrasound`: ab 64 kHz Samplerate die 32 Blöcke mit der meisten HF-Energie
  (Differenz-Energie als Proxy) per FFT; ultraschall wenn ≥ 30 % Energie > 18 kHz, oder GUANO
  bei ≥ 96 kHz. Vorschlag ×10, bei Peak > 70 kHz ×16.
- Beim Laden: Faktor zurück auf ×1, Event `ultrasoundinfo`, Chip „Ultrasound ≈ 45 kHz → ×10“
  in der Transportleiste; `player.ultrasoundInfo`, Event `timeexpansionchange`.
- Audio-Tab (rechte Sidebar, `buildAudioPanel` in `demo/labeling-app.html`): Methode,
  Verlangsamung, Erkennungsergebnis, Übernehmen-Button, GUANO-Metadaten.
- Testdaten: Xeno-Canto (Fledermäuse).

### Phase 3 — Detektor-Modi wie in der Feldarbeit (Rust, aw-dsp)
Ziel: anbieten, was Leute von Heterodyn- und Frequenzteiler-Detektoren kennen.

**3a erledigt:** `aw_dsp::detector` (heterodyne, frequency_division, division_noise_level),
WASM-Exports, `detectorRender.ts` (15-s-Abschnitte, Lead-in/-out für die Filter,
Raster der Dezimierung → 1:1 Originalzeit). Engine: `setListenMode`, Detektor-Wiedergabe über
den Web-Audio-Pfad (auch Label-Ausschnitte; Bandpass dort aus, der Detektor wählt das Band).
Transportleiste: ×1…×16 / Heterodyne / Freq. division; Audio-Tab mit Abstimmung, Teiler,
Hüllkurve. Abweichung vom Plan: Heterodyn als echte Mischung (Seitenbänder falten wie am
Gerät), nicht analytisch. Rauschschwelle des Teilers über die ganze Aufnahme geschätzt, sonst
bleibt ein reiner Ruf-Ausschnitt stumm.

**3b erledigt:** `CarrierLineController` — gestrichelte Linie bei der Trägerfrequenz,
ziehen oder Alt+Klick ins Spektrogramm stimmt ab (Raster 0,5 kHz, wirkt beim Loslassen).

**Heterodyn**
- Komplexe Mischung (analytisches Signal) ohne Spiegelfrequenz, Ausgabe 48 kHz.
- Nur den gespielten Abschnitt rendern; Zeitabbildung 1:1.
- Träger per Klick ins Spektrogramm, als ziehbare horizontale Linie.

**Frequenzteilung (Nulldurchgang)**
- Wie echte FD-Detektoren: Hochpass (~15 kHz), Nulldurchgänge zählen, alle n (Standard 10)
  den Ausgang umschalten → Rechtecksignal bei f/n, Echtzeit.
- Optional Hüllkurve des Originals aufprägen (manche Geräte tun das), sonst rauer Klang.
- Zeitabbildung 1:1, gleicher Wiedergabepfad wie Heterodyn.

UI: Moduswahl in der Transportleiste (Zeitdehnung / Heterodyn / Frequenzteilung / später
Pitch-Shift) mit dem jeweiligen Parameter (Faktor, Trägerfrequenz, Teiler).

### Phase 4 — Pitch-Shift in Echtzeit (erledigt)
- Eigener Phase-Vocoder in `aw_dsp::detector::pitch_shift` statt Rubberband/Signalsmith: beide
  sind C++ und nur mit Emscripten-Aufwand nach WASM zu bringen. Unser Fall (großer Shift nach
  unten, Tempo 1:1) erlaubt Synthese direkt bei 48 kHz: Eingangsframe = Ausgangsframe ×
  Dezimierung (2048 → 256 bei 384 kHz), Bin k → k/Faktor, Phasen-Akkumulation, 4× Overlap.
- Modus `{ kind: 'pitch', factor }` (÷4…÷32), Transport „Pitch ÷“, Audio-Tab.
- Alle Echtzeit-Modi rendern jetzt im Worker (`detector.worker.ts`): erster Abschnitt 1 s,
  danach 5 s, je 2 s vor Ablauf angefordert und lückenlos auf der AudioContext-Uhr angesetzt;
  Cache für Label-Loops. Browser-Test (384 kHz): Start 0,13–0,5 s, kein Unterlauf.
- Grenze: Rufe kürzer als ein Frame (~5 ms) werden etwas verschmiert; für die Rufform
  bleibt Zeitdehnung das Mittel der Wahl.
