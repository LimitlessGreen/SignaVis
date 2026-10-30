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

### Phase 4 — Pitch-Shift (Rubberband vs. Signalsmith Stretch)
- Lizenz: Rubberband GPLv2+ ist AGPL-kompatibel; Signalsmith MIT.
- Desktop zuerst (Rust), WASM später. Vorher Hörvergleich an FM-Rufen (Transienten!).
- Einsatz: Echtzeit-Überblick (Pulsrate, Feeding Buzz, Sozialrufe), nicht Einzelruf-Analyse.
