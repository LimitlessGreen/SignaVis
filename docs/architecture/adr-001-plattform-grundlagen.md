# ADR 001 – Grundlagen der SignaVis-Plattform

Stand: 2026-11-06 · Phase 0 of the platform plan

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

## Befund: GPU und Modellvarianten (RTX 2060 SUPER, 8 GB)

`perch_v2_embed.onnx` = Graph bis `embedding` zugeschnitten (`scripts/make_headless.py`),
ohne Klassifikationskopf: 409 MB → 45–49 MB. Grund zusätzlich: DirectML stürzt im
Kopf (ProtoPNet-MatMul) bei Batch > 1 ab.

Messung mit 30 min Audio (360 Fenster), Echtzeitfaktor:

| Modell | CPU (8 Thr., Batch 8) | DirectML (Win, Batch 32–64) | CUDA (WSL, ORT 1.22, Batch 32) |
|---|---|---|---|
| perch_v2 (voll) | 22× | – (Absturz bei Batch > 1) | – |
| perch_v2_embed | 30–39× | ~1000× | 177× (DFT fällt auf CPU zurück) |
| **perch_v2_no_dft_embed** | **48×** | **~1000×** | **~1300×** |

- Genauigkeit `no_dft_embed` (CPU und DirectML) gegen das volle Modell: Kosinus 1,00000.
- **Standardmodell: `perch_v2_no_dft_embed.onnx` (49 MB).**
- DirectML: Batch-Form muss gleich bleiben, sonst Neukompilierung → letzter Batch wird
  aufgefüllt (`Embedder::embed`). Batch 32–64 optimal, 96 sprengt 8 GB VRAM.
- CUDA in WSL: `onnxruntime-gpu[cuda,cudnn]==1.22.0` (CUDA 12) + `ort.preload_dlls()`;
  das aktuelle Paket erwartet CUDA 13 (`libcublasLt.so.13`). Rust-`ort` mit Feature
  `cuda` unter Linux für den Worker noch nicht gebaut.

## Folgen

- **Client (Lite):** DirectML als Standard unter Windows (~1000× → 100 h Audio in ~6 min),
  CPU-Fallback 48× (100 h ≈ 2 h). Modell (49 MB) bei Bedarf herunterladen oder mitliefern.
- **Einrichtung:** 1 Rekorder-Jahr (8760 h) ≈ 7 h auf einer Mittelklasse-GPU, ≈ 180 h CPU.
  GPU-Worker im Coordinator sinnvoll, aber auch eine Workstation schafft ~1000 Rekorder-Tage
  pro Tag. Engpass wird eher Dekodieren/Einlesen vom NAS als die Inferenz.
- **Speicher:** 1536 × f16 = 3 KB pro 5 s ≈ 2,2 MB pro Stunde ≈ 19 GB pro
  Rekorder-Jahr. 10⁸ Fenster ≈ 300 GB Vektoren. Optionen für Phase 2/3: Hop = Fenster
  (kein Überlapp), PCA/Quantisierung für den Index, volle Vektoren auf Platte.

## Offen

- Rust-`ort` mit CUDA unter Linux bauen (Worker, Phase 3).
- FP16-/INT8-Variante (nach den GPU-Werten nicht dringend).
- Dekodier-/IO-Durchsatz (FLAC/MP3, NAS) messen – vermutlich der eigentliche Engpass.
- Hop/Überlapp für die Suche (Perch-Agile nutzt 5 s ohne Überlapp).
