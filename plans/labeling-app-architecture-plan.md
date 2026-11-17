# Labeling-App – Architektur-Umbau: Plan und Stand

Stand: 2026-11-17 · Schritte 1–2 und Schritt 5 Teile 1–3 gemergt (PR #117, #118) · Schritt 3 Teil 1 gemergt (PR #131), Teil 2 auf Branch `refactor/app-commands`

Ziel: Wiederverwendbarkeit und Performance. Schrittweise umbauen, jeder Schritt einzeln mergebar,
die App läuft dazwischen. **Kein** Framework-Wechsel (React/Svelte) und kein Big-Bang-Rewrite: Die
Bausteine in `src/` (Panels, Domain, `MobileApp`, 78 Tests) sind solide, das Problem ist die Verdrahtung.

## Befund (vor Schritt 1)

- `demo/labeling-app.html`: 5430 Zeilen, davon ~4700 in **einem** Inline-`<script type="module">`.
  Nicht typgeprüft (`tsconfig` schließt nur `src/**` ein), nicht testbar (nicht importierbar).
  Hotspot: 107 von 330 Commits seit 2026-09 berühren die Datei.
- **Globales `state` + Fan-out von Hand:** `state.labels =` an 21 Stellen, `syncToPlayer()` 32× aufgerufen –
  rendert jedes Mal alles (Player, Locked-IDs, komplette Labelliste, Explore, Properties, Autosave).
  Daneben `syncToPlayerSoft`, `syncMultiSelected`, `updateSet` (debounced) mit eigenen Render-Listen.
  Jede neue Ansicht muss an allen Stellen nachgetragen werden.
- **Performance:** `LabelList.render()` (`src/ui/panels/label-list.ts`) baut per `innerHTML = ''` alles neu,
  auch bei reiner Auswahländerung. Mehrere Syncs pro Aktion = mehrere Voll-Renders.
- **DOM als API:** z. B. Handy-UI lädt Xeno-canto per `xcIdInput.value = raw; xcLoadBtn.click()`;
  14× `.click()` als Funktionsaufruf. Abläufe hängen an Desktop-Buttons statt an Funktionen.

## Schritte

| # | Inhalt | Stand |
|---|---|---|
| 1 | Inline-Skript mechanisch nach `src/app/labeling/main.js`, HTML nur Markup; `demo/lib`-Stubs weg | ✅ `130e6f8` |
| 2 | Render-Scheduler: Ansichten werden gebündelt neu gezeichnet (`RenderScheduler`), dazu zwei Hotspots in `annotations.ts` | ✅ (siehe unten) |
| 3 | Befehle statt Button-Klicks: `loadXenoCanto(id)`, `activateRecording(id)`, `adoptLabel(id)`, `exportSet()` … – Desktop und `MobileApp` rufen dieselben Funktionen. Dabei Label-Änderungen in einen `LabelStore` (Mutationen nur über Methoden, Benachrichtigung per `subscribe`) | 🔧 Teil 1a ✅ (`LabelStore`), 1b ✅ (Speichern/Ansichten per `subscribe`), 2 ✅ (Befehle) |
| 4 | `main.js` nach Features aufteilen (Grenzen = vorhandene `// ──`-Abschnitte): Projektspeicher, Xeno-canto (Laden/Export/Upload), Aufnahmen (Datei/Drag&Drop/Mikro), Lite-Integration, Kontextmenüs, Startup. Je Modul `install(ctx)` mit typisiertem `AppContext`, als `.ts` **ohne** `@ts-nocheck` | offen |
| 5 | Keyed-Render der Label-Ebenen, schnellere Labelliste | ✅ Teil 1 `SpectrogramLabelLayer`, ✅ Teil 2 `AnnotationLayer`, ✅ Teil 3 `LabelList`; offen: nur sichtbaren Zeitbereich rendern, Zeitansicht der Liste |

## Schritt 1 – Details

- `demo/labeling-app.html` 5430 → 739 Zeilen; lädt `<script type="module" src="../src/app/labeling/main.js">`.
- `demo/xc-export-modal.js` → `src/ui/components/xc-export-modal/xc-export-modal.js`.
- `demo/lib/*` (nur Re-Export-Stubs) gelöscht; `tests/{session-sets,recording-manager,snr-computer}.test.mjs`
  importieren direkt aus `src/`.
- `main.js` und `xc-export-modal.js` vorerst `// @ts-nocheck`: 930 Fehler unter `strict` (141 ohne).
  Häufigste: TS2339 (Property fehlt, 289), TS18047 (möglicherweise null, 256), TS7006 (implizites any, 234).
  Abbau über Schritt 4: herausgelöste Module werden typisiert geschrieben.
- Prüfung: esbuild-minifiziert alt vs. neu verglichen (nur Whitespace in HTML-Templates + esbuild-Umbenennungen
  verschieden); Typcheck sauber; Tests 661/661 (ein flakiger Abbruch tritt auch auf `main` auf);
  Demo- und Lite-Build ok; Playwright (Desktop 1400×900 + Pixel 7) ohne Konsolenfehler, Demo-Aufnahme lädt.

## Testweg

- `npm run typecheck`, `npm test`
- `npx vite build --config demo/vite.demo.config.js`, `npx vite build --config demo/vite.lite.config.js`
- Benchmark: `uv run --with playwright python -I tools/perf/label-sync-bench.py --labels=1500` (Devserver nötig);
  Vergleich mit altem Stand per `git worktree add /tmp/aw-base <commit>` + zweitem Devserver (Port 5192)
- Devserver `npx vite --port 5191`, dann Smoke-Test mit Python-Playwright
  (`uv run --with playwright python -I smoke.py http://localhost:5191/demo/labeling-app.html`):
  Desktop „Load demo recording“, Handy-Ansicht Pixel 7, Konsolenfehler sammeln.

## Schritt 2 – Details

- `src/app/labeling/render-scheduler.ts` (+ `tests/render-scheduler.test.ts`): `invalidate(...keys)` merkt Ansichten
  als veraltet, ein Microtask zeichnet sie einmal in fester Reihenfolge; `flush()` für Stellen, die sofort lesen.
- `main.js`: `labelViews` mit Schritten `player`, `list` (zeichnet die Tabelle mit), `table`, `badge`, `explore`, `props`.
  `syncToPlayer()` speichert weiter **sofort** (`saveCurrentAnnotationsIfNeeded`, sonst landen Labels beim
  Aufnahmewechsel in der falschen Aufnahme) und invalidiert nur noch. Die 10 direkten `labelList.render()`-Aufrufe
  (oft direkt nach `syncToPlayer()` = doppelter Voll-Render) laufen über den Scheduler.
  `selectLabel()` und Segment-Play rufen vorher `labelViews.flush()` (neue Zeile muss existieren, um sie zu markieren).
- `annotations.ts`: `_pinAllLabelTexts` liest erst alle Layout-Werte, dann schreibt es (vorher ein Reflow **pro Label**,
  ~1,6 s bei 1500 Labels); `setLockedIds` rendert nicht neu, wenn sich die Menge nicht geändert hat (vorher bei jedem
  Sync ein zweiter Voll-Render des Overlays).
- Falle: `queueMicrotask` darf nicht als Methode aufgerufen werden („Illegal invocation“ im Browser, Node merkt es nicht) – Test deckt das ab.
- Dev-Zugriff `window.__signavis` (nur `import.meta.env.DEV`, nicht im Build) + Benchmark `tools/perf/label-sync-bench.py`.

Messung (Benchmark, Median bis zum nächsten gezeichneten Frame, Demo-Aufnahme 8 s):

| Aktion | 1500 Labels vorher → nachher | 200 Labels vorher → nachher |
|---|---|---|
| Properties-Edit (ohne Name) | 2887 → 1587 ms | 370 → 222 ms |
| Umbenennen | 2956 → 1815 ms | 377 → 235 ms |
| Ziehen/Größe im Spektrogramm | 3060 → 1773 ms | 382 → 225 ms |
| `syncToPlayer()` | 3018 → 1821 ms | 387 → 220 ms |

Rest: ~1 s (1500) bzw. ~120 ms (200) ist der komplette Neuaufbau aller Spektrogramm-Label-Elemente plus deren Layout
→ Schritt 5 vorziehen. E2E (Label zeichnen, benennen, umbenennen, löschen) verhält sich vorher/nachher gleich.

## Schritt 5, Teil 1 – Keyed-Render der Spektrogramm-Labels

Branch `perf/spectrogram-labels-keyed` (von `refactor/labeling-app-module`).

- `SpectrogramLabelLayer.render()` behält Elemente je Label-id: Signatur = Label-JSON (ohne `createdAt`/`updatedAt`,
  die `_normalize` bei jedem `set()` neu stempelt – sonst würde nie etwas wiederverwendet) + gesperrt / live / Lane /
  Konfidenz-Anzeige / Read-only. Gleiche Signatur → Element bleibt; nur Geometrie anders (Zoom, Scroll) → nur Position.
  Andere Kinder (Stempel-Geist, Snap-Vorschau, Entwurf) werden wie beim alten `innerHTML = ''` entfernt.
- `_applyGeometryToElement` (Ziehen außerhalb von render) markiert die Geometrie als veraltet; render setzt sie neu.
- Kollisions-Klasse per `toggle` (wiederverwendete Elemente), Pin-Werte nur bei Änderung schreiben.
- Prüfung: `tools/perf/label-render-equivalence.py` vergleicht nach Umbenennen, Verschieben (Überlappung), Löschen,
  Hinzufügen, Sperren, Konfidenz, Zoom, Scroll den Keyed-Stand mit einem erzwungenen Voll-Render: alles gleich,
  bei Einzeländerungen 199/200 Elemente wiederverwendet. Maus-Ziehen/Größe ändern/E2E verhalten sich wie vorher.

| Aktion | 1500 Labels (nach Schritt 2 → keyed) | 200 Labels |
|---|---|---|
| Properties-Edit (ohne Name) | 1597 → 418 ms | 219 → 63 ms |
| Umbenennen | 1900 → 656 ms | 224 → 104 ms |
| Ziehen/Größe | 1814 → 689 ms | 225 → 85 ms |
| `syncToPlayer()` | 1665 → 560 ms | 224 → 96 ms |

Gesamt seit Beginn (200 Labels): ~380 ms → 63–104 ms pro Bearbeitung.

Nächste Kandidaten (Profil 1500 Labels): `AnnotationLayer.render()` (~140 ms, zweite Ebene, in die
`_syncLinkedLabelsToLayers` spiegelt, baut noch komplett neu) → gleiches Muster; `LabelList.render()` (~200 ms bei
Umbenennen); ein Layout-Durchlauf (~90 ms). Außerdem `highlightActiveLabel` läuft bei jedem timeupdate über alle Elemente.

## Schritt 5, Teil 2 – Keyed-Render der Wellenform-Ebene (`AnnotationLayer`)

- Gemeinsame Basis in `AnnotationLayerBase`: `_reconcile(items, { signature, geometry, create, place })`,
  `_signature(item, ...flags)` (ohne Zeitstempel), `_forgetElement(el)`. Beide Ebenen nutzen sie.
- `AnnotationLayer`: Signatur = Region + gesperrt / live / Read-only; Geometrie = left/width + Stapel-Position
  (Tiefe/Reihe aus den Überlappungs-Clustern). Ziehen außerhalb von render (`_updateEditInteraction` schreibt
  Position **und** `dataset.start/end`) → `_forgetElement`, nächstes render baut das Element neu.
  Gleiches jetzt auch beim Spektrogramm-Ziehen (statt nur die Geometrie zu verwerfen).
- Prüfung: `label-render-equivalence.py` prüft beide Ebenen (alles gleich zum Voll-Render, 199/200 je Ebene
  wiederverwendet); Wellenform-Ziehen, Spektrogramm-Ziehen/Größe, E2E und Handy wie vorher.

| Aktion | 1500 Labels (Teil 1 → Teil 2) | 200 Labels |
|---|---|---|
| Properties-Edit (ohne Name) | 443 → 172 ms | 64 → 29 ms |
| Umbenennen | 649 → 439 ms | 96 → 73 ms |
| Ziehen/Größe | 674 → 421 ms | 90 → 62 ms |
| `syncToPlayer()` | 595 → 337 ms | 89 → 61 ms |

Gesamt seit Beginn (200 Labels): ~380 ms → 29–73 ms pro Bearbeitung. Player-Anteil jetzt 13–19 ms;
größter Rest ist `LabelList.render()` (~35 ms bei 200, ~200 ms bei 1500) bei Umbenennen/Ziehen.

**Behoben (war schon vorher so):** Auf der Wellenform-Spur gingen Verschieben/Größe ändern, Umbenennen
(Doppelklick/Kontextmenü) und Löschen (Kontextmenü) an der App vorbei: Der Player meldet sie als `annotationupdate` /
`annotationremove`, die App hörte nur auf die `spectrogramlabel*`-Ereignisse, der nächste Sync setzte den alten Stand
zurück. Jetzt übernimmt `main.js` beide Ereignisse in `state.labels` (Name heißt auf der Spur `species`); das Umbenennen
auf der Spur übernimmt wie im Spektrogramm auch den wissenschaftlichen Namen. Test: `tools/e2e/waveform-track-edits.py`.

**Escape bricht Ziehen ab** (Spektrogramm und Wellenform, auch Grab-Modus `g`): `_cancelEditInteraction` in der
Basisklasse setzt das Label auf den Stand vor dem Ziehen, meldet das per Vorschau-Ereignis an die andere Ebene und
schickt **kein** Update an die App. Dabei behoben: Der Leucht-Rahmen `linked-live` auf dem gespiegelten Label blieb nach
jedem Ziehen stehen (der Player setzte ihn nur bei Layer-eigenen Update-Ereignissen zurück) → neues Ereignis
`previewend`, der Player nimmt die Hervorhebung auf beiden Ebenen weg. Test: `tools/e2e/escape-cancels-drag.py`.

## Schritt 5, Teil 3 – Labelliste

- Profil (1500 Labels): `_buildRow` ~200 von 242 ms, davon ~110 ms `iconBtn` (jedes SVG per `innerHTML` neu geparst,
  3–4 Buttons pro Zeile) – und die meisten Zeilen liegen in zugeklappten Art-Gruppen, unsichtbar.
- Icons: jedes SVG einmal in ein `<template>` parsen, danach klonen.
- Zeilen zugeklappter Gruppen werden erst beim Aufklappen gebaut (`group.__buildRows`), oder wenn eine Zeile gebraucht
  wird (`_rowFor`: Auswahl, Hover vom Spektrogramm). Beim späten Bauen: aktuelles Label aus `this._labels`
  (Tags können per `updateBadges` ohne Render geändert sein), Auswahl/Mehrfachauswahl/Abspielen nachtragen
  (`_decorateRow`). Shift-Bereichsauswahl nutzt `_rowOrder` (alle Zeilen in Listenreihenfolge, wie vorher das DOM).
- Prüfung: `tools/e2e/label-list-behaviour.py` gegen alten und neuen Stand → Ausgabe identisch (inkl. HTML aller Zeilen,
  Zeitansicht); übrige E2E/Gleichwertigkeit/Handy unverändert.

| Aktion | 1500 Labels vorher → nachher | 200 Labels |
|---|---|---|
| Umbenennen | 437 → 249 ms (Liste 236 → 19 ms) | 72 → 43 ms (Liste 39 → 6 ms) |
| Ziehen/Größe | 425 → 262 ms | 75 → 43 ms |
| `syncToPlayer()` | 333 → 177 ms | 51 → 34 ms |

**Gesamt seit Beginn (200 Labels): ~380 ms → 30–43 ms pro Bearbeitung; 1500 Labels: ~3 s → 0,17–0,26 s.**
Größter Rest jetzt die Spektrogramm-Ebenen (~110–130 ms bei 1500: Layout + Signaturen aller Labels). Nächster Hebel
dort: nur den sichtbaren Zeitbereich rendern. Die Zeitansicht der Liste baut weiterhin alle Zeilen (nur Icons schneller).

## Schritt 3 – Details

Muster (bewusst schlank): ein kleiner Store mit Methoden + `subscribe`, Befehle als einfache Funktionen.
Kein Redux/Reducer, keine Command-Klassen (erst bei Bedarf für Undo/Redo), kein String-Event-Bus.

### Teil 1a – `LabelStore` (Branch `refactor/label-commands`)

- `src/app/labeling/label-store.ts` (+ `tests/label-store.test.ts`): `load(labels, entryId)`, `clear(entryId?)`,
  `claim(entryId)`, `add`, `update(ids, fn)`, `patch(id, p)`, `remove(ids | pred)`, `replaceAll`, `changed()`, `subscribe`.
  Jede Änderung setzt ein **neues** Array (in DEV eingefroren → vergessenes `push` wirft sofort).
- Labels und Besitzer-Aufnahme (`entryId`, vorher `state._labelsEntryId`) ändern sich zusammen (`load`/`clear`),
  die frühere Zwei-Zeilen-Regel „Labels leeren + Besitzer setzen“ ist an einer Stelle.
- `main.js`: alle Schreibstellen (~50) laufen über `labelStore`; `state.labels`/`state._labelsEntryId` sind nur noch Getter
  (Zuweisung wirft im Modul). Verhalten unverändert: `syncToPlayer()`-Aufrufe bleiben wie sie sind (→ Teil 1b).
- Gefunden: Die Labelliste verließ sich darauf, dass die App geänderte Labels im **selben** Array ersetzt
  (Tags-Änderung ohne Render, danach Gruppe aufklappen / Zeitansicht → alter Stand). `updateBadges` ersetzt das Label
  jetzt selbst in `this._labels`. Abgedeckt durch `tools/e2e/label-list-behaviour.py`.
- E2E-/Perf-Skripte schreiben über `window.__signavis.labelStore` statt `state.labels`.
- Prüfung: Typcheck, Tests 745/745; `label-list-behaviour`, `similar-calls/-carry/-groups` gegen `main` identisch;
  `adopt-detection`, `escape-cancels-drag`, `waveform-track-edits`, `label-template`, Render-Gleichwertigkeit ok,
  Smoke (zwei Aufnahmen, Wechsel, Reload, Handy-Breite) wie `main`, keine Seitenfehler. Benchmark 1500 Labels unverändert
  (170–270 ms). Lite-Build braucht lokal `npm run taxonomy:build` (auch auf `main`).

### Teil 1b – Speichern und Ansichten per `subscribe`

- Ein Abonnent direkt nach `labelStore`: jede Änderung speichert sofort in die Aufnahme (`saveCurrentAnnotationsIfNeeded`,
  außer `load`/`clear` – die zeigen ja den gespeicherten Stand), invalidiert die Ansichten, plant den Projekt-Autosave.
- Entscheidung: Teil-Neuzeichnen per Hinweis an der Änderung, `{ views }` (Standard: alle). Genutzt bei Ereignissen,
  die der Player selbst ausgelöst hat (`spectrogramlabelremove`, `labelrestore`: nur Liste+Badge), Bearbeitungen im
  Spektrogramm/Wellenform (`EDIT_VIEWS`), Properties-Edit (ohne `props`; ohne Liste, wenn der Name gleich bleibt) und
  laufender BirdBox-Erkennung (Liste erst am Ende). `_skipPropsRefresh` entfällt.
- Weggefallen: die `syncToPlayer()`/`syncToPlayerSoft()`/`saveCurrentAnnotationsIfNeeded()`-Aufrufe direkt nach
  Label-Änderungen. `syncToPlayer()` bleibt für Änderungen **neben** den Labels (Sets, Sichtbarkeit, Sperren) und
  für Stellen, die Label-Objekte direkt ändern (`l.layer = …`) – Kandidat für `labelStore.changed()`.
- `add` nimmt ein Label oder ein Array (`add(labels, meta?)`), nicht mehr `add(...labels)`.
- Prüfung: wie 1a – alle E2E gegen `main` identisch (Reihenfolge der Artzählung in `similar-groups` schwankt auch auf `main`),
  Render-Gleichwertigkeit ok, Benchmark unverändert (Ziehen 250–285 ms auf beiden).

### Teil 2 – Befehle statt Button-Klicks (Branch `refactor/app-commands`)

- `main.js`: `loadXenoCanto(input)`, `openFile()`, `loadDemoRecording()`, `showDailyTips()`, `saveNokeyKey()` – Buttons,
  Enter-Tasten, Hilfe-Menü, Lite-Menü und Handy-UI rufen dieselben Funktionen. `addXenoCanto` der Handy-UI gibt jetzt
  das Promise des Ladens zurück (vorher kehrte `.click()` sofort zurück, das `await` dort war wirkungslos).
- Komponenten: `XcPanel.setApiKey(key)`, `BirdNETPlayer.setDrawMode(on)`, `BirdNETPanel.analyze()` / `canAnalyze`;
  `MobileApp` startet Analysen über `analysis.run(job)` statt über die Desktop-Buttons.
- Verbleibende `.click()` sind echt: Datei-Auswahl öffnen (`<input type=file>`), Pfeiltasten in der Segment-Auswahl,
  Tagestipp schließen.
- Rest-Kopplung für Schritt 4: `MobileApp.analysis` liest weiter Desktop-Eingabefelder (Konfidenz, Overlap, Geo) und
  den Laufzustand aus dem DOM (`jobRunning`).
- Test: `tools/e2e/app-commands.py` (Hilfe-Menü → Demo, Draw-Button, Taste b, API-Key per Enter, Handy schaltet Draw
  aus, Handy-Analyse startet BirdBox ohne Desktop-Klick; optional `<xc-nummer>` für Xeno-canto – lokal ohne Proxy
  nicht ladbar: CORS/403, auch auf `main`). Übrige E2E wie `main`.
