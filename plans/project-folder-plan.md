# Projektordner für die Labeling-App

Stand 2026-10-31, Branch-Basis `labeling-workflow`.

## Ausgangslage (Ist)

- `RecordingManager` (`src/app/recording-manager.ts`) hält die Aufnahmen samt **Annotationen in `sessionStorage`** → Tab zu = Labels weg (außer was in den Sets in `localStorage` steckt).
- Lokale Dateien sind Blob-URLs → nach Reload muss man sie neu auswählen.
- XC-Aufnahmen werden bei **jedem** `activateRecordingEntry` neu über `xcPanel.fetchAudio` geladen (`demo/labeling-app.html` ~1709), auch in `ownRefAudioUrl` (~643). Bei einem Set mit mehreren XC-Aufnahmen lädt man beim Hin- und Herwechseln dieselben MP3s immer wieder.
- Es gibt schon einen Audio-Cache über die Cache API, aber nur für die Referenzcall-Ansicht (`reference-calls-modal.ts` 334–360).
- Für Projekte gibt es schon eine Schnittstelle: `IProjectRepository` mit `StorageProjectRepository` (localStorage) und `TauriProjectRepository`. Die Labeling-App nutzt sie bisher nicht.

## Bewertung der Idee

Die Idee ist gut. Eigentlich löst sie zwei verschiedene Probleme, und die sollte man getrennt behandeln:

1. **XC-Audio wird wiederholt geladen.** Dafür braucht es keinen Ordner. Ein Cache in Origin Private File System (OPFS) oder in der Cache API funktioniert in **allen** Browsern ohne Nachfrage beim Nutzer. Das geht schnell und hilft sofort.
2. **Eigene Projekte sollen dauerhaft und portabel sein.** Dafür ist die File System Access API (`showDirectoryPicker`) richtig. Labels, Sets und Audio liegen dann als echte Dateien beim Nutzer: sicherbar, mit Git versionierbar, zwischen Rechnern austauschbar und auch von Python/BirdNET aus lesbar.

Einschränkungen, die man kennen muss:
- `showDirectoryPicker` mit Schreibzugriff gibt es **nur in Chromium** (Chrome, Edge, Opera, Desktop). Firefox und Safari haben es nicht, auch Mobilgeräte nicht. Deshalb braucht es Rückfallebenen (siehe unten).
- Den Ordner-Handle kann man in IndexedDB speichern. Nach einem Neustart steht die Berechtigung aber wieder auf `prompt`, und `requestPermission()` braucht eine Nutzergeste. In der UI heißt das: Knopf „Projekt *XY* wieder öffnen“ statt automatischem Laden. Chrome ab 122 bietet „Bei jedem Besuch erlauben“ an, dann entfällt das.
- Systemordner (Home, Desktop-Wurzel, Windows-Ordner) blockiert der Browser. Nutzer müssen einen Unterordner wählen.
- Dateien schreiben wir mit `createWritable()`. Das schreibt zuerst in eine Swap-Datei und ersetzt erst beim `close()`, ist also praktisch atomar. Gut für die Projektdatei.

## Zielbild

Die App kennt drei Speicherarten hinter einer gemeinsamen Schnittstelle:

| Modus | Browser | Audio | Labels/Sets |
|---|---|---|---|
| **Projektordner** (FS Access) | Chromium | Dateien im Ordner, XC-Downloads nach `xc/` | `project.signavis.json` im Ordner |
| **Browser-Projekt** (OPFS) | alle | OPFS | OPFS (statt sessionStorage) |
| **Nur lesen** (`<input webkitdirectory>`) | alle | Ordner einlesen, nicht zurückschreiben | OPFS, Export als Datei |

### Ordnerlayout

```
MeinProjekt/
  project.signavis.json      # Version, Aufnahmenliste (relative Pfade), Sets, Annotationen, Einstellungen
  audio/ …                   # eigene Dateien (beliebige Unterordner, werden beim Öffnen gescannt)
  xc/XC928094.mp3            # heruntergeladene XC-Aufnahmen
  xc/XC928094.json           # XC-API-Metadaten inkl. Lizenz/Recordist (Lizenzpflicht!)
  exports/annotation-set-<id>.json   # Annota-Exporte/Upload-Kopien
```

