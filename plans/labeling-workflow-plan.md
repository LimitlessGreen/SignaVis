# Labeling-App: Workflow & UI-Umbau — Plan

Stand: 2026-10-30. Grundlage: Code-Review von `demo/labeling-app.html` + `src/ui/panels/*`,
Screenshots aller Tabs (Demo + BirdNET-Lauf, 1600×950), XC-Artikel „Annotations in Xeno-canto“
und „Annota-JSON FINAL Fv0“ (März 2026).

## Ziele
1. Workflow folgt dem XC-Modell: **Set** (Projekt-Container) → **Aufnahmen** (je mit `xc_nr`) → **Annotationen**.
2. Jede Information hat genau **einen** Ort (Ort/Zeit, Autor, API-Key, Set-Metadaten).
3. Kompakt: Spektrogramm bekommt den Platz, Formulare zeigen nur Pflicht- und ausgefüllte Felder.
4. Upload ist ein geführter Ablauf mit Prüfung wie XCs „Verify“, kein stumm deaktivierter Button.
5. Payload exakt nach Annota-JSON Fv0.

## Was XC vorgibt (Annota-JSON Fv0)
- Ein Set darf **mehrere Aufnahmen** umfassen (Projekt, Ausflug, Art, Ort …).
- Aufnahme-Metadaten (Ort, Höhe, Datum, Gerät) kommen über `xc_nr` — **kein** `recording_context`.
- Fehler (Upload blockiert): `xc_nr`, `start_time`, `end_time`, `scientific_name`.
- Warnungen: `set_name`, `set_creator`, `set_owner`, `set_license`, `annotator`, `frequency_high/low`,
  `sound_type`, `sex`, `life_stage`, `annotation_remarks`.
- `sound_type`/`sex`/`life_stage` (und Methode) aus festen Listen: `GET /api/3/recording/{nr}?key=…&group_properties`
  → `group-sound-properties`.
- `scope: [{ taxon_coverage: Fokustaxon(e), completeness: all|part }]`.
- Upload nur für **eigene** Aufnahmen; landet im Konto, dort Verify/Import.
- Hochgeladene Sets sind **nicht editierbar** — nur löschen + neu hochladen.
- XC-Export kombinierter Sets: `original_set_metadata` (Array) pro Annotation.
- `scientific_name` darf abiotische Quellen bezeichnen (Regen, Wind …).

## Befund (Kurzfassung)
- Koordinaten an 4 Stellen (BirdNET-Location, XC-Recording-Edit, Properties read-only, Explore indirekt), nicht synchron:
  XC-Koordinaten erreichen BirdNET/Explore nie (`birdnet-panel.ts:_setCoords` nur von Locate/Map).
  Karten-Button in Properties nur in der Lat-Zeile.
- Autor an 4 Stellen (BirdNET-Author, XC-Author, XC-Set-Creator, Properties-Set-Creator).
- „Set“ doppeldeutig: Session im Recording-Explorer (`rec-set-*`), Annotation-Set in der Labelliste.
- Modus „Multi-file/Standalone“: unerklärt, Standalone löscht beim Laden still alle Einträge, ändert still Export-Umfang;
  springt beim Demo-Laden sichtbar um.
- XC-Tab mischt Laden, Upload-Metadaten (12 Felder, für Upload gar nicht vorgesehen), Profil, Key, Aktionen.
- **Bugs:** lokale Datei/Demo erscheint nicht im Recordings-Explorer („No recordings — use + to add“);
  XC → Set: „Select or create a set above.“ ohne Element darüber; Upload ausgegraut ohne Grund;
  BirdNET „Analyzing…“ ohne sichtbaren Fortschritt.
- Layout: beide Sidebars offen → Spektrogramm ~900/1600 px, rechte Leiste meist leer;
  BirdNET-Box 0–24 kHz verdeckt das Spektrogramm; Labels an 3 Orten (Liste, Boxen, Spur), 2 Wellenformen;
  Explore unter Help; uneinheitliche Überschriften (Audio-Tab), Checkbox-Stile.
- Export-/Upload-Aggregation 3× kopiert (`labeling-app.html:2387–2490`).
- Gut: Explore-Artkarten, Spectrogram-Tab-Gliederung.

---

