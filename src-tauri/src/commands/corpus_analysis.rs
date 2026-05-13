// ═══════════════════════════════════════════════════════════════════════
// commands/corpus_analysis.rs — BirdNET-Inferenz auf einem Dataset
//
// Der Command `dataset_run_birdnet` startet das Python-Sidecar-Skript
// `birdnet_sidecar.py`, übergibt die Dateiliste per stdin (JSON),
// liest JSON-Lines von stdout und schreibt SoundEvents-Ergebnisse
// als dynamisches Feld in SurrealDB.
//
// Tauri-Events (global):
//   "dataset:birdnet-progress" — { jobId, datasetId, current, total, filepath }
//   "dataset:birdnet-result"   — { jobId, datasetId, recordingId, fieldName, detectionCount }
// ═══════════════════════════════════════════════════════════════════════

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::{HashMap, HashSet};
use tauri::{Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::commands::corpus::CorpusStoreState;
use crate::corpus_store::FieldDefinition;
use crate::helpers::time::now_millis;

// ── Argument-Typen ────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetBirdnetRunArgs {
    /// ID des Datasets, dessen Recordings analysiert werden sollen.
    pub dataset_id: String,
    /// Name des dynamischen Feldes, unter dem SoundEvents gespeichert werden.
    /// Beispiel: "birdnetV24". Muss `[a-zA-Z][a-zA-Z0-9_]*` entsprechen.
    pub field_name: String,
    /// Mindestkonfidenz für Detektionen (Standard: 0.25).
    pub min_conf: Option<f64>,
    /// Latitude für geografische Artenfilterung.
    pub lat: Option<f64>,
    /// Longitude für geografische Artenfilterung.
    pub lon: Option<f64>,
    /// Kalenderwoche 1-48 für saisonale Filterung.
    pub week: Option<i32>,
    /// BirdNET-Modellversion (Standard: "2.4").
    pub version: Option<String>,
    /// Aufeinanderfolgende Segmente zusammenfassen (Standard: 1 = aus).
    pub merge_consecutive: Option<i32>,
    /// Empfindlichkeit der Sigmoid-Funktion (Standard: 1.0).
    pub sensitivity: Option<f64>,
    /// Optional: Nur diese Recording-IDs analysieren. None = alle.
    pub recording_ids: Option<Vec<String>>,
    /// Pfad zum Python-Interpreter.
    /// Fallback-Reihenfolge: Argument → SIGNAVIS_PYTHON-Env → "python3".
    pub python_executable: Option<String>,
    /// Expliziter Pfad zum birdnet_sidecar.py-Skript.
    /// Fallback: Resources-Verzeichnis → Workspace-Suche (Dev-Modus).
    pub sidecar_script: Option<String>,
}

// ── Rückgabetypen ─────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BirdnetRunSummary {
    pub job_id: String,
    pub dataset_id: String,
    pub field_name: String,
    pub processed: u64,
    pub errors: u64,
    pub skipped: u64,
}

// ── Tauri-Event-Payloads ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BirdnetProgressPayload {
    job_id: String,
    dataset_id: String,
    current: u64,
    total: u64,
    filepath: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BirdnetResultPayload {
    job_id: String,
    dataset_id: String,
    recording_id: String,
    field_name: String,
    detection_count: usize,
}

// ── Hilfsfunktionen ───────────────────────────────────────────────────

/// Prüft, dass `name` nur `[a-zA-Z][a-zA-Z0-9_]*` enthält.
/// Verhindert SurrealQL-Injection bei dynamischer Query-Konstruktion.
fn sanitize_field_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("field_name darf nicht leer sein".into());
    }
    if !trimmed.chars().next().map(|c| c.is_alphabetic()).unwrap_or(false) {
        return Err("field_name muss mit einem Buchstaben beginnen".into());
    }
    if !trimmed.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return Err(
            "field_name darf nur Buchstaben, Ziffern und Unterstriche enthalten".into(),
        );
    }
    Ok(trimmed.to_string())
}

/// Löst den Python-Interpreter auf.
/// Reihenfolge: explizites Argument → SIGNAVIS_PYTHON-Env → "python3".
fn resolve_python(explicit: Option<&str>) -> String {
    if let Some(p) = explicit {
        let t = p.trim();
        if !t.is_empty() {
            return t.to_string();
        }
    }
    if let Ok(env) = std::env::var("SIGNAVIS_PYTHON") {
        let t = env.trim().to_string();
        if !t.is_empty() {
            return t;
        }
    }
    "python3".to_string()
}

