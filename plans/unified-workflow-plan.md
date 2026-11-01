# Plan: Lokaler Workflow und Xeno-canto unter einem Hut

Stand 2026-11-01, Branch `labeling-workflow`. Vom Nutzer freigegeben.

## Ziel

Labeln fühlt sich an wie Arbeiten in einem Ordner. Das XC-Annotation-Set ist **kein Arbeitsbehälter**
mehr, sondern ein **Export**, der erst im Upload-Tab entsteht.

- Lokal: Ordner öffnen → labeln → fertig (Export Raven/CSV/JSON). XC taucht nicht auf.
- XC: Aufnahme laden → labeln → Upload-Tab → „Neues XC-Set aus …“ → hochladen.

## Grundsätze

1. **Labels gehören zur Aufnahme.** `entry.annotations` ist die einzige Wahrheit. Quelle pro Label:
   `own` | `birdnet` | `xc-set:<id>` | `file:<id>` (importiert, schreibgeschützt).
2. **XC-Nummern immer mit Präfix speichern: `XC928094`.** Heute wird nur `928094` gespeichert
   (`recording-manager.ts` `xcId`, `ProjectRecording.xcId`). Eine nackte Zahl ist ohne Kontext
   nicht als XC-Bezug erkennbar. Kanonische Form überall `XC<ziffern>`; die nackte Zahl wird nur
   an der API-Grenze erzeugt (Annota `xc_nr`, API-URLs) über einen zentralen Helfer.
3. **Sets sind Snapshots.** Ein hochgeladenes Set speichert Datum, Lizenz, Scope und die Label-IDs
   (plus Hash des Inhalts). Ändern sich diese Labels später → „geändert seit Upload“ (XC: löschen + neu).
4. **Importierte XC-Sets** bleiben schreibgeschützte Quellen an der Aufnahme; „Übernehmen“ macht
   eigene Labels daraus (`adoptLabels`, Ziel jetzt `own` statt `ownSetId`).
5. **Brücke lokal ↔ XC = XC-Nummer.** Lokale Datei kann eine XC-Nr. bekommen (`assignXcId`), dann ist
   sie set-fähig. Ohne Nr. im Upload-Dialog ausgegraut mit Hinweis „nur lokal“.

## Phasen (je ein Commit)

### Phase 1 — Kanonische XC-ID `XC<n>`
- `src/domain/xc/xcId.ts` (neu, pure): `normalizeXcId(any) → 'XC123' | null`, `xcNumber('XC123') → '123'`,
  `isXcId`. Tests.
- `RecordingManager` (`assignXcId`, `findByXcId`, Konstruktor), `workspaceProject.ts`
  (`xcRecordingPath`, `xcMetaPath`, Audio-URL), `audioBlobStore.xcAudioKey`, `upload-checklist.ts`,
  `annotaPayload.ts` (`xc_nr` = `xcNumber(...)`), xc-panel, Referenzcalls: alles auf den Helfer.
- Migration beim Laden (Projektdatei, OPFS, sessionStorage): nackte Zahl → `XC…`. Schema bleibt
  `signavis-project/1`, Migration ist idempotent.
- Dateipfade `xc/XC123.mp3` bleiben unverändert (hatten schon das Präfix).

### Phase 2 — Datenmodell: Label-Quelle statt Set-Zugehörigkeit
- Label-Feld `source` (`own` | `birdnet` | `xc-set:<id>` | `file:<id>`); `setId` nur noch für
  importierte Quellen. Eigene Labels haben kein Set mehr.
- `annotation-sets.ts` → `label-sources.ts` (Quellen-Registry: importierte XC-Sets, BirdNET-Läufe,
  Datei-Importe) + `export-sets.ts` (Upload-Snapshots, Phase 4).
- `state.ownSetId` / `activeSetId` / `ensureOwnSet` / `createOwnSet` / `touchOwnSet` raus.
- Migration: Labels des bisherigen eigenen Sets → `source: 'own'`; war das Set `uploaded`,
  entsteht daraus ein Export-Snapshot (Phase 4 liest ihn). Tests für die Migration.

### Phase 3 — Explorer als Ordnerbaum
- Projekt-Tab-Explorer: echte Unterordner bei Projektordner (FS Access), virtueller Ordner
  „Xeno-canto“ mit `XC…`-Einträgen. Pro Aufnahme Zähler „n eigene · m importiert“.
- Ohne Projektordner (Sitzung/Firefox): flache Liste „Dateien“ + „Xeno-canto“.
- Bestehendes ⋯-Menü (XC-Nr. zuweisen, entfernen + Undo-Toast) bleibt.

### Phase 4 — Upload-Tab: Set erzeugen
- „Neues XC-Set aus …“: Auswahl Aufnahmen (nur mit XC-ID aktiv), Arten, Quellen (eigen,
  übernommen, BirdNET) per Checkbox; Set-Metadaten (Name, Lizenz, Scope, Creator) wie bisher.
- Upload-Checkliste + Vorschau arbeiten auf der Auswahl.
- Nach Upload: Snapshot speichern; Liste „Hochgeladene Sets“ mit Status
  aktuell / geändert seit Upload (Vergleich Label-IDs + Inhalts-Hash).

### Phase 5 — Labels-Tab + Aufräumen
- Baum Quelle → Art → Label: Quelle „Eigene“ statt Set-Name; importierte XC-Sets bleiben blasser Zweig.
- Set-Begriffe (draft/ready, „eigenes Set“, Set-Auswahl) aus Labeling-Ansicht, Properties-Leiste
  und Statusleiste entfernen.
- Exporte im Labels-Tab (Raven/CSV/JSON) arbeiten pro Aufnahme bzw. Ordner, ohne Set.

### Phase 6 — Gesamttest
- `tools/labeling-snapshots/shots.py` anpassen; lokaler Ordner-Ablauf + acc-Upload
  (`acc_upload.py`, `?xcenv=acc`) + Set-Import (`imptest.py`). Alte Projektdatei laden (Migration).

## Offen
- Mehrere getrennte Label-Durchgänge pro Datei (Annotator A/B)? Vorerst nicht; falls nötig später
  als „Layer“ über `source: 'own:<layer>'`.
- Prüfen, ob irgendwo XC-Nummern als Zahl verglichen/sortiert werden (Sortierung nach `xcNumber`).