- Eigene Audiodateien kann der Nutzer auch direkt in die Wurzel oder beliebige Unterordner legen. Die App referenziert sie über den relativen Pfad und kopiert nichts.
- Annotationen bleiben in **einer** Projektdatei, weil Sets mehrere Aufnahmen umfassen. Optional später: Raven-/Audacity-Sidecars (`<datei>.Table.1.selections.txt`) als Export.
- Ins Schema kommt `"schema": "signavis-project/1"` für Migrationen.

## Phasen

Jede Phase wird einzeln committet (siehe Arbeitsweise im Labeling-Plan).

### Phase 1: XC-Audio-Cache (alle Browser, unabhängig vom Ordner)
- `src/infrastructure/storage/audioBlobStore.ts`: `get(key)`, `put(key, buf, meta)`, `delete`, `list`, `usage()`. Läuft auf OPFS (`navigator.storage.getDirectory()`), Rückfall auf die Cache API.
- `xcPanel.fetchAudio` bzw. ein Wrapper `getXcAudio(xcId)` liest erst aus dem Cache. Die Referenzcall-Ansicht zieht auf denselben Store um (ihr `AUDIO_CACHE_NAME` wird migriert oder einfach geleert).
- `navigator.storage.persist()` anfragen, damit der Browser den Cache nicht wegräumt.
- Einstellungen: Cachegröße anzeigen und „Cache leeren“-Knopf, LRU-Grenze (z. B. 2 GB).
- Tests: Unit-Tests mit einem Fake-Store.

### Phase 2: Speicher-Port und Projektmodell
- `IProjectStore` (Domäne) mit `loadProject()`, `saveProject(debounced)`, `listAudio()`, `readAudio(path): File`, `writeAudio(path, buf)`, `capabilities {write, persistentHandle}`.
- Projekt-JSON definieren, dazu `serialize`/`deserialize` (pure, getestet) aus `RecordingManager` + `state.labelSets`.
- Prüfen, ob das bestehende `IProjectRepository`/`Project`-Modell (Desktop) passt oder ob ein Adapter dazwischen reicht. Ziel ist **ein** Format für Web und Tauri.
- `RecordingEntry` bekommt `source: 'xc' | 'file' | 'sample'` und `path` (relativ). `audioUrl`/`isBlobUrl` werden zur reinen Laufzeitinfo.

### Phase 3: Browser-Projekt (OPFS) als Standard
- `OpfsProjectStore`: Ersetzt sessionStorage für Aufnahmen und Annotationen sowie localStorage für Sets. Labels überleben damit das Schließen des Tabs.
- Migration: vorhandene sessionStorage-/localStorage-Daten einmalig übernehmen.
- Lokal geöffnete Dateien (Datei-Input) werden ins OPFS kopiert, mit Größenhinweis. Danach sind sie auch nach einem Reload da.

### Phase 4: Projektordner (FS Access, Chromium)
- `FsAccessProjectStore`. Projekt-Tab: „Ordner öffnen…“ / „Neues Projekt in Ordner…“. Bei fehlender API ausgegraut, mit Tooltip.
- Handle in IndexedDB, Liste „Zuletzt geöffnet“. Ist die Berechtigung `prompt`, erscheint ein Banner „Zugriff auf *Ordner* erneut erlauben“ (eine Nutzergeste).
- Beim Öffnen: `project.signavis.json` lesen und Audio-Dateien rekursiv scannen (wav/mp3/flac/ogg/m4a). Neue Dateien erscheinen als „nicht im Projekt“ und lassen sich per Klick oder „alle hinzufügen“ aufnehmen. Fehlende Dateien werden markiert.
- XC-Aufnahmen landen in `xc/` mit Metadaten-JSON. Der Cache aus Phase 1 bleibt als Zwischenschicht. Hat der Nutzer ein Set aus dem Browser-Projekt, bietet die App an, es in den Ordner zu übernehmen („Projekt in Ordner speichern…“).
- Speichern: debounced (ca. 1 s) nach Änderungen, außerdem bei `visibilitychange`/`pagehide`. Statusanzeige „gespeichert / speichert / Fehler“.
- Konflikt: `lastModified` der Projektdatei vor dem Schreiben prüfen. Wurde sie extern geändert, fragt die App nach (neu laden oder überschreiben). Mehrere Tabs auf denselben Ordner: Sperre über `BroadcastChannel`.

