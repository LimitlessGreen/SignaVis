# Labeling-App – Architektur-Umbau: Plan und Stand

Stand: 2026-11-16 · Branch `refactor/labeling-app-module` (lokal, noch nicht gepusht, kein PR)

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
| 2 | `LabelStore` mit Change-Events (vorhandene `src/shared/EventBus.ts`), Batching pro Frame, Dirty-Flags (Labels / Auswahl / Sets); Ansichten abonnieren statt 32× `syncToPlayer()` | offen |
| 3 | Befehle statt Button-Klicks: `loadXenoCanto(id)`, `activateRecording(id)`, `adoptLabel(id)`, `exportSet()` … – Desktop und `MobileApp` rufen dieselben Funktionen | offen |
| 4 | `main.js` nach Features aufteilen (Grenzen = vorhandene `// ──`-Abschnitte): Projektspeicher, Xeno-canto (Laden/Export/Upload), Aufnahmen (Datei/Drag&Drop/Mikro), Lite-Integration, Kontextmenüs, Startup. Je Modul `install(ctx)` mit typisiertem `AppContext`, als `.ts` **ohne** `@ts-nocheck` | offen |
| 5 | Labelliste: Keyed-Diff oder Virtualisierung – **erst messen**, nachdem Schritt 2 die überflüssigen Renders entfernt hat | offen |

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
- Devserver `npx vite --port 5191`, dann Smoke-Test mit Python-Playwright
  (`uv run --with playwright python -I smoke.py http://localhost:5191/demo/labeling-app.html`):
  Desktop „Load demo recording“, Handy-Ansicht Pixel 7, Konsolenfehler sammeln.
