# Mobile-UI – Plan und Stand

Stand: 2026-11-16 · Branch `feat/mobile-ui-phase1` (lokal, noch nicht gepusht, kein PR)

## Entscheidungen

- **Umfang Handy:** Prüfen, Anhören, Live-Erkennung, Analysieren vorhandener Aufnahmen.
  Kein Box-Zeichnen/-Bearbeiten auf dem Handy (bleibt Tablet/Desktop).
- **Übernehmen/Verwerfen auf dem Handy:** im Design vorgesehen (✓/✕ auf den Karten), **noch nicht einbauen**.
- **Eigene Handy-Oberfläche** statt der Desktop-Oberfläche mit Tab-Leiste/Sheets (Phase-2/3-Ansatz verworfen:
  Seitenleisten als Overlay bzw. Sheets „nicht mobiltauglich“).
- **Design:** Mockup `plans/mobile-design/mockup.html` / `mockup.png` (6 Bildschirme). Anordnung aus Entwurf v1,
  aber kantiger (Radien 4–8 px) und kompakt, SignaVis-Farben aus `tokens.css`, echte Artbilder.
  Abgelehnt: sehr runder „typisch AI“-Look (v1) und der desktopnahe Stil (v2).
- **Label-Darstellung Handy:**
  - Boxen (BirdBox, eigene Labels): durchgehender Rahmen, leichte Füllung, Namensschild über der Box.
  - BirdNET (nur Zeitfenster): Lane-Strategie des Desktops (`_assignLanes`) – überlappende Fenster stapeln
    ihre Schilder; nur das aktuelle Fenster schattiert die Spalte (unter dem Abspielkopf nur Ränder,
    ausgewählt gefüllt).
- **Desktop:** keine gestrichelten Rahmen für BirdNET/BirdBox-Erkennungen, ✓/✕ auf Erkennungen sichtbar
  (✓ kopiert nach „Meine Labels“). Nur XC-Importe bleiben gestrichelt.
- **Arten-Tab:** Artenliste über alle Aufnahmen (bestätigt / erkannt / Aufnahmen), bester Beleg zum Anhören.

## Umgesetzt (Commits auf dem Branch)

| Commit | Inhalt |
|---|---|
| `e29c485` | Phase 1: Touch-Größen (`_touch.scss`), Tipp-Dialog nicht über Onboarding |
| `38da8b5` | Eigene Handy-UI `src/ui/mobile/mobile-app.ts`: Aufnahmen, Prüfen (Player eingebettet, Transportzeile, Erkennungsliste) |
| `705fafc`, `de386c2` | BirdNET als Bänder nach Lane-Strategie, 10-s-Ansicht, Spuren scrollen |
| `00b9418` | Analysieren (steuert die Desktop-Analyse-Controls, BirdNET → BirdBox nacheinander); Box-Optik |
| `0651634` | Desktop: Erkennungen ohne gestrichelte Rahmen, ✓/✕ zurück (`spectrogramlabeladopt`) |
| `50e33ab` | Arten |
| `3a8046f`, `712c87d` | Mockups |

Screenshots vom Stand: `plans/mobile-design/stand-schritt1.png`, `stand-analysieren.png`, `stand-arten.png`.

## Architektur (kurz)

- `PHONE_QUERY` = `(max-width: 600px), (pointer: coarse) and (max-height: 500px)` → `html.is-mobile`.
- `MobileApp` hängt `#playerRoot` in den Prüfen-Bildschirm um (zurück beim Verlassen); CSS in
  `src/styles/components/_mobile-app.scss` blendet Desktop-Chrome im Player aus.
- Daten über den Host in `demo/labeling-app.html` (`new MobileApp({...})`): `recordingManager`, `state.labels`,
  `resolveName`, `activateRecordingEntry`, `analysis` = Elemente des Desktop-Analyse-Panels.
- Aktualisierung: `labelList.render` und `recordingManager`-Events rufen `mobileApp.refresh()`.

## Ablauf-Überarbeitung (2026-11-16)

- **Prüfen-Tab = Warteschlange:** offene Treffer über alle Aufnahmen, je Aufnahme nach Art gruppiert; Tipp öffnet
  die Aufnahme an der Stelle. Badge = offene Treffer gesamt.
- **✓/✕ auf dem Handy gebaut:** ✓ kopiert nach „Meine Labels“ (`adoptOneLabel`), ✕ entfernt; beides mit
  Rückgängig-Leiste; danach springt die Wiedergabe zum nächsten offenen Treffer. Filter „Offen / Alle“.
  „Offen“ = Erkennung ohne Kopie mit `adoptedFrom.id`. Host: `acceptLabel`, `discardLabel`, `restoreLabel`.
- **Automatische Analyse** nach „Neu“ und nach Live-Stop (aktuelle Einstellungen), Fortschritt als Leiste im
  Prüfen-Bildschirm; Live-Stop landet direkt im Prüfen.
- Aufnahmen-Karten zeigen „x offen“ bzw. „✓ geprüft“; Arten zählt übernommene Erkennungen nur einmal.

## Offen / nächste Schritte

1. **Live** — gebaut (Screenshot `mobile-design/stand-live.png`): Mikrofon (`LiveRecorder.ondata`), laufendes
   Spektrogramm (`LiveSpectrogramView`, 15 s), Pegel, BirdNET alle 3 s (`BirdNETPanel.prepareLive`, Ortsfilter
   mit heutigem Datum), Artenliste (zuletzt gehört, Anzahl, max. %), Stop = speichern ins Projekt, „Verwerfen“.
   Offen: BirdBox-Boxen im Live-Spektrogramm (`BirdBoxDetector.startLive`, braucht 32-kHz-Resampler),
   Ort-Chip mit Namen, Tap auf Art → Stelle in der Aufnahme, Test auf dem Pixel.
2. **Aufnahmen-Karten:** Mini-Spektrogramm; „Neu“-Menü mit Xeno-canto und Mikrofon (bisher nur Datei).
3. **Arten:** Spektrogramm-Ausschnitte bei den Belegen; anzeigen, welcher Beleg gerade läuft.
4. **Prüfen:** Sheet hochziehbar; Spuren-Optik wie Mockup (schmaler).
5. **Später:** Wischgesten für ✓/✕, Tablet-Touch (Zeichenmodus, langer Druck).
6. Test auf echtem Gerät; dann Push + PR.

## Testen

- `npx vite --port 8765` in `projects/Audio-Workbench`, App: `demo/labeling-app.html`.
- Screenshots/Abläufe mit Python-Playwright (`uv run --with playwright`), Gerät „Pixel 7“, Testaudio:
  erste 30 s von `projects/BirdBox/tests/test.wav`. Modelle liegen unter `models/` (BirdNET, BirdBox).
