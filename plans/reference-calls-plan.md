# Referenzcall-Ansicht überarbeiten

Datei: `src/ui/components/reference-calls-modal/reference-calls-modal.ts`, eingebunden in `demo/labeling-app.html`.

Entscheidung (2026-10-31): Die Spektrogramm-Einstellungen der Referenz-Player bleiben eigenständig.
Sie werden NICHT an den Hauptplayer gekoppelt.

## Phasen

1. **Tastatur und Wiedergabe exklusiv** ✅
   - Player-Option `keyboardShortcuts: false` und Setter `player.keyboardEnabled`
   - Das Modal hat einen eigenen Key-Handler (Window-Capture) und schluckt Tasten, damit der Hauptplayer still bleibt
   - Leertaste spielt den ausgewählten Player; ↑↓/J/K wählt aus, R wählt die eigene Aufnahme
   - Startet ein Player, pausieren alle anderen; beim Öffnen pausiert der Hauptplayer
2. **Layout mit Vergleich nebeneinander** ✅
   - Eigenes Segment fest oben, ausgewählter XC-Call groß darunter, Kandidatenliste mit XC-Sono-Vorschaubild
   - Ein echter Player wird erst beim Auswählen erzeugt (lazy)
   - Kompakte Kopfzeile (kleines Artbild, Name, Suche); `A` spielt abwechselnd eigenes Segment und Referenz
3. **Filter und Sprung zum Call** ✅
   - Chips für Ruftyp, Qualität, Länge und Region/Entfernung (`getCoords`); kein `slice(0,3)` pro Gruppe mehr
   - Automatisch zum energiereichsten Abschnitt im Frequenzband des Labels springen
4. **Entscheidung im Vergleich** ✅ (Tags: verified, referenceXc, soundType)
   - Bestätigen, Art übernehmen, Ruftyp übernehmen; XC-ID als Referenz am Label im Annota-JSON speichern
   - `N` springt zum nächsten unbestätigten Label
5. **Integration** ✅
   - Andockbares Seitenpanel statt Vollbild-Modal, folgt der Label-Auswahl
   - Merkliste und lokaler Cache pro Art; bestätigte Labels aus dem eigenen Korpus als Referenzen
