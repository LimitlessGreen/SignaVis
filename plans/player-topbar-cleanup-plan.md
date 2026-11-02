# Player + Topbar aufräumen – Plan (2026-11-02)

Basis: Screenshots labeling-app.html (Dev-Server :5287, birdsong.wav) bei
1920×1080, 1440×900, 1366×768, 1280×720, 1024×768, 768×1024, jeweils mit/ohne linkes Panel.

## Befund

**App-Topbar**
- 1920: Suche zentriert, rechts Sprache / XC API Key / Theme / ? lose verteilt, viel Leerraum.
- 768: Sprache + XC-Key verschwinden ersatzlos (nur Trennstriche bleiben stehen).
- Dateiname klein/grau neben Logo, kein Status (ungespeichert, Länge, SR).
- Sprache und XC-Key sind Einstellungen, keine Topbar-Aktionen.

**Player-Toolbar** (`_toolbar.scss`, `flex-wrap: wrap`)
- 1920: eine Zeile, aber fünf Gruppen gleich gewichtet; Time/Freq-Zoom sitzen mittendrin.
- ≤1440 mit Panel bzw. ≤1024: Umbruch in 2–3 Zeilen, Gruppen brechen *mitten drin*
  (1024 mit Panel: Draw/Stamp | Snap/Zoom auf eigener Zeile; 768: Snap/Zoom allein in Zeile 3).
- Time/Freq-Zoom springt je nach Breite von der Toolbar unter das Spektrogramm
  → Position der Bedienelemente nicht stabil.
- Leere Trenner (`|`) am Zeilenanfang (1366 Zeile 3).
- Mischung Text-Buttons (Follow/Loop/Crosshair/Fit/Reset) und Icon+Text (Draw/Stamp…);
  "Norm", "×1"-Dropdown ohne Kontext.
- Statusleiste unten: bei 1024 überlappen "Beta · Report issues" und Zeitbereich.

## Ziel-Layout

Eine feste Zeile mit drei Zonen, kein Wrap:

```
[⏮ ◀ ▶ ■ ▶▶ ⏭  00:00.0/00:08.0 | 🔊 ×1]   [Follow Loop ⌖ | Fit ⟲]   [✎ Draw ▢ Stamp ⇲ Snap 🔍 Zoom]
 Transport (links, fix)                     Ansicht (Mitte)           Werkzeuge (rechts, fix)
```
- Time/Freq-Zoom: im Widescreen (Player-Breite ≥ ~1500 px) oben in der Toolbar als 4. Zone ganz rechts,
  darunter fest in der Leiste unter dem Spektrogramm. Umschalten nur an diesem einen Breakpoint, nie per Wrap.
- Volume-Slider → Popover am Lautsprecher-Icon; "Norm" in dieses Popover.
- Responsiv per **Container Query** auf den Player (nicht Viewport, weil Seitenpanels die Breite bestimmen):
  - ≥ 1100 px: Icon + Text
  - 800–1100 px: Ansicht + Werkzeuge nur Icons (Tooltip mit Shortcut)
  - < 800 px: Ansicht-Gruppe in "⋯"-Overflow-Menü, Transport + Werkzeuge bleiben

## Phasen

1. **Toolbar-Struktur** – `template.ts`: drei Gruppen-Container (`transport`, `view`, `tools`),
   `flex-wrap: nowrap`, Zoom-Slider oben (Widescreen) bzw. Unterleiste (sonst), umgeschaltet per Container Query. Trenner nur noch zwischen Gruppen per CSS-gap/border.
2. **Container Queries** – `_toolbar.scss`: `container-type: inline-size` auf Player-Root, Breakpoints wie oben;
   Text-Labels per Klasse `.tb-label` ausblendbar; einheitliche Icons für Follow/Loop/Crosshair/Fit/Reset.
   Crosshair bleibt in der Toolbar, wird bei engerer Breite zum Icon (⌖).
   Fit und Reset bleiben getrennt (Fit = ganze Datei zeitlich einpassen; Reset = Standard-Zoom,
   Sprung an den Anfang, Frequenzbereich zurücksetzen), bekommen aber klarere Tooltips/Icons.
3. **Overflow-Menü** – "⋯"-Button, der versteckte Gruppen als Dropdown zeigt (Toggle-Zustand sichtbar).
4. **Audio-Popover** – Volume + Norm + Geschwindigkeit hinter 🔊; ×1 bleibt als kompakte Anzeige.
5. **App-Topbar** – Sprache + XC API Key bleiben sichtbar oben; erst wenn die Breite nicht reicht,
   wandern sie in ein ⚙-Menü (statt heute ersatzlos zu verschwinden);
   Dateiname prominenter mit Dirty-Punkt; Suche bei < 900 px als Icon, das aufklappt.
6. **Statusleiste** – Mittelteil (Beta/Report) bei < 1100 px ausblenden bzw. ellipsieren; Überlappung beheben.
7. **Verifikation** – Screenshot-Skript (6 Größen × Panel offen/zu) erneut laufen lassen, Ziel: nirgends Umbruch,
   keine Überlappung; Smoke-Test Shortcuts/Toggles.

## Entschieden (2026-11-02)
- Zoom oben im Widescreen, Key/Sprache nur bei Platzmangel ins Menü, Crosshair bleibt (Icon erlaubt), Fit/Reset getrennt.