## Umsetzungsstand (Branch `labeling-workflow`, 2026-10-30)
| Phase | Commit | Kern |
|---|---|---|
| 0 | f05f898 | `src/infrastructure/xeno-canto/annotaPayload.ts` (Build/Validierung Fv0), Import Array/Objekt |
| 1 | be43e1e | `collectSetLabels()`, Demo im Explorer, BirdNET-Fortschritt/Rahmen, Geo-Filter, Upload-Tooltip |
| 2 | b58b6d9 | `src/app/annotation-sets.ts`, `state.ownSetId`, Modus entfernt, „New…“, XC-Nr. zuordnen |
| 3 | e3a966f | Tabs Project/Labels/Analyse/Upload, „?“-Menü, ⋯-Menüs + Undo-Toast |
| 4 | 2ac8883 | `src/app/upload-checklist.ts` + `src/ui/panels/upload-assistant.ts`: Live-Checkliste mit Sprüngen, Vorschau, Export-Menü |
| 5–7 | — | offen; nächster Schritt Phase 5 |

Noch offen aus 0–4: Export „SignaVis-Projekt (vollständig)“ fehlt (kein Re-Import vorhanden) — Menü bietet Annota-JSON, Labels-JSON der Aufnahme, Zwischenablage;
Eigentumsprüfung vergleicht nur Recordist-Name mit Profilname (Warnung, kein Fehler); `invalidateXenoCantoRecordingCache` nach Upload nur für `xcPanel.xcId`;
BirdNET-Labels exportieren 0–Nyquist als Frequenz → Phase 6; „New…“/XC-Nr.-Zuordnung noch mit `confirm`/`prompt`;
`shots.py` nutzt alte Tab-Namen → vor dem Abschlusstest anpassen. Gesamttest (Screenshots, echter Upload) erst nach Phase 7.

## Phase 0 — Payload auf Annota-JSON Fv0 (klein, unabhängig)
`xc-panel.ts:buildAnnotationSetPayload`, `xenoCantoApi.ts`, `xenoCantoRecordingsApi.ts`:
- `recording_context` entfernen.
- `set_remarks`, `sound_file` ergänzen.
- `annotation_source_id` = stabile Label-ID (nicht Index).
- `date_identified` = Erstell-/Änderungsdatum des Labels (Label bekommt `createdAt`).
- `frequency_low/high` weglassen, wenn nicht gesetzt (statt `"0.0"`).
- `scope.completeness`: Auswahl `all`/`part`; `taxon_coverage`: Taxon-Eingabe (Taxonomie-Suche), nicht „all sounds/…“.
- `set_creator_id`: URI (z. B. `https://xeno-canto.org/contributor/<id>`); `annotator_xc_id` = XC-ID.
- `set_owner`: als Liste behandeln (UI: kommagetrennt) — Format mit echtem Upload prüfen.
- `animal_seen`/`playback_used`/`overlap`: `y`/`n`/leer.
- Import: `original_set_metadata` als Array lesen (Objekt weiter akzeptieren); Annotationen nach Original-Set gruppieren
  → je ein gesperrtes Set.
- Doku `docs/labeling/xeno-canto-format.md` auf Fv0 aktualisieren.

Tests: Payload-Snapshot gegen Fv0-Feldliste; Pflicht/Warn-Validierung; Import mit Array- und Objekt-`original_set_metadata`.

## Phase 1 — Bugs & Aufräumen
- Lokale Datei / Demo / Browse erzeugen einen Eintrag im Recording-Explorer (wie XC-Laden).
- XC → Set-Sackgasse beseitigen (entfällt in Phase 3, bis dahin: Set automatisch anlegen).
- Upload-Button: Tooltip/Text mit fehlender Voraussetzung.
- BirdNET: Fortschrittsbalken sichtbar; Ergebnis-Darstellung dezent (nur Rahmen, keine Füllung, oder nur Zeitspur).
- `collectSetLabels(setId)` als eine Funktion; Export, Upload und Button nutzen sie.
- Inline-`onclick`/Styles im BirdNET-Backend-Toggle in Code/SCSS verschieben.
- Geo-Filter-Checkbox deaktiviert mit Begründung, solange das Area-Modell fehlt (statt „(requires area model)“ zum Anklicken).
- No-Key-Modal: Text verweist auf den „Xeno Canto tab“ (entfällt in Phase 3) → auf Topbar-Indikator/Assistent umstellen;
  nicht bei jedem XC-Laden zeigen, sondern einmal bzw. als dezenter Hinweis in der Statusleiste.

