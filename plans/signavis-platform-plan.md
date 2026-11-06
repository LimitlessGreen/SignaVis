# Plan: SignaVis als Plattform für große Datensätze (Coordinator + Clients)

Stand: 2026-11-06. Ziel: Einrichtungen mit vielen Leuten und vielen Rekordern
analysieren ihre Daten mit SignaVis. Clients arbeiten standalone oder verbunden
mit einem Coordinator; verbunden gibt es erweiterte Features (Perch-2-Embeddings,
agiles Modellieren, Team-Workflow).

## Leitlinien

- **Audio bleibt, wo es ist** (NAS/Fileserver). Coordinator verwaltet Metadaten,
  Labels, Embeddings, Modelle, Jobs; Clients streamen Ausschnitte.
- **Rechnen nah an den Daten**: Embeddings/Inferenz in Workern, nicht im Client.
- **Erst lokal beweisen, dann verteilen**: agiler Workflow zuerst in SignaVis Lite.
- **Interop statt Insel**: Hoplite-DB, Annota-JSON, Raven-Selection-Tables.
- **Echtzeit-Kollaboration zuletzt**, nur bei echter Nachfrage. Vorher:
  Aufgaben, Sperren, Review, asynchroner Sync.
- Keine Migrationen alter Formate (App nicht in Produktion).

## Ausgangslage (Code)

- `src-tauri-lite/` – SignaVis Lite (Tauri, Rust): `project_fs.rs`, `data_cache.rs`,
  Updater, MSIX. Einzelplatz, keine Embeddings.
- `src-tauri/` – volle Desktop-App mit Vorarbeit:
  - `corpus_store.rs` – SurrealDB (embedded/mem/ws), Tabellen `dataset`, `recording`,
    dynamische Felder (u. a. `embedding`, `umap2d`).
  - `connection_manager.rs` – `BackendMode` Local/Server, Login (JWT), Namespace.
  - `proto/jobs/v1` – JobService inkl. `JOB_TYPE_EMBEDDING`, Backends LOCAL/SERVER/CLOUD.
  - Commits 0133928 (Embeddings, UMAP, Similarity-Browser, Clustering),
    bf157d5 (Server-Modus, Auth, Sichtbarkeit).
- `src-tauri/crates/aw-dsp` – DSP/Spektrogramm, gemeinsam nutzbar.
- call-detector: ONNX-Export-Erfahrung; Plan `call-detector-integration-plan.md`.

**Phase 0 entscheidet**, ob diese Vorarbeit (SurrealDB, gRPC-Protos) Basis des
Coordinators wird oder nur Ideenlieferant ist.

## Phasen

### Phase 0 – Bestandsaufnahme & Architekturentscheid
- Vorarbeit in `src-tauri` sichten: Was funktioniert, wie sind Embeddings gespeichert,
  skaliert die Similarity-Suche (Index oder Brute Force)?
- Perch 2 prüfen: Laufzeit (TF/JAX vs. ONNX-Export), Embedding-Dim, Fenster 5 s,
  Durchsatz CPU/GPU pro Stunde Audio.
- [x] Speicher-Entscheid: SurrealDB (vorhanden, Vektorindex vorhanden) vs.
  Postgres + pgvector (bewährt, Ops-freundlich) vs. LanceDB/usearch-Dateien.
  Kriterium: 10⁷–10⁸ Embeddings, Backup, Betrieb durch Uni-IT.
- Hoplite-DB-Format ansehen (Import/Export-Kompatibilität).
- Ergebnis: kurzes ADR in `docs/architecture/`.

### Phase 1 – Agiles Modellieren lokal (SignaVis Lite)
- Embedding-Sidecar (Python oder ONNX in Rust) berechnet Perch-2-Embeddings eines
  Projektordners, inkrementell, abbrechbar; Speicher pro Projekt (Datei-Index).
- „Ähnliche finden“: Klick auf Label/Box → Top-k-Fenster, Liste mit Probehören.
- Labeling-Schleife: positiv/negativ/unsicher markieren (Review-UI-Muster).
- Linearer Klassifikator pro Klasse trainieren (im Client, Sekunden), auf alle
  Embeddings anwenden, Score-Ranking, Schwellwert, Iteration (aktive Auswahl).
- Export: Detektionen als Annota/Raven; Klassifikator-Datei.
- Test: Raufußkauz-Suche in A:\Bachelorarbeit_Sperlingskauz als Realfall.

### Phase 2 – Coordinator v1 (Datenverwaltung)
- Eigener Rust-Dienst (axum oder tonic, gRPC-Protos wiederverwenden), Docker-Compose.
- Entitäten: Organisation, Nutzer/Rollen, Projekt, Standort, Rekorder, Deployment
  (Zeitraum, Gerät, Ort), Aufnahme (Pfad-Referenz + Hash + Metadaten), Label, Modell.