/// Löst den Pfad zum `birdnet_sidecar.py`-Skript auf.
///
/// Suchreihenfolge:
/// 1. Explizites Argument
/// 2. Tauri Resource-Verzeichnis (gebundelt für Produktion)
/// 3. Workspace-Suche ab dem aktuellen Binär-Pfad aufwärts (Entwicklungsmodus)
fn resolve_sidecar_script(
    app: &tauri::AppHandle,
    explicit: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    if let Some(p) = explicit {
        let t = p.trim();
        if !t.is_empty() {
            let path = std::path::PathBuf::from(t);
            if path.exists() {
                return Ok(path);
            }
            return Err(format!("sidecar_script nicht gefunden: {t}"));
        }
    }

    // Produktion: als Tauri-Resource gebündelt
    if let Ok(res_dir) = app.path().resource_dir() {
        let candidate = res_dir.join("birdnet_sidecar.py");
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    // Entwicklungsmodus: Workspace-Verzeichnisbaum nach scripts/ durchsuchen
    let mut dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()));
    while let Some(ref d) = dir {
        let candidate = d.join("scripts").join("birdnet_sidecar.py");
        if candidate.exists() {
            return Ok(candidate);
        }
        dir = d.parent().map(|p| p.to_path_buf());
    }

    Err(
        "birdnet_sidecar.py nicht gefunden. \
         Entweder 'sidecar_script' setzen, SIGNAVIS_PYTHON konfigurieren \
         oder das Skript als Tauri-Resource bündeln."
            .into(),
    )
}

// ── Command ───────────────────────────────────────────────────────────