## Phase 2 — Datenmodell: Set → Aufnahmen → Labels
- `modeSelect` entfernen. Immer eine Arbeitssitzung mit 1…n Aufnahmen; neue Datei wird **hinzugefügt**,
  „Neu“ ist eine bewusste Aktion (mit Undo/Bestätigung).
- Set-Arten:
  - **eigen** (`origin: manual`): editierbar, Status `entwurf` → `bereit` (keine Fehler) → `hochgeladen` (Datum).
    Änderung nach Upload → zurück auf `entwurf` + Hinweis „auf XC löschen und neu hochladen“.
  - **importiert** (`xeno-canto`, `BirdNET`, Datei): gesperrt, ausblendbar; „In mein Set übernehmen“ für einzelne/alle Labels.
- Aufnahme: `xcNr` (aus XC-Laden oder manuell zuordnen), `soundFile`, Kontext (siehe Phase 5), Label-Zähler.
- Ein aktives eigenes Set; neue Labels landen dort. Ein Set kann Labels aus mehreren Aufnahmen enthalten.
- Begriffe im Code vereinheitlichen: `session-*` für die Sitzung, `set-*` nur für Annotation-Sets.
- Migration bestehender localStorage/Projekt-Daten (`state.mode`, `labelSets`, Entries).

## Phase 3 — Linke Leiste neu
| Tab | Inhalt |
|---|---|
| **Projekt** | Kopf: aktives eigenes Set (Name, Lizenz, Fokustaxon, all/part, Status) in 2–3 Zeilen, „Mehr…“ klappt optionale Felder auf. Darunter Aufnahmen-Liste: `XC12345 · 14 Labels · ✓` / `rec_01.wav · 3 · ⚠ keine XC-Nr.` Hinzufügen-Menü: Datei · XC-Nr./URL · Demo. Fremde Sets als gesperrte Zeilen mit Sichtbarkeit. |
| **Labels** | Nur Liste: Filter Set/Art/Aufnahme, Suche, Sichtbarkeit. Shortcut-Hinweis nur im Leerzustand. |
| **Analyse** | BirdNET: Run oben, Confidence/Overlap, Backend eingeklappt. Darunter „Erwartete Arten hier“ (Explore). Kein Author-Feld. |
| **Upload** | Assistent (Phase 4). |

- About/Help → „?“-Menü in der Topbar; Tages-Tipps dort.
- XC-Tab entfällt: Laden → Projekt, Profil → Einstellungen/Assistent, Key → Topbar/Assistent.
- Löschaktionen: Kontextmenü pro Knoten statt ↺/×/Clear; Undo-Toast statt `confirm()`.
- Activity-Bar: horizontale Labels unter den Icons oder nur Icons + Tooltip.

## Phase 4 — Upload-Assistent (XC-„Verify“ lokal)
Modal oder Tab, eine Seite mit Checkliste, live aktualisiert:
1. **API-Key** ✓ / Eingabe inline (Topbar-Indikator zeigt Status).
2. **Profil** (einmalig): Name, XC-Benutzer/ID, Standard-Lizenz, Organisation → Zusammenfassungszeile.
   Liefert `set_creator`, `set_creator_id`, `annotator`, `annotator_xc_id`, `set_owner`-Default.
3. **Set**: Pflicht-/Warnfelder sichtbar (Name, Lizenz aus fester Liste, Owner, Fokustaxon, all/part), Rest eingeklappt.
4. **Aufnahmen**: jede mit `xc_nr` und als eigene Aufnahme (Recordist = Profil) — sonst Fehler mit Sprung zur Aufnahme.
5. **Labels**: Fehler (fehlende Art/Zeit) und Warnungen (Frequenz, Sound type, Sex, Life stage) gruppiert, Klick springt zum Label.
6. **Vorschau**: „Set ‚X‘ · 3 Aufnahmen · 17 Labels · 4 Warnungen“, JSON ansehen/herunterladen, „An XC senden“.
   Hinweis: landet im XC-Konto zur Prüfung; nicht editierbar, nur löschen + neu.
