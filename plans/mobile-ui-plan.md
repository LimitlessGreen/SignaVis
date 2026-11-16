# Mobile-/Tablet-UI – Plan

Stand: 2026-11-16 · Status: Phase 1–3 umgesetzt (Branch feat/mobile-ui-phase1)

## Ziel

SignaVis soll auf Tablet und Handy brauchbar sein. Das Layout richtet sich nach der Breite (und `pointer: coarse`), nicht nach dem Gerät.

**Umfang Handy (entschieden):** Prüfen, Anhören, Live-Erkennung und Analysieren vorhandener Aufnahmen.
Kein Box-Zeichnen und -Bearbeiten auf dem Handy. Gelabelt wird am Tablet oder Desktop.

## Befund (Playwright, Pixel 7 / iPad Mini)

- Handy: Das Desktop-Layout wird zusammengeschoben (zwei Activity-Bars, Sidebar und Player nebeneinander).
  Das Tipp-Fenster (`daily-tips.ts`) wird zu einer schmalen Spalte zerdrückt und liegt gleichzeitig mit dem Speicherort-Dialog (`project-location.ts`) auf dem Bildschirm.
- 36 von 42 sichtbaren Buttons sind kleiner als 36 px (Ziel für Touch: 44 px).
- Tablet quer: nutzbar, aber eng. Für „Shift + Drag“ und Hover gibt es auf Touch keinen Ersatz.
- Schon vorhanden: Pointer-Events, Pinch-Geste (`ui/components/gestures`, `PlayerState.ts`), einzelne `@media`-Regeln bei 700/900 px.

## Übernahmen aus BirdNET Live / Website

- Einstellungen in einer ausklappbaren Leiste (Drawer) statt als feste rechte Spalte.
- Eine Hauptaktion pro Ansicht mit großem Knopf (Live: Aufnahme starten/stoppen).
- Sonst nichts: Keins der beiden Projekte löst Labeln oder Box-Bearbeitung per Touch.

## Layouts

| Breite | Layout |
|---|---|
| < 600 px (Handy) | Player in voller Breite, Tab-Leiste unten (Projekt · Labels · Analyse · Live), Panels als Bottom Sheets (halb/ganz), Display/Audio-Einstellungen als Drawer |
| 600–1023 px (Tablet hoch) | Player oben, Panel als Sheet unten, Werkzeugleiste als eine Zeile über dem Spektrogramm |
| ≥ 1024 px (Tablet quer / Desktop) | wie bisher, aber nur ein Seitenpanel zur Zeit, über den Player gelegt bei < 1280 px |

Bei `pointer: coarse`: Tippflächen ≥ 44 px, größere Box-Griffe.

## Handy-Funktionen

- **Prüfen:** Labels und Detektionen (BirdNET, BirdBox) als Karten. Tippen spielt den Abschnitt ab, Wischen bestätigt oder verwirft. Bestehende Labels lassen sich umbenennen oder löschen, aber nicht geometrisch bearbeiten.
- **Anhören:** Spektrogramm scrollen (ein Finger) und zoomen (Pinch). Zeichnen ist aus.
- **Analysieren:** Analyse-Tab als Sheet: Aufnahme wählen (Datei, XC), Analyse starten, Ergebnisliste.
- **Live:** Mikrofon und laufendes Spektrogramm mit Trefferliste (Code darunter laut `detector-stream-plan.md` fertig). Ein großer Start/Stopp-Knopf.
- Ausgeblendet: Training, Scatter/Embeddings, Datensätze, Export-Details, Preset-Manager.

## Touch-Bedienung (Tablet)

- Ausdrücklicher Moduswechsel zwischen Verschieben/Zoomen und Zeichnen statt Shift.
- Alternativ: lange drücken und dann ziehen, um eine Box zu zeichnen.
- Kontextmenü per langem Druck.
- Nie zwei Fenster gleichzeitig: Tipps erst nach dem Onboarding, auf Touch-Geräten standardmäßig aus.

## Phasen

1. **Schnelle Korrekturen:** Tipps und Onboarding nicht gleichzeitig; Tipp-Fenster mit Mindestbreite; rechte Activity-Bar unter 600 px ausblenden; Tippflächen bei `pointer: coarse`.
2. **Gerüst für das Handy:** Breakpoint-Klasse am Root, Tab-Leiste unten, Bottom-Sheet-Komponente, Drawer für Display/Audio.
3. **Prüf-Ansicht:** Label- und Detektionskarten, Wisch-Aktionen, Zeichnen auf dem Handy aus.
4. **Live-Ansicht** (zusammen mit Schritt 3 aus `detector-stream-plan.md`).
5. **Tablet:** Moduswechsel, Zeichnen per langem Druck, Griffgrößen, Layout für hochkant.
6. **Tests:** Playwright-Screenshots für Pixel 7, iPad Mini hoch/quer als Regressionstest.

## Offen

- Bottom Sheet selbst bauen oder eine kleine Bibliothek verwenden (Vorschlag: selbst bauen, Pointer-Events sind vorhanden).
- Sollen Bestätigen/Verwerfen auf dem Handy direkt ins Projekt schreiben oder erst als Vorschlag markiert werden?