/// Startet eine BirdNET-Inferenz auf einem Dataset (oder einer Teilmenge).
///
/// Der Python-Sidecar-Prozess wird synchron in einem Tokio-Task ausgeführt.
/// Fortschrittsereignisse werden als Tauri-Events emittiert:
/// - `"dataset:birdnet-progress"` — nach jeder Datei
/// - `"dataset:birdnet-result"`   — nach erfolgreicher SurrealDB-Schreiboperation
///
/// Der Command blockiert bis zum Abschluss aller Dateien.
#[tauri::command]
pub async fn dataset_run_birdnet(
    app: tauri::AppHandle,
    store: State<'_, CorpusStoreState>,
    args: DatasetBirdnetRunArgs,
) -> Result<BirdnetRunSummary, String> {
    // ── Validierung ───────────────────────────────────────────────────
    let field_name = sanitize_field_name(&args.field_name)?;
    let dataset_id = args.dataset_id.trim().to_string();
    if dataset_id.is_empty() {
        return Err("dataset_id darf nicht leer sein".into());
    }

    // Dataset muss existieren
    store
        .dataset_get(&dataset_id)
        .await?
        .ok_or_else(|| format!("Dataset '{dataset_id}' nicht gefunden"))?;

    let job_id = uuid::Uuid::new_v4().to_string();

    // ── Recordings laden ──────────────────────────────────────────────
    let all_recordings = store.recording_list_by_dataset_all(&dataset_id).await?;

    let recordings: Vec<_> = if let Some(ref ids) = args.recording_ids {
        let id_set: HashSet<&str> = ids.iter().map(|s| s.as_str()).collect();
        all_recordings
            .into_iter()
            .filter(|r| id_set.contains(r.id.as_str()))
            .collect()
    } else {
        all_recordings
    };

    if recordings.is_empty() {
        return Ok(BirdnetRunSummary {
            job_id,
            dataset_id,
            field_name,
            processed: 0,
            errors: 0,
            skipped: 0,
        });
    }

    // filepath → recording_id lookup
    let filepath_to_id: HashMap<String, String> = recordings
        .iter()
        .map(|r| (r.filepath.clone(), r.id.clone()))
        .collect();

    let filepaths: Vec<String> = recordings.iter().map(|r| r.filepath.clone()).collect();
    let total = filepaths.len() as u64;

    // ── Python-Prozess aufsetzen ──────────────────────────────────────
    let python_exe = resolve_python(args.python_executable.as_deref());
    let script_path = resolve_sidecar_script(&app, args.sidecar_script.as_deref())?;

    let sidecar_config = serde_json::json!({
        "filepaths": filepaths,
        "min_conf":          args.min_conf.unwrap_or(0.25),
        "lat":               args.lat,
        "lon":               args.lon,
        "week":              args.week,
        "version":           args.version.as_deref().unwrap_or("2.4"),
        "merge_consecutive": args.merge_consecutive.unwrap_or(1),
        "sensitivity":       args.sensitivity.unwrap_or(1.0),
    });

    let config_line = serde_json::to_string(&sidecar_config)
        .map_err(|e| format!("Konfiguration serialisieren: {e}"))?;

    // Prozess starten (stderr wird an Tauri-Konsole weitergeleitet)
    let mut child = tokio::process::Command::new(&python_exe)
        .arg(&script_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Python ({python_exe}) konnte nicht gestartet werden: {e}"))?;

    // Config per stdin schicken, dann EOF senden
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(format!("{config_line}\n").as_bytes())
            .await
            .map_err(|e| format!("stdin schreiben: {e}"))?;
        // stdin wird hier gedroppt → EOF für den Child-Prozess
    }

    // ── stdout zeilenweise verarbeiten ────────────────────────────────
    let stdout = child
        .stdout
        .take()
        .ok_or("stdout des Child-Prozesses nicht verfügbar")?;
    let mut lines = BufReader::new(stdout).lines();

    let mut processed: u64 = 0;
    let mut errors: u64 = 0;
    let mut skipped: u64 = 0;

    while let Some(line) = lines
        .next_line()
        .await
        .map_err(|e| format!("stdout lesen: {e}"))?
    {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        let event: JsonValue = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue, // Malformed line — ignorieren
        };

        match event.get("type").and_then(|v| v.as_str()) {
            Some("progress") => {
                let current = event["current"].as_u64().unwrap_or(0);
                let total_ev = event["total"].as_u64().unwrap_or(total);
                let filepath = event["filepath"].as_str().map(|s| s.to_string());
                let _ = app.emit(
                    "dataset:birdnet-progress",
                    BirdnetProgressPayload {
                        job_id: job_id.clone(),
                        dataset_id: dataset_id.clone(),
                        current,
                        total: total_ev,
                        filepath,
                    },
                );
            }

            Some("result") => {
                let filepath = match event["filepath"].as_str() {
                    Some(p) => p.to_string(),
                    None => continue,
                };
                let rec_id = match filepath_to_id.get(&filepath) {
                    Some(id) => id.clone(),
                    None => {
                        skipped += 1;
                        continue;
                    }
                };

                // SoundEvents-Dokument bauen (entspricht domain/corpus/types.ts#SoundEvents)
                let sound_events = serde_json::json!({
                    "soundEvents": event["detections"],
                });

                store
                    .recording_set_dynamic_field(&rec_id, &field_name, sound_events)
                    .await?;

                processed += 1;
                let detection_count = event["detections"]
                    .as_array()
                    .map(|a| a.len())
                    .unwrap_or(0);

                let _ = app.emit(
                    "dataset:birdnet-result",
                    BirdnetResultPayload {
                        job_id: job_id.clone(),
                        dataset_id: dataset_id.clone(),
                        recording_id: rec_id,
                        field_name: field_name.clone(),
                        detection_count,
                    },
                );
            }

            Some("error") => {
                errors += 1;
            }

            Some("done") => break,

            _ => {}
        }
    }

    // Child-Prozess einsammeln (verhindert Zombie-Prozesse)
    let _ = child.wait().await;

    // ── Feld ins Dataset-Schema eintragen (idempotent) ─────────────────
    if processed > 0 {
        if let Ok(Some(mut dataset)) = store.dataset_get(&dataset_id).await {
            if !dataset.field_schema.iter().any(|f| f.name == field_name) {
                dataset.field_schema.push(FieldDefinition {
                    name: field_name.clone(),
                    kind: "sound_events".into(),
                    description: Some(format!(
                        "BirdNET-Ergebnisse ({})",
                        args.version.as_deref().unwrap_or("2.4")
                    )),
                    group: Some("BirdNET".into()),
                    system: false,
                });
                if let Ok(now) = now_millis() {
                    dataset.updated_at = now as i64;
                }
                let _ = store.dataset_update(&dataset).await;
            }
        }
    }

    Ok(BirdnetRunSummary {
        job_id,
        dataset_id,
        field_name,
        processed,
        errors,
        skipped,
    })
}