### Phase 5: Nur-Lesen-Rückfall (Firefox/Safari)
- „Ordner einlesen“ über `<input type=file webkitdirectory>`. Audio kommt aus dem Ordner (zur Sitzung neu wählen), Labels liegen im OPFS-Projekt mit Ordnername als Schlüssel.
- „Projekt exportieren“ (ZIP oder nur `project.signavis.json`) und „Projekt importieren“.

### Phase 6: Feinschliff und Gesamttest
- Explorer zeigt die Ordnerstruktur (Unterordner als Gruppen) und das Speicherziel im Statusbereich.
- Test am Ende mit Playwright (Chromium): Ordner per `page.evaluate` geht nicht, weil der Picker nativ ist. Stattdessen den Store in Tests gegen OPFS laufen lassen und den FS-Access-Pfad manuell testen.
- Die Desktop-App (Tauri) kann später denselben Store über native Dateien abbilden.

## Entscheidungen (Nutzer, 2026-10-31)
1. XC-Downloads im Projektordner unter `xc/`, abschaltbar. Der Browser-Cache bleibt als Zwischenschicht.
2. Lokale Dateien ohne Projektordner gelten wie bisher **nur für die Sitzung**. In Phase 3 werden sie nicht ins OPFS kopiert, nur Labels und Sets wandern ins OPFS.
3. Firefox/Safari: vorerst genügen Phase 1 und Phase 3. **Phase 5 ist zurückgestellt.**
4. Raven-Sidecar-Export pro Audiodatei: ja, kommt in Phase 6.

## Status
- Phase 1 erledigt: `src/infrastructure/storage/audioBlobStore.ts` (OPFS → Cache API, LRU 2 GB, Pins, `navigator.storage.persist()`), `xcPanel.fetchAudio` liest/schreibt den Cache (alle Aufrufer profitieren), Referenzcalls nutzen denselben Store (Pin = nie verdrängen, Unpin = Eintrag bleibt im LRU; alter `rc-pinned-audio`-Cache wird beim Lesen migriert). Zeile „Audio cache … Clear“ im Upload-Tab unter dem API-Key. Tests `tests/audio-blob-store.test.mjs`. Im Browser noch ungetestet.
- Phase 2 erledigt: `src/domain/project/workspaceProject.ts` (Format `signavis-project/1`: Aufnahmen + Sets + Einstellungen; `serializeProject`/`parseProject`/`deserializeProject`, `inferSource` für alte Einträge, keine blob:-URLs im JSON), `src/domain/project/IProjectStore.ts` (Port + Pfadprüfung), `src/infrastructure/project/MemoryProjectStore.ts`, `RecordingManager` mit `source`/`path`, `snapshot()`, `replaceAll()`. Tests `tests/workspace-project.test.mjs`.
  - Entscheidung: Das alte `Project` (`types.ts`, eine Audioquelle) bleibt für die Desktop-App, ein Adapter folgt bei Bedarf. Es passt nicht zu Sets über mehrere Aufnahmen.
  - Für Phase 3: Die App speichert heute an **drei** Stellen (RecordingManager → sessionStorage, Sets → localStorage `signavis.session-sets.v1`, Autosave-`Project` über `projectRuntime.repo` mit nur den aktiven Labels, `demo/labeling-app.html` ~1390–1455). Alle drei werden durch den OPFS-Projektspeicher ersetzt, mit einmaliger Migration.
- Phase 3 erledigt: `src/infrastructure/project/OpfsProjectStore.ts` (OPFS `projects/default/`), `src/app/project-autosave.ts` (`ProjectAutosaver`: 1 s Debounce, Flush bei `visibilitychange`/`beforeunload`, Fehler bleibt „dirty“; `acquireTabLock` per Web Locks → zweiter Tab ist schreibgeschützt mit Banner). In `labeling-app.html`: `openBrowserProject()` beim Start; gibt es noch kein Projekt, laufen die alten Wiederherstellungen einmal und der erste Autosave migriert sie. `saveSessionSets`/`scheduleProjectAutosave`/RecordingManager-Events lösen das Speichern aus. Die zuletzt aktive Aufnahme wird beim Start wieder geöffnet (XC-Audio aus dem Cache). Eine nach dem Neustart erneut gewählte lokale Datei mit gleichem Namen wird an ihren alten Eintrag gehängt, die Labels bleiben erhalten. Die alten Speicher (sessionStorage, Sets-localStorage, Autosave-Repo) schreiben vorerst weiter mit (harmlos, Desktop nutzt das Repo); Abbau kommt später.
  - Smoke-Test (Playwright, Chromium): Beispielaufnahme laden → Tab zu → neuer Tab zeigt sie wieder; zweiter Tab zeigt Banner. Labels über Neustart nur per Unit-Test geprüft.
