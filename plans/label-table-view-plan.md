# Plan: Tabellenansicht unter der Overview („Tracks | Table“)

Stand: 2026-11-02

## Ziel

Unter der Overview gibt es heute nur die Label-Spuren, ein- und ausklappbar über „▾ Labels“.
Diese Leiste wird zu einer schmalen Tab-Leiste mit zwei Ansichten:

- **Tracks**: die bisherigen Spuren, unverändert.
- **Table**: eine Raven-artige Auswahltabelle aller Labels mit Inline-Bearbeitung,
  an das Spektrogramm gekoppelt.

Die Tabelle zeigt **alle Quellen** (eigene Labels, BirdNET, XC/Importe). Nach Quelle lässt sich
filtern. Fremde oder gesperrte Labels sind nur lesbar (`readonly`, Set `locked`, also
dieselbe Logik wie `_computeLockedIds`).

## Bestehender Code, auf dem der Plan aufbaut

- `src/ui/template.ts`: `overview-label-section` mit `overviewLabelToggle` und `overviewLabelTracks`.
- `src/app/PlayerState.ts`: `_toggleOverviewLabelSection` (Zustand in `aw-label-section-collapsed`).
- `src/ui/components/overview/overview.scss`: Leiste, 16 px hoch.
- `demo/labeling-app.html`: `state.labels`, `syncToPlayer`/`syncToPlayerSoft`, `propsPanel.onChange`
  (zentraler Bearbeitungsweg), `labelfocus`-Event (Quelle `'table'` wird dort schon wie ein Klick behandelt),
  `syncMultiSelected`, `selectLabel`, `speciesSearchFactory`, `tagStore`.
- `src/ui/panels/label-table.ts`: alte, nicht mehr eingebundene Tabelle. Davon bleiben nur die
  `TAG_PRESETS` erhalten. Die neue Ansicht entsteht als eigene Datei.

## Gestaltung

```
▾  Tracks │ Table                    [Own][BN][XC]  🔍 filter   In view   12 / 87   Follow
┌──┬──────────────┬───────┬───────┬──────┬───────┬───────┬───────┬─────┬─────┬──────┬───────┐
│● │ Species      │ Start │ End   │ Dur  │ f min │ f max │ Type  │ Sex │ Age │ Conf │ Note  │
```

- Die Tab-Leiste bleibt 16 px hoch. Der Pfeil klappt den Bereich ein und aus, ein Klick auf den
  aktiven Tab ebenfalls. Die Werkzeuge rechts erscheinen nur in der Tabellenansicht.
- Die Tabelle hat eine eigene Höhe (Ziehgriff an der Unterkante, Standard 180 px, wird gemerkt).
  Danach wird die Spektrogrammhöhe neu berechnet, wie beim Ein- und Ausklappen.
- Kompakte Zeilen (20 px), Zahlen in Tabular-Ziffern, fremde Quellen gedimmt.

## Phasen

### Phase 1: Tab-Leiste und leerer Tabellen-Host (Player)
- Template: Tabs `Tracks` / `Table` in der Leiste, `overviewLabelTable` als Host neben
  `overviewLabelTracks`, Werkzeugbereich `overviewLabelTools`.
- `PlayerState`: `_setLabelView('tracks'|'table')`, gemerkt in `aw-label-view`. Bisheriges Einklappen bleibt.
  Event `labelviewchange`. Öffentliche Methode `player.getLabelTableHost()`.
- Ziehgriff für die Tabellenhöhe (`aw-label-table-height`).
- Ohne Einbindung durch die App bleibt der Table-Tab ausgeblendet. Das Player-Paket bleibt also eigenständig.

### Phase 2: `LabelGrid`-Komponente (Anzeige)
- `src/ui/panels/label-grid.ts` + `label-grid.scss`.
- Spalten wie oben plus Quelle/Layer. Sortieren per Klick auf den Spaltenkopf (Standard: Start).
- Filter: Quellen-Chips (Own / BirdNET / XC und Importe), Textfilter (Art, Tags, Notiz),
  „In view“ (nur das aktuelle Zoomfenster). Zähler „sichtbar / gesamt“.
- Effizient bei mehreren tausend Zeilen: Zeilen werden nur bei Datenänderung neu gebaut,
  Hervorhebungen über Klassen.
- Einbindung in `labeling-app.html`: Neu zeichnen überall, wo `labelList.render` aufgerufen wird.

### Phase 3: Inline-Bearbeitung
- Zellnavigation wie in einer Tabellenkalkulation: Klick wählt die Zelle, Enter/F2 oder Tippen startet die Bearbeitung,
  Enter/Tab/Shift+Tab übernimmt und springt weiter, Esc bricht ab, Pfeiltasten bewegen die Auswahl.
- Editoren: Art → `speciesSearchFactory`, Zeit/Frequenz → Zahlenfeld (Pfeiltasten/Mausrad
  in kleinen Schritten, Live-Vorschau im Spektrogramm), Tags → `createEditableSelect` mit `tagStore`, Notiz → Text.
- Speichern einheitlich über `onChange(id, updates)` → derselbe Weg wie `propsPanel.onChange`.
- Gesperrte Zeilen: Die Zelle lässt sich nicht bearbeiten, ein Tooltip verweist auf „Adopt“.
- Plausibilitätsprüfung: Start < Ende, fmin < fmax, Werte innerhalb von Dauer und Nyquist-Frequenz.

### Phase 4: Kopplung und Mehrfachauswahl
- Zeile ↔ Spektrogramm: Klick → `labelfocus` (source `'table'`), Hover → Hover-Hervorhebung.
  Fokus von außen (Spektrogramm, Liste) → Zeile markieren und hinscrollen.
- Follow: Beim Abspielen wird die Zeile unter dem Playhead markiert und ins Bild gescrollt.
- Shift/Ctrl-Auswahl, synchron mit `syncMultiSelected`. Eine Bearbeitung bei Mehrfachauswahl
  gilt für alle bearbeitbaren ausgewählten Zeilen. Entf löscht (mit Bestätigung).

### Phase 5: Spalten und Feinschliff
- Spalten ein- und ausblenden (Menü am Spaltenkopf), Breiten ziehbar, beides gemerkt.
- Export der gefilterten Ansicht als CSV (optional).
- CHANGELOG, Nutzertest.

## Später (nicht Teil des Plans)
- Prüfmodus: Zeile für Zeile mit Autoplay, Vorschläge per ✓/✗ übernehmen oder verwerfen.
