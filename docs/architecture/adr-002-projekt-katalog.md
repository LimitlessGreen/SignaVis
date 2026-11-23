# ADR 002 – Projekt-Katalog (SQLite) für die Datenverwaltung

Stand: 2026-11-20 · Phase 0 des Datenverwaltungs-Plans (data management plan)

## Entscheidungen

| Thema | Entscheidung |
|---|---|
| Katalog in Lite | SQLite-Datei `.signavis/catalog.sqlite` pro Projekt (rusqlite, `bundled`), WAL |
| Inhalt | Wurzeln, Assets, Aufnahmen, Metadaten, Standorte/Rekorder/Deployments, Datensätze (mit Zeitfenstern), Labels, Läufe + Detektionen, Embedding-Zuordnung, Jobs |
| Vektoren | bleiben Dateien (`vectors.f16`, ab ~10⁶ Fenstern `usearch`), nicht in SQLite |
| Labels | in SQLite, ein Modell für Editor-Boxen und agile Fenster-Labels (`polarity` present/absent/unsure); Git-Diff über JSONL-Export |
| Vorhersagen | eigene Tabellen `run`/`detection`, getrennt von Labels |
| Browser | kein Katalog; kleine Projekte wie bisher (Projekt-JSON), später Client |
| Import | Import-Profile: freie Feldnamen in Pfadmustern, Zuordnung zu Rollen (Standort, Rekorder, Start, Datum, Uhrzeit, Metadatum), keine festen Ordnerkonventionen |
| Coordinator | gleiches Schema nach Postgres (lokale INTEGER-IDs + `uid` UUIDv7, UTC-ms) |

Passt zu ADR 001 („Lite: Dateien pro Projekt, kein DB-Server“): SQLite ist eine eingebettete
Datei. Gleiches Muster wie Hoplite (SQLite + usearch).

## Messung (Spike, Crate `src-tauri/crates/aw-catalog`, `catalog-bench`)

Realer Feldaufnahme-Datensatz auf externer USB-HDD, Linux, Release-Build:
~103 k WAV-Dateien in Ordnern nach Rekorder/Standort/Woche, ein Rekordertausch als
verschachtelter Ordner, abgeleitete Ordner (Ergebnisse, Proben, Segmente), ~6,8 k
BirdNET-Selection-Tables.

| Schritt | Ergebnis |
|---|---|
| Scan | 2,2 s (0,35 s warm) |
| Import mit 2 Pfadmustern (Profil mit Rollen), 1 Transaktion | 3,4 s, alle bis auf 1 Fremddatei erkannt |
| Erneuter Import (alles bekannt) | 0,5 s |
| Selection-Tables als Lauf (16 k Detektionen) | 0,25 s warm |
| 100 k / 1 M Labels einfügen | 1,2 s / 23,6 s |
| Statistik/Heatmap-Aggregate | 40–125 ms |
| Filter (Standort + Nacht + Monat), Detektionsabfragen, Einzel-Update | 0,1–5 ms |
| Tabellenseite mit OFFSET 50 000 | 37 ms |
| Größe | 72 MB (100 k Aufnahmen + 100 k Labels); 1 M Labels ≈ +160 MB |

## Folgerungen für Phase 1

- Geschwindigkeit reicht deutlich; Engpass ist das Einlesen von Audio-Headern (Dauer,
  Samplerate), nicht der Katalog → Header lesen als Hintergrund-Job, nicht im Import.
- Größe: ~1 KB pro Aufnahme, davon ~40 % `uid`-Texte mit eindeutigen Indizes und ~30 %
  `meta`. Rollenfelder stehen nicht mehr zusätzlich in `meta` (98 → 72 MB). Offen: `uid` als
  16-Byte-BLOB.
- Tabellenseiten per Keyset statt `OFFSET`, mit `id` als Gleichstand-Brecher:
  `start_ms > ? OR (start_ms = ? AND id > ?)`. Aufnahmen ohne Startzeit sortieren zuerst (NULL) und
  haben einen eigenen Zweig: `(start_ms IS NULL AND id > ?) OR start_ms IS NOT NULL` (so macht es `query::list`).
- Import-Vorschau: Unmatched-Liste und Zählung pro Muster sind schon da.
- Musterfelder sind lazy: `Woche_{week:int}*` erkennt auch `Woche_3_Rest`.
- Zeitzone: im Spike fester Offset; Phase 1 braucht IANA-Zone (Sommerzeit!) pro Standort.
