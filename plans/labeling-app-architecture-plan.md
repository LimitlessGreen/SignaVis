# Labeling-App – Architektur-Umbau: Plan und Stand

Stand: 2026-11-16 · Branch `refactor/labeling-app-module` (lokal, noch nicht gepusht, kein PR) · Schritte 1–2 fertig

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
| 3 | Befehle statt Button-Klicks: `loadXenoCanto(id)`, `activateRecording(id)`, `adoptLabel(id)`, `exportSet()` … – Desktop und `MobileApp` rufen dieselben Funktionen. Dabei Label-Änderungen in einen `LabelStore` (Mutationen nur über Methoden, die selbst `labelViews.invalidate` auslösen) – war ursprünglich Teil von Schritt 2 | offen |
| 4 | `main.js` nach Features aufteilen (Grenzen = vorhandene `// ──`-Abschnitte): Projektspeicher, Xeno-canto (Laden/Export/Upload), Aufnahmen (Datei/Drag&Drop/Mikro), Lite-Integration, Kontextmenüs, Startup. Je Modul `install(ctx)` mit typisiertem `AppContext`, als `.ts` **ohne** `@ts-nocheck` | offen |
| 5 | **Vorziehen (größter Hebel laut Messung):** `SpectrogramLabelLayer.render()` baut bei jeder Änderung alle Label-Elemente neu (`innerHTML = ''`). Keyed-Update (Elemente je id wiederverwenden, nur geänderte anfassen) und/oder nur den sichtbaren Zeitbereich rendern. Danach dasselbe für `LabelList.render()` | offen |

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