- Export als Datei läuft über denselben Assistenten (ohne Schritte 1/4-Eigentum).
- Export-Menü klar benannt statt „Export“/„Copy“ (Labels) vs. „Export JSON“ (XC): **Annota-JSON (XC)**,
  **SignaVis-Projekt (vollständig, zum Weiterarbeiten)**, ggf. Raven-Tabelle/CSV; „In Zwischenablage“ als Option im selben Menü.
  Umfang immer angezeigt (Set/Aufnahmen/Labels).

## Phase 5 — Aufnahme-Kontext & Karte
- Ein Kontextblock pro Aufnahme: Datum/Zeit, Ort, Gerät. Quellen automatisch: XC-Metadaten, GUANO, Dateiname;
  überschreibbar, Quelle angezeigt.
- Einzige Koordinatenquelle für BirdNET, Geo-Filter, Explore (BirdNET-Location-Abschnitt entfällt).
- Darstellung: `📍 51.5074, −0.1278 · Leipzig, DE  [Karte] [⌖]`; ein Feld für Lat/Lng (versteht eingefügtes `51.5, -0.12`);
  Mini-Karte (statisch, ~120 px) wenn gesetzt, Klick → Map-Modal.
- Ort: oben in Properties (Recording-Abschnitt) bzw. im Projekt-Tab bei der Aufnahme.
- Wird **nicht** hochgeladen (XC hat die Daten über `xc_nr`).

## Phase 6 — Label-Metadaten aus XC-Listen
- `group_properties` je Aufnahme laden und cachen (pro Artengruppe).
- Sound type / Sex / Life stage im Label-Editor, Properties und Labelliste als Auswahl aus diesen Listen;
  Rückfall-Liste für Aufnahmen ohne XC-Nr.
- Tasten 1–9-Presets auf die XC-Werte abbilden.
- Abiotisch/unbekannt: Auswahl für `scientific_name` (Regen, Wind, Insekt …) — XC-Konvention klären.

## Phase 7 — Layout & Feinschliff
- Rechte Leiste standardmäßig zu; öffnet bei Label-Auswahl (Properties) bzw. auf Klick. Spektrogramm bekommt den Platz.
- Topbar: Projektname · Artensuche · Sprache · XC-Status · ⚙ · ?  (Modus, Taxonomie-Status, Zeitbereich raus/in Statusleiste).
- Doppelte Wellenform/Label-Spur: eine Übersicht; Label-Spur optional.
- Einheitliche Abschnittsköpfe (Audio-Tab), Checkbox-Stil, Explore-Kartenstil als Vorbild.
- Shortcuts: `N`/`P` nächste/vorige Aufnahme, `B` BirdNET auf aktueller Aufnahme, `U` Upload-Assistent.
- Properties → Abschnitt „Annotation Set“ nur noch Zusammenfassung (Name, Lizenz, Status) + Link „im Projekt bearbeiten“;
  Set-Felder sind nur an einer Stelle editierbar (Projekt-Tab/Assistent).
- Topbar: Sponsor-Popover nicht beim Überfahren des Logos, sondern im „?“-Menü/About; Brand schlanker.
- Modals (Long-Recording, XC-not-found, No-Key) einheitlich über `ModalManager` statt eigener `xc-nokey-*`-Dialoge.
- Dark Mode und schmale Fenster (≤1280 px) prüfen — bisher nur hell bei 1600 px angesehen.

---

## Reihenfolge & Abhängigkeiten
0 → 1 unabhängig, sofort. 2 ist Grundlage für 3/4. 5 und 6 nach 2, untereinander unabhängig. 7 zuletzt.
Jede Phase einzeln committen.

## Prüfung
- Unit-Tests: Payload/Validierung (0, 4), Import (0), Datenmodell-Migration (2).
- Screenshots vorher/nachher je Phase: Skript `shots.py` (Playwright, Demo laden, alle Tabs) nach `tools/` übernehmen,
  hell + dunkel, 1600 und 1280 px, plus Szenario „XC-Aufnahme geladen“ (braucht Key).
- Ein echter Test-Upload mit eigener Aufnahme + Key (Nutzer), Antwort/Warnungen dokumentieren.

## Offene Fragen
- `set_owner`: String oder JSON-Liste? (mit Verify-Formular/Upload testen)
- Erlaubte `set_license`-Werte (feste XC-Liste) — aus Upload-Formular/Fehlermeldung ablesen.
- Genaues Format `group-sound-properties` — eine echte Antwort mit Key ansehen.
- Konvention für abiotische `scientific_name`-Werte.
