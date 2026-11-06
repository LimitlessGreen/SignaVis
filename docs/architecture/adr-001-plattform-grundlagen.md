# ADR 001 – Grundlagen der SignaVis-Plattform

Stand: 2026-11-06 · Plan: `plans/signavis-platform-plan.md` (Phase 0)

## Entscheidungen

| Thema | Entscheidung |
|---|---|
| Client | SignaVis Lite ist der einzige Client; volle App (`src-tauri`) eingefroren |
| Coordinator-Speicher | Postgres + pgvector (`halfvec`, HNSW) |
| Lokaler Speicher (Lite) | Dateien pro Projekt, kein DB-Server |
| Embedding-Modell | Perch 2 als ONNX (justinchuby/Perch-onnx, Apache 2.0) |
| Laufzeit | Rust-Crate `aw-embed` (ort 2.0.0-rc.10), gleich in Client und Worker |

## Befund: Vorarbeit in `src-tauri`

- Embeddings sind **eine pro Datei** (BirdNET, Mittelwert über 3-s-Segmente,
  Python-Sidecar `scripts/embedding_sidecar.py`), gespeichert als JSON-Feld in SurrealDB.
- Ähnlichkeitssuche lädt alle Dokumente und vergleicht linear (`corpus_analysis.rs`).
- Für agiles Modellieren braucht es Embeddings **pro 5-s-Fenster** – das Datenmodell
  ist nicht übertragbar. Übernehmen: UI-Ideen (EmbeddingScatterPanel,
  SimilarityBrowserPanel), Job-Protos, Login-Ablauf.

## Befund: Perch 2 in Rust

Modell: Eingabe `inputs [batch, 160000]` (5 s @ 32 kHz, Rohaudio, Spektrogramm im Modell),
Ausgaben `embedding [batch, 1536]`, `spatial_embedding`, `spectrogram`, `label [batch, 14795]`.
Größe 409 MB (FP32).

Parität (`crates/aw-embed/scripts/parity.py`, soundscape.wav 48 kHz, XC204513 44,1 kHz):

- Inferenz Rust-ORT vs. Python-ORT, gleiches Audio: max |Δ| ≈ 2e-7.
- Resampling: `aw_embed::resample_poly` ist ein Nachbau von `scipy.signal.resample_poly`
  → SNR ≈ 140 dB, Kosinus 1,00000. (`rubato` lag 85 Samples daneben, 28 dB – verworfen.)
- Zum Vergleich: 0,1 s Zeitversatz ändert Embeddings auf Kosinus ≈ 0,97–0,98.

Durchsatz CPU (12 logische Kerne, Windows):

| Variante | ms/Fenster | Echtzeitfaktor |
|---|---|---|
| threads 8, batch 8 | ~210 | 22–23× |
| threads 12, batch 1 | ~307 | 16× |
| threads 4, batch 8 | ~243 | 21× |
| `perch_v2_no_dft` | ~237 | 21× |
| Python ORT (Referenz) | ~230–245 | ≈ gleich |

Mehr Threads bringen kaum etwas → speicher-/bandbreitenbegrenzt; Batch 8 sinnvoll.
Resampling ≈ 1 % der Inferenzzeit.

## Folgen

- **Client (Lite):** ~20× Echtzeit → 100 h Audio ≈ 5 h Rechenzeit. Für Einzelprojekte ok,
  im Hintergrund und inkrementell. Modell nicht ins Installationspaket, sondern bei
  Bedarf herunterladen (409 MB).
- **Einrichtung:** 1 Rekorder × 1 Jahr 24/7 = 8760 h Audio ≈ 400 h CPU. Bei vielen
  Rekordern sind **GPU-Worker** Pflicht (ort CUDA/DirectML-EP prüfen) – Phase 3.
- **Speicher:** 1536 × f16 = 3 KB pro 5 s ≈ 2,2 MB pro Stunde ≈ 19 GB pro
  Rekorder-Jahr. 10⁸ Fenster ≈ 300 GB Vektoren. Optionen für Phase 2/3: Hop = Fenster
  (kein Überlapp), PCA/Quantisierung für den Index, volle Vektoren auf Platte.

## Offen

- GPU-Execution-Provider (CUDA in WSL/Linux, DirectML unter Windows) messen.
- FP16-/INT8-Variante bzw. Modell ohne Klassifikationskopf (kleiner, schneller).
- Hop/Überlapp für die Suche (Perch-Agile nutzt 5 s ohne Überlapp).
