# UI-Klarheit Labeling-App (2026-10-31)

Ziel: kompakt bleiben, aber Gruppen, Hierarchie und wichtige Buttons sofort erkennbar machen; „blaues Meer“ im Dark-Theme auflösen; XC-Workflow im Project-Tab verständlich.

## Befund (Screenshots, XC1159843)
- XC-Labels landen als eigenes gesperrtes Set (nicht in My Annotations), aber der Project-Explorer zeigt nur `My Annotations › XC… 0` → wirkt wie „verschwunden/übernommen“.
- XC-Labels im Spektrogramm optisch wie eigene; App springt nach Laden ungefragt in Labels-Tab.
- „Labels3“ (fehlender Abstand), Set-Name abgeschnitten, Button „Add“/„Load“ uneinheitlich.
- Flächen, Inputs, aktive Zustände alle ähnlich blau; alle Buttons gleich gewichtet; Hinweistexte als Fließtext.
- Audio-Tab: Erklärabsätze, 2×2-Karten, viel Leerraum.

## Phasen
1. **Design-Tokens**: 3 Flächenstufen (bg < panel < card), neutraler Grauton im Dark-Theme, Blau nur für Interaktion; Button-Stufen primär (gefüllt) / sekundär (Rand) / ghost; Statusfarben ok/warn/err; Abschnitte als Karten; Labels gedämpft, Werte hell.
2. **XC-Workflow**: Explorer Aufnahme → Sets (eigen / fremd gesperrt mit Zahl + „Übernehmen“); fremde Sets im Spektrogramm gestrichelt/gedämpft; kein Auto-Tabwechsel, stattdessen Toast; Kleinfixes (Labels-Zähler, Button-Name).
3. **Audio-Tab kompakt**: Modus als Segment/Dropdown, Faktor als Segment-Buttons, Erklärungen in Tooltips, Ultraschall einzeilig.
4. **Feinschliff**: Upload (ein Primär-Button, Schritte als Karten), Analyse (Analyze-Button prominent), Toolbar-Gruppen mit Trennern, einheitliches Label/Feld-Raster rechts; Screenshot-Runde.

## Status
- Phase 1 `8e545b7`: `src/styles/components/_ui-clarity.scss` (zuletzt in main.scss geladen) — neutrale Dark-Tokens, `--color-card`, `--color-border-strong`, `--color-on-accent`, Button-Stufen.
- Phase 2 `2c3407a`: Explorer zeigt importierte Sets unter der Aufnahme (Schloss, Auge, „Adopt“ + Undo); XC-Laden bleibt im Project-Tab; gesperrte Labels gestrichelt; Button „Load“; Labels-Zähler.
- Phase 3 `3da37e8`: Audio-Tab-CSS kompakt. **HTML-Teil (Titel kürzer, Hinweise → Tooltips, ⓘ) nicht committet**, weil das Audio-Panel-Markup selbst zu fremden uncommitteten Änderungen in labeling-app.html gehört — mit diesen zusammen committen.
- Phase 4: Upload-Schritte als Karten mit Statusstreifen, Send/Analyze sticky unten, Toolbar-Gruppen als Segmente.
- Offen: Set-Farben pro Herkunft (Nutzer-Wunsch abwarten), rechte Leiste einheitliches Label/Feld-Raster.