- Phase 4 erledigt: `DirectoryProjectStore.ts` (gemeinsame Basis für OPFS und Ordner, Konflikterkennung über `lastModified` → `ProjectConflictError`, Scan überspringt `.git`/`node_modules`/versteckte Ordner, Tiefe ≤ 8), `FolderAccess.ts` (Picker, Berechtigung, letzter Ordner in IndexedDB `signavis-project-folders`), `src/ui/panels/project-location.ts` + `_project-location.scss` (Block „Storage“ oben im Projekt-Tab). App: Speicherort in `signavis.project.location.v1`; ein Wechsel lädt die Seite neu. Ordner ohne Projekt → Abfrage „aktuelle Sitzung übernehmen oder leer“. Ordner-Aufnahmen tragen `path` und werden beim Aktivieren aus dem Ordner gelesen. XC-Aufnahmen werden nach `player ready` aus dem Cache nach `xc/XC<nr>.mp3` + `.json` kopiert (abschaltbar, `signavis.project.xc-to-folder.v1`). Tab-Lock pro Ordnername. Konflikt-Dialog: OK = neu laden, Abbrechen = überschreiben.
  - Smoke-Test (Playwright mit OPFS-Unterordner als Ersatz-Ordner, gleicher Handle-Typ): Datei im Unterordner gefunden, „+“ übernimmt sie, Projektdatei geschrieben, nach Neuladen wieder geöffnet, externe Änderung → Konflikt-Dialog. Nicht getestet: echter `showDirectoryPicker` und der Berechtigungsdialog nach einem Browser-Neustart.
  - Offen: Eigene Referenzen (`ownRefAudioUrl`) lösen Ordner-Aufnahmen noch nicht auf. Beim Einschalten von „XC in Ordner“ werden vorhandene XC-Aufnahmen erst beim nächsten Öffnen kopiert.
- Phase 6 erledigt:
  - Raven-Export (`src/infrastructure/export/ravenSelectionTable.ts`, getestet): Export-Menü „Raven table — this recording“ (Download) und, im Ordnerprojekt, „Raven tables — all recordings → folder“. Die Tabelle `<name>.Table.1.selections.txt` liegt neben der Audiodatei; Aufnahmen ohne Pfad landen unter `exports/raven/`. Exportiert werden alle Labels der Aufnahme, die Spalte „Set“ nennt das Set. Ohne Frequenzbereich: 0 … Nyquist.
  - Explorer zeigt den Unterordner vor dem Dateinamen. Echte Gruppierung wurde verworfen, weil sie die N/P-Reihenfolge verändern würde.
  - Alte Speicher abgebaut: Sobald ein Projektspeicher aktiv ist, schreibt die App weder sessionStorage (`disableSessionPersistence`, alter Eintrag wird gelöscht) noch Sets-localStorage noch das alte Autosave-Repo. Gelesen werden sie nur noch zur Migration. Ohne OPFS bleibt alles wie früher.
  - Eigene Referenzcalls lesen Ordner-Aufnahmen aus dem Ordner. Beim Einschalten von „XC in Ordner“ werden vorhandene XC-Aufnahmen sofort kopiert.
  - Smoke-Test (Ersatz-Ordner): Projekt mit Label in Unterordner geladen, Explorer-Pfad, sessionStorage leer, Raven-Tabelle neben der Audiodatei geschrieben.
- **Noch offen:** echter Test in Chrome/Edge mit `showDirectoryPicker` und dem Berechtigungsdialog nach einem Browser-Neustart (Nutzer); Phase 5 (Firefox/Safari) zurückgestellt; Desktop-Adapter für das alte `Project` bei Bedarf.