- Ingest: Ordner/NAS scannen, Metadaten aus Dateinamen/Guano/AudioMoth-Header.
- Audio-Streaming-Endpoint (Range-Requests, Ausschnitte).
- Auth: lokale Accounts, später OIDC/LDAP.
- Client: Verbinden-Dialog in Lite, Projekt öffnen vom Coordinator.

### Phase 3 – Worker & Embeddings serverseitig
- Worker-Prozess (Container) zieht Jobs aus der Queue: Embedding, BirdNET,
  Call-Detector, Klassifikator-Anwendung.
- Vektorindex im Coordinator; Similarity-Suche über ganze Einrichtung.
- Agiler Workflow aus Phase 1 auf Server-Daten, Klassifikator-Versionen pro Projekt.

### Phase 4 – Team-Workflow
- Arbeitspakete zuweisen (Rekorder × Zeitraum × Art), Fortschritt.
- Sperren pro Aufnahme/Segment, asynchroner Label-Sync mit Konflikterkennung.
- Review/Zweitprüfung, Übereinstimmung zwischen Labelnden, Audit-Log.
- Auswertungen: Aktivität pro Art/Standort/Zeit, Präsenz-Kurven, CSV-Export.

### Phase 5 – Echtzeit (optional)
- Präsenz („wer ist in dieser Aufnahme“), Live-Label-Updates per WebSocket.
- Volles CRDT-Co-Editing nur, wenn Pilotnutzer es brauchen.

## Begleitend
- Pilot-Einrichtung suchen (Lehrstuhl, Vogelwarte, Naturpark); deren Fragen
  priorisieren Phase 2–4.
- Lizenz klären (MIT/AGPL-Aufteilung für Coordinator).

## Entscheidungen (2026-11-06, vom User an Claude delegiert)
1. **Coordinator-Speicher: Postgres + pgvector** (HNSW, `halfvec` für 1536-dim).
   Grund: Uni-IT kennt Postgres (Backup, Replikation, Monitoring), ausgereift bei
   10⁷–10⁸ Vektoren, Labels/Metadaten relational gut abbildbar. SurrealDB-Vorarbeit
   dient als Ideenlieferant (Datenmodell, dynamische Felder), wird nicht weitergeführt.
   **Lokal in Lite: keine DB-Server**, Embeddings als Dateien pro Projekt
   (f16-Matrix + Index-JSON; Brute-Force-Suche reicht bis ~10⁶ Fenster, sonst usearch).
2. **Embeddings: ONNX in Rust (`ort`)**, Perch 2 als fertiger ONNX-Export
   (justinchuby/Perch-onnx bzw. HF Calotriton/perch-v2-onnx, Apache 2.0, gegen TF
   validiert, max. Abweichung ~7e-6). Eingabe: 5 s @ 32 kHz Rohaudio, Ausgabe 1536-dim.
   Gleicher Code im Client und im Worker. Phase 0 prüft: Durchsatz CPU, Größe (~409 MB,
   ggf. headless/FP16), Resampling-Parität mit `aw-dsp`. Fallback: Python-Sidecar.
3. **Client: SignaVis Lite wird der einzige Client.** Volle App (`src-tauri`) einfrieren;
   brauchbare Teile (UMAP-Ansicht, Similarity-Browser, Clustering, gRPC-Protos,
   Login-Flow) gezielt nach Lite bzw. in den Coordinator übernehmen.
4. Pilot-Einrichtung: später.

## Fortschritt
- 2026-11-06 Phase 0: Crate `src-tauri/crates/aw-embed` (Perch-2-ONNX, resample_poly-Nachbau),
  Parität exakt, CPU ~22× Echtzeit. Details: `docs/architecture/adr-001-plattform-grundlagen.md`.
- 2026-11-06 Phase 0 GPU: Standardmodell `perch_v2_no_dft_embed.onnx` (49 MB):
  CPU 48×, DirectML ~1000×, CUDA (WSL) ~1300× Echtzeit, Kosinus 1,00000 zum Original.
  **Phase 0 abgeschlossen.** Rest (Rust-CUDA-Build, IO-Durchsatz) → Phase 3.
- 2026-11-06 Phase 1, Schritt 1 (7b6f412): Lite-Backend `src-tauri-lite/src/embeddings.rs` –
  Modell-Download beim 1. Gebrauch (SHA-256, Release-Asset `models-perch-v2` noch anzulegen),
  Job inkrementell/abbrechbar, Hop einstellbar (Default 5 s), Speicher
  `.signavis/embeddings/perch2/` (index.json + vectors.f16), `embed_similar` Top-k.
  Realtest 3 Sperlingskauz-WAVs: DirectML ok. Offen: DirectML.dll im Bundle, Opus/WebM-Dekodierung.
