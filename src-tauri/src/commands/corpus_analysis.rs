// ═══════════════════════════════════════════════════════════════════════
// commands/corpus_analysis.rs — BirdNET-Inferenz auf einem Dataset
//
// The command `dataset_run_birdnet` launches the Python sidecar script
// `birdnet_sidecar.py`, passes the file list via stdin (JSON),
// reads JSON lines from stdout and writes SoundEvents results
// as a dynamic field into SurrealDB.
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
use crate::corpus_store::{AnalysisRunRecord, FieldDefinition};

// ── Argument types ────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetBirdnetRunArgs {
    /// ID of the dataset whose recordings should be analysed.
    pub dataset_id: String,
    /// Name of the dynamic field under which SoundEvents are stored.
    /// Example: "birdnetV24". Must match `[a-zA-Z][a-zA-Z0-9_]*`.
    pub field_name: String,
    /// Minimum confidence for detections (default: 0.25).
    pub min_conf: Option<f64>,
    /// Latitude for geographic species filtering.
    pub lat: Option<f64>,
    /// Longitude for geographic species filtering.
    pub lon: Option<f64>,
    /// Calendar week 1-48 for seasonal filtering.
    pub week: Option<i32>,
    /// BirdNET model version (default: "2.4").
    pub version: Option<String>,
    /// Merge consecutive segments (default: 1 = off).
    pub merge_consecutive: Option<i32>,
    /// Sigmoid function sensitivity (default: 1.0).
    pub sensitivity: Option<f64>,
    /// Optional: analyse only these recording IDs. None = all.
    pub recording_ids: Option<Vec<String>>,
    /// Path to the Python interpreter.
    /// Fallback order: argument → SIGNAVIS_PYTHON env → "python3".
    pub python_executable: Option<String>,
    /// Explicit path to the birdnet_sidecar.py script.
    /// Fallback: resources directory → workspace search (dev mode).
    pub sidecar_script: Option<String>,
}

// ── Return types ──────────────────────────────────────────────────────

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

// ── Tauri event payloads ──────────────────────────────────────────────

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

// ── Helper functions ──────────────────────────────────────────────────

/// Verifies that `name` contains only `[a-zA-Z][a-zA-Z0-9_]*`.
/// Prevents SurrealQL injection in dynamic query construction.
fn sanitize_field_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("field_name must not be empty".into());
    }
    if !trimmed.chars().next().map(|c| c.is_alphabetic()).unwrap_or(false) {
        return Err("field_name must start with a letter".into());
    }
    if !trimmed.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return Err(
            "field_name may only contain letters, digits, and underscores".into(),
        );
    }
    Ok(trimmed.to_string())
}

/// Resolves the Python interpreter.
/// Order: explicit argument → SIGNAVIS_PYTHON env → "python3".
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

/// Resolves the path to the `birdnet_sidecar.py` script.
///
/// Search order:
/// 1. Explicit argument
/// 2. Tauri resource directory (bundled for production)
/// 3. Workspace search upward from the current binary path (development mode)
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
            return Err(format!("sidecar_script not found: {t}"));
        }
    }

    // Production: bundled as a Tauri resource
    if let Ok(res_dir) = app.path().resource_dir() {
        let candidate = res_dir.join("birdnet_sidecar.py");
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    // Development mode: search workspace directory tree for scripts/
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
        "birdnet_sidecar.py not found. \
         Either set 'sidecar_script', configure SIGNAVIS_PYTHON, \
         or bundle the script as a Tauri resource."
            .into(),
    )
}

// ── Command ───────────────────────────────────────────────────────────

/// Starts a BirdNET inference run on a dataset (or a subset).
///
/// Returns immediately with a `jobId`. The actual processing runs in a
/// background Tokio task. Progress is reported via Tauri events:
/// - `"dataset:birdnet-progress"` — { jobId, datasetId, current, total, filepath }
/// - `"dataset:birdnet-result"`   — { jobId, datasetId, recordingId, fieldName, detectionCount }
/// - `"dataset:birdnet-done"`     — { jobId, datasetId, processed, errors, skipped, status }
#[tauri::command]
pub async fn dataset_run_birdnet(
    app: tauri::AppHandle,
    store: State<'_, CorpusStoreState>,
    args: DatasetBirdnetRunArgs,
) -> Result<BirdnetRunSummary, String> {
    // ── Validate + resolve paths (must happen in the command, not the task) ──
    let field_name = sanitize_field_name(&args.field_name)?;
    let dataset_id = args.dataset_id.trim().to_string();
    if dataset_id.is_empty() {
        return Err("dataset_id must not be empty".into());
    }
    store
        .dataset_get(&dataset_id)
        .await?
        .ok_or_else(|| format!("Dataset '{dataset_id}' not found"))?;

    let python_exe = resolve_python(args.python_executable.as_deref());
    let script_path = resolve_sidecar_script(&app, args.sidecar_script.as_deref())?;

    let job_id = uuid::Uuid::new_v4().to_string();
    let version = args.version.clone().unwrap_or_else(|| "2.4".into());

    // ── Register run as "queued" before spawning ──────────────────────
    let run_record = AnalysisRunRecord {
        key: job_id.clone(),
        run_type: "inference".into(),
        config: serde_json::json!({
            "model": "birdnet",
            "version": version,
            "outputField": field_name,
            "minConf": args.min_conf.unwrap_or(0.25),
            "lat": args.lat,
            "lon": args.lon,
            "week": args.week,
        }),
        status: "queued".into(),
        started_at: None,
        completed_at: None,
        processed: None,
        errors: None,
        error_message: None,
    };
    store.upsert_analysis_run(&dataset_id, &run_record).await?;

    // ── Snapshot everything the task needs (no State refs cross await) ─
    let store_arc = std::sync::Arc::clone(&*store);
    let app_clone = app.clone();
    let job_id_task = job_id.clone();
    let dataset_id_task = dataset_id.clone();
    let field_name_task = field_name.clone();
    let recording_ids = args.recording_ids.clone();
    let min_conf = args.min_conf.unwrap_or(0.25);
    let lat = args.lat;
    let lon = args.lon;
    let week = args.week;
    let merge_consecutive = args.merge_consecutive.unwrap_or(1);
    let sensitivity = args.sensitivity.unwrap_or(1.0);
    let version_task = version.clone();

    tokio::spawn(async move {
        let result = run_birdnet_task(
            app_clone,
            store_arc,
            job_id_task,
            dataset_id_task,
            field_name_task,
            recording_ids,
            min_conf,
            lat,
            lon,
            week,
            merge_consecutive,
            sensitivity,
            version_task,
            python_exe,
            script_path,
        ).await;
        if let Err(e) = result {
            // Error is already logged via the "done" event emitted inside the task on failure.
            eprintln!("BirdNET task failed: {e}");
        }
    });

    Ok(BirdnetRunSummary {
        job_id,
        dataset_id,
        field_name,
        processed: 0,
        errors: 0,
        skipped: 0,
    })
}

// ── Run query commands ────────────────────────────────────────────────

/// Returns all analysis runs on a dataset as a JSON array.
#[tauri::command]
pub async fn dataset_list_runs(
    store: State<'_, CorpusStoreState>,
    dataset_id: String,
) -> Result<Vec<JsonValue>, String> {
    let dataset = store
        .dataset_get(&dataset_id)
        .await?
        .ok_or_else(|| format!("dataset_list_runs: not found: {dataset_id}"))?;
    Ok(dataset.analysis_runs.into_values().collect())
}

/// Returns a single analysis run by jobId.
#[tauri::command]
pub async fn dataset_get_run(
    store: State<'_, CorpusStoreState>,
    dataset_id: String,
    job_id: String,
) -> Result<Option<JsonValue>, String> {
    let dataset = store
        .dataset_get(&dataset_id)
        .await?
        .ok_or_else(|| format!("dataset_get_run: dataset not found: {dataset_id}"))?;
    Ok(dataset.analysis_runs.into_values().find(|v| {
        v.get("key").and_then(|k| k.as_str()) == Some(&job_id)
    }))
}

// ── Background task ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BirdnetDonePayload {
    job_id: String,
    dataset_id: String,
    processed: u64,
    errors: u64,
    skipped: u64,
    status: String, // "completed" | "failed"
    error_message: Option<String>,
}

#[allow(clippy::too_many_arguments)]
async fn run_birdnet_task(
    app: tauri::AppHandle,
    store: std::sync::Arc<crate::corpus_store::CorpusStore>,
    job_id: String,
    dataset_id: String,
    field_name: String,
    recording_ids: Option<Vec<String>>,
    min_conf: f64,
    lat: Option<f64>,
    lon: Option<f64>,
    week: Option<i32>,
    merge_consecutive: i32,
    sensitivity: f64,
    version: String,
    python_exe: String,
    script_path: std::path::PathBuf,
) -> Result<(), String> {
    let now = || {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64
    };

    // Mark as running
    let mut run = AnalysisRunRecord {
        key: job_id.clone(),
        run_type: "inference".into(),
        config: serde_json::json!({
            "model": "birdnet",
            "version": version,
            "outputField": field_name,
            "minConf": min_conf,
            "lat": lat, "lon": lon, "week": week,
        }),
        status: "running".into(),
        started_at: Some(now()),
        completed_at: None,
        processed: None,
        errors: None,
        error_message: None,
    };
    let _ = store.upsert_analysis_run(&dataset_id, &run).await;

    // Load recordings
    let all = match store.recording_list_by_dataset_all(&dataset_id).await {
        Ok(v) => v,
        Err(e) => {
            run.status = "failed".into();
            run.error_message = Some(e.clone());
            run.completed_at = Some(now());
            let _ = store.upsert_analysis_run(&dataset_id, &run).await;
            emit_done(&app, &job_id, &dataset_id, 0, 0, 0, "failed", Some(&e));
            return Err(e);
        }
    };

    let recordings: Vec<_> = if let Some(ref ids) = recording_ids {
        let id_set: HashSet<&str> = ids.iter().map(|s| s.as_str()).collect();
        all.into_iter().filter(|r| id_set.contains(r.id.as_str())).collect()
    } else {
        all
    };

    if recordings.is_empty() {
        run.status = "completed".into();
        run.processed = Some(0);
        run.errors = Some(0);
        run.completed_at = Some(now());
        let _ = store.upsert_analysis_run(&dataset_id, &run).await;
        emit_done(&app, &job_id, &dataset_id, 0, 0, 0, "completed", None);
        return Ok(());
    }

    let filepath_to_id: HashMap<String, String> =
        recordings.iter().map(|r| (r.filepath.clone(), r.id.clone())).collect();
    let filepaths: Vec<String> = recordings.iter().map(|r| r.filepath.clone()).collect();
    let total = filepaths.len() as u64;

    // Build sidecar config
    let sidecar_config = serde_json::json!({
        "filepaths": filepaths,
        "min_conf": min_conf,
        "lat": lat, "lon": lon, "week": week,
        "version": version,
        "merge_consecutive": merge_consecutive,
        "sensitivity": sensitivity,
    });
    let config_line = serde_json::to_string(&sidecar_config)
        .map_err(|e| format!("serialising sidecar config: {e}"))?;

    // Spawn Python
    let mut child = match tokio::process::Command::new(&python_exe)
        .arg(&script_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("Python ({python_exe}) could not be started: {e}");
            run.status = "failed".into();
            run.error_message = Some(msg.clone());
            run.completed_at = Some(now());
            let _ = store.upsert_analysis_run(&dataset_id, &run).await;
            emit_done(&app, &job_id, &dataset_id, 0, 0, 0, "failed", Some(&msg));
            return Err(msg);
        }
    };

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("{config_line}\n").as_bytes()).await;
    }

    let stdout = child.stdout.take().ok_or("stdout unavailable")?;
    let mut lines = BufReader::new(stdout).lines();

    let mut processed: u64 = 0;
    let mut errors: u64 = 0;
    let mut skipped: u64 = 0;

    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim().to_string();
        if line.is_empty() { continue; }
        let event: JsonValue = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        match event.get("type").and_then(|v| v.as_str()) {
            Some("progress") => {
                let current = event["current"].as_u64().unwrap_or(0);
                let total_ev = event["total"].as_u64().unwrap_or(total);
                let filepath = event["filepath"].as_str().map(|s| s.to_string());
                let _ = app.emit("dataset:birdnet-progress", BirdnetProgressPayload {
                    job_id: job_id.clone(),
                    dataset_id: dataset_id.clone(),
                    current,
                    total: total_ev,
                    filepath,
                });
            }

            Some("result") => {
                let filepath = match event["filepath"].as_str() {
                    Some(p) => p.to_string(),
                    None => continue,
                };
                let rec_id = match filepath_to_id.get(&filepath) {
                    Some(id) => id.clone(),
                    None => { skipped += 1; continue; }
                };
                let sound_events = serde_json::json!({ "soundEvents": event["detections"] });
                if store.recording_set_dynamic_field(&rec_id, &field_name, sound_events).await.is_ok() {
                    processed += 1;
                    let detection_count = event["detections"].as_array().map(|a| a.len()).unwrap_or(0);
                    let _ = app.emit("dataset:birdnet-result", BirdnetResultPayload {
                        job_id: job_id.clone(),
                        dataset_id: dataset_id.clone(),
                        recording_id: rec_id,
                        field_name: field_name.clone(),
                        detection_count,
                    });
                } else {
                    errors += 1;
                }
            }

            Some("error") => { errors += 1; }
            Some("done") => break,
            _ => {}
        }
    }

    let _ = child.wait().await;

    // Register field in dataset schema (idempotent)
    if processed > 0 {
        if let Ok(Some(mut dataset)) = store.dataset_get(&dataset_id).await {
            if !dataset.field_schema.iter().any(|f| f.name == field_name) {
                dataset.field_schema.push(FieldDefinition {
                    name: field_name.clone(),
                    kind: "sound_events".into(),
                    description: Some(format!("BirdNET results (v{version})")),
                    group: Some("BirdNET".into()),
                    system: false,
                });
                dataset.updated_at = now();
                let _ = store.dataset_update(&dataset).await;
            }
        }
    }

    // Mark run as completed
    run.status = "completed".into();
    run.processed = Some(processed);
    run.errors = Some(errors);
    run.completed_at = Some(now());
    let _ = store.upsert_analysis_run(&dataset_id, &run).await;

    emit_done(&app, &job_id, &dataset_id, processed, errors, skipped, "completed", None);
    Ok(())
}

fn emit_done(
    app: &tauri::AppHandle,
    job_id: &str,
    dataset_id: &str,
    processed: u64,
    errors: u64,
    skipped: u64,
    status: &str,
    error_message: Option<&str>,
) {
    let _ = app.emit("dataset:birdnet-done", BirdnetDonePayload {
        job_id: job_id.to_string(),
        dataset_id: dataset_id.to_string(),
        processed,
        errors,
        skipped,
        status: status.to_string(),
        error_message: error_message.map(|s| s.to_string()),
    });
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 3 — Embedding extraction, UMAP dimensionality reduction,
//            cosine-similarity search, uniqueness scoring.
//
// All commands follow the exact same Tokio-task + Tauri-event pattern
// as `dataset_run_birdnet`.
//
// Tauri events:
//   "dataset:embedding-progress" — { jobId, datasetId, current, total }
//   "dataset:embedding-result"   — { jobId, datasetId, recordingId, fieldName }
//   "dataset:embedding-done"     — { jobId, datasetId, processed, errors, status }
//   "dataset:umap-progress"      — { jobId, datasetId, current, total }
//   "dataset:umap-done"          — { jobId, datasetId, processed, errors, status }
// ═══════════════════════════════════════════════════════════════════════

// ── Arg / return structs for Embedding ───────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetEmbeddingRunArgs {
    pub dataset_id: String,
    /// Field name for the embedding vector, e.g. "embedding".
    pub field_name: String,
    /// BirdNET model version (default: "2.4").
    pub version: Option<String>,
    /// Only run on these recording IDs (None = all).
    pub recording_ids: Option<Vec<String>>,
    pub python_executable: Option<String>,
    pub sidecar_script: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingRunSummary {
    pub job_id: String,
    pub dataset_id: String,
    pub field_name: String,
    pub processed: u64,
    pub errors: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EmbeddingProgressPayload {
    job_id: String,
    dataset_id: String,
    current: u64,
    total: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EmbeddingResultPayload {
    job_id: String,
    dataset_id: String,
    recording_id: String,
    field_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EmbeddingDonePayload {
    job_id: String,
    dataset_id: String,
    processed: u64,
    errors: u64,
    status: String,
    error_message: Option<String>,
}

// ── Arg / return structs for UMAP ────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetComputeUmapArgs {
    pub dataset_id: String,
    /// Field that holds the source embedding (default: "embedding").
    pub embedding_field: Option<String>,
    /// Field where the 2-D coordinates will be written (default: "umap2d").
    pub output_field: Option<String>,
    pub n_neighbors: Option<u32>,
    pub min_dist: Option<f64>,
    pub random_state: Option<u32>,
    pub python_executable: Option<String>,
    pub sidecar_script: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UmapSummary {
    pub job_id: String,
    pub dataset_id: String,
    pub processed: u64,
    pub errors: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UmapProgressPayload {
    job_id: String,
    dataset_id: String,
    current: u64,
    total: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UmapDonePayload {
    job_id: String,
    dataset_id: String,
    processed: u64,
    errors: u64,
    status: String,
    error_message: Option<String>,
}

// ── Arg / return structs for Similarity ─────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingGetSimilarArgs {
    /// The query recording.
    pub recording_id: String,
    pub dataset_id: String,
    /// Field holding the embedding vector (default: "embedding").
    pub embedding_field: Option<String>,
    /// Number of results (default: 10).
    pub top_k: Option<usize>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SimilarityResult {
    pub recording_id: String,
    pub filepath: String,
    pub similarity: f64,
}

// ── Helper: resolve embedding_sidecar.py ────────────────────────────

fn resolve_embedding_script(
    app: &tauri::AppHandle,
    explicit: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    if let Some(p) = explicit {
        let t = p.trim();
        if !t.is_empty() {
            let path = std::path::PathBuf::from(t);
            if path.exists() { return Ok(path); }
            return Err(format!("embedding sidecar not found: {t}"));
        }
    }
    if let Ok(res_dir) = app.path().resource_dir() {
        let candidate = res_dir.join("embedding_sidecar.py");
        if candidate.exists() { return Ok(candidate); }
    }
    let mut dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()));
    while let Some(ref d) = dir {
        let candidate = d.join("scripts").join("embedding_sidecar.py");
        if candidate.exists() { return Ok(candidate); }
        dir = d.parent().map(|p| p.to_path_buf());
    }
    Err(
        "embedding_sidecar.py not found. \
         Either set 'sidecarScript' or bundle the script as a Tauri resource."
            .into(),
    )
}

// ── Command: dataset_run_embedding ───────────────────────────────────

/// Extracts BirdNET embeddings for all (or selected) recordings in a dataset.
///
/// Returns immediately; processing runs in a background Tokio task.
/// Progress is reported via Tauri events.
#[tauri::command]
pub async fn dataset_run_embedding(
    app: tauri::AppHandle,
    store: State<'_, CorpusStoreState>,
    args: DatasetEmbeddingRunArgs,
) -> Result<EmbeddingRunSummary, String> {
    let field_name = sanitize_field_name(&args.field_name)?;
    let dataset_id = args.dataset_id.trim().to_string();
    if dataset_id.is_empty() {
        return Err("dataset_id must not be empty".into());
    }
    store
        .dataset_get(&dataset_id)
        .await?
        .ok_or_else(|| format!("Dataset '{dataset_id}' not found"))?;

    let python_exe = resolve_python(args.python_executable.as_deref());
    let script_path = resolve_embedding_script(&app, args.sidecar_script.as_deref())?;
    let version = args.version.clone().unwrap_or_else(|| "2.4".into());
    let job_id = uuid::Uuid::new_v4().to_string();

    let run_record = AnalysisRunRecord {
        key: job_id.clone(),
        run_type: "embedding".into(),
        config: serde_json::json!({
            "model": "birdnet",
            "version": version,
            "outputField": field_name,
        }),
        status: "queued".into(),
        started_at: None,
        completed_at: None,
        processed: None,
        errors: None,
        error_message: None,
    };
    store.upsert_analysis_run(&dataset_id, &run_record).await?;

    let store_arc = std::sync::Arc::clone(&*store);
    let app_clone = app.clone();
    let job_id_task = job_id.clone();
    let dataset_id_task = dataset_id.clone();
    let field_name_task = field_name.clone();
    let recording_ids = args.recording_ids.clone();

    tokio::spawn(async move {
        let result = run_embedding_task(
            app_clone,
            store_arc,
            job_id_task,
            dataset_id_task,
            field_name_task,
            recording_ids,
            version,
            python_exe,
            script_path,
        ).await;
        if let Err(e) = result {
            eprintln!("Embedding task failed: {e}");
        }
    });

    Ok(EmbeddingRunSummary {
        job_id,
        dataset_id,
        field_name,
        processed: 0,
        errors: 0,
    })
}

#[allow(clippy::too_many_arguments)]
async fn run_embedding_task(
    app: tauri::AppHandle,
    store: std::sync::Arc<crate::corpus_store::CorpusStore>,
    job_id: String,
    dataset_id: String,
    field_name: String,
    recording_ids: Option<Vec<String>>,
    version: String,
    python_exe: String,
    script_path: std::path::PathBuf,
) -> Result<(), String> {
    let now = || {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64
    };

    let mut run = AnalysisRunRecord {
        key: job_id.clone(),
        run_type: "embedding".into(),
        config: serde_json::json!({ "outputField": field_name }),
        status: "running".into(),
        started_at: Some(now()),
        completed_at: None,
        processed: None,
        errors: None,
        error_message: None,
    };
    let _ = store.upsert_analysis_run(&dataset_id, &run).await;

    let all = store.recording_list_by_dataset_all(&dataset_id).await?;
    let recordings: Vec<_> = if let Some(ref ids) = recording_ids {
        let id_set: std::collections::HashSet<&String> = ids.iter().collect();
        all.into_iter().filter(|r| id_set.contains(&r.id)).collect()
    } else {
        all
    };

    if recordings.is_empty() {
        run.status = "completed".into();
        run.processed = Some(0);
        run.errors = Some(0);
        run.completed_at = Some(now());
        let _ = store.upsert_analysis_run(&dataset_id, &run).await;
        let _ = app.emit("dataset:embedding-done", EmbeddingDonePayload {
            job_id, dataset_id, processed: 0, errors: 0,
            status: "completed".into(), error_message: None,
        });
        return Ok(());
    }

    let total = recordings.len() as u64;
    let rec_ids: Vec<String> = recordings.iter().map(|r| r.id.clone()).collect();
    let filepaths: Vec<String> = recordings.iter().map(|r| r.filepath.clone()).collect();

    let sidecar_config = serde_json::json!({
        "mode": "embedding",
        "recording_ids": rec_ids,
        "filepaths": filepaths,
        "version": version,
    });
    let config_line = serde_json::to_string(&sidecar_config)
        .map_err(|e| format!("serialising embedding config: {e}"))?;

    let mut child = tokio::process::Command::new(&python_exe)
        .arg(&script_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Python ({python_exe}) could not be started: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("{config_line}\n").as_bytes()).await;
    }

    let stdout = child.stdout.take().ok_or("stdout unavailable")?;
    let mut lines = BufReader::new(stdout).lines();

    let mut processed: u64 = 0;
    let mut errors: u64 = 0;

    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim().to_string();
        if line.is_empty() { continue; }
        let event: JsonValue = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        match event.get("type").and_then(|v| v.as_str()) {
            Some("progress") => {
                let current = event["current"].as_u64().unwrap_or(0);
                let total_ev = event["total"].as_u64().unwrap_or(total);
                let _ = app.emit("dataset:embedding-progress", EmbeddingProgressPayload {
                    job_id: job_id.clone(),
                    dataset_id: dataset_id.clone(),
                    current,
                    total: total_ev,
                });
            }

            Some("embedding_result") => {
                let rec_id = match event["recording_id"].as_str() {
                    Some(id) => id.to_string(),
                    None => { errors += 1; continue; }
                };
                let embedding = event["embedding"].clone();
                if store.recording_set_dynamic_field(&rec_id, &field_name, embedding).await.is_ok() {
                    processed += 1;
                    let _ = app.emit("dataset:embedding-result", EmbeddingResultPayload {
                        job_id: job_id.clone(),
                        dataset_id: dataset_id.clone(),
                        recording_id: rec_id,
                        field_name: field_name.clone(),
                    });
                } else {
                    errors += 1;
                }
            }

            Some("error") => { errors += 1; }
            Some("done") => break,
            _ => {}
        }
    }

    let _ = child.wait().await;

    // Register field in dataset schema (idempotent)
    if processed > 0 {
        if let Ok(Some(mut dataset)) = store.dataset_get(&dataset_id).await {
            if !dataset.field_schema.iter().any(|f| f.name == field_name) {
                dataset.field_schema.push(FieldDefinition {
                    name: field_name.clone(),
                    kind: "vector".into(),
                    description: Some(format!("BirdNET embedding (v{version})")),
                    group: Some("Embeddings".into()),
                    system: false,
                });
                dataset.updated_at = now();
                let _ = store.dataset_update(&dataset).await;
            }
        }
    }

    run.status = "completed".into();
    run.processed = Some(processed);
    run.errors = Some(errors);
    run.completed_at = Some(now());
    let _ = store.upsert_analysis_run(&dataset_id, &run).await;

    let _ = app.emit("dataset:embedding-done", EmbeddingDonePayload {
        job_id,
        dataset_id,
        processed,
        errors,
        status: "completed".into(),
        error_message: None,
    });
    Ok(())
}

// ── Command: dataset_compute_umap ────────────────────────────────────

/// Reduces all embedding vectors in a dataset to 2-D UMAP coordinates.
#[tauri::command]
pub async fn dataset_compute_umap(
    app: tauri::AppHandle,
    store: State<'_, CorpusStoreState>,
    args: DatasetComputeUmapArgs,
) -> Result<UmapSummary, String> {
    let dataset_id = args.dataset_id.trim().to_string();
    if dataset_id.is_empty() {
        return Err("dataset_id must not be empty".into());
    }
    store
        .dataset_get(&dataset_id)
        .await?
        .ok_or_else(|| format!("Dataset '{dataset_id}' not found"))?;

    let embedding_field = args.embedding_field.clone().unwrap_or_else(|| "embedding".into());
    let output_field    = sanitize_field_name(
        &args.output_field.clone().unwrap_or_else(|| "umap2d".into())
    )?;
    sanitize_field_name(&embedding_field)?; // validate source field too

    let python_exe  = resolve_python(args.python_executable.as_deref());
    let script_path = resolve_embedding_script(&app, args.sidecar_script.as_deref())?;
    let job_id      = uuid::Uuid::new_v4().to_string();

    let run_record = AnalysisRunRecord {
        key: job_id.clone(),
        run_type: "umap".into(),
        config: serde_json::json!({
            "embeddingField": embedding_field,
            "outputField":    output_field,
        }),
        status: "queued".into(),
        started_at: None,
        completed_at: None,
        processed: None,
        errors: None,
        error_message: None,
    };
    store.upsert_analysis_run(&dataset_id, &run_record).await?;

    let store_arc        = std::sync::Arc::clone(&*store);
    let app_clone        = app.clone();
    let job_id_task      = job_id.clone();
    let dataset_id_task  = dataset_id.clone();
    let n_neighbors      = args.n_neighbors.unwrap_or(15);
    let min_dist         = args.min_dist.unwrap_or(0.1);
    let random_state     = args.random_state.unwrap_or(42);

    tokio::spawn(async move {
        let result = run_umap_task(
            app_clone,
            store_arc,
            job_id_task,
            dataset_id_task,
            embedding_field,
            output_field,
            n_neighbors,
            min_dist,
            random_state,
            python_exe,
            script_path,
        ).await;
        if let Err(e) = result {
            eprintln!("UMAP task failed: {e}");
        }
    });

    Ok(UmapSummary { job_id, dataset_id, processed: 0, errors: 0 })
}

#[allow(clippy::too_many_arguments)]
async fn run_umap_task(
    app: tauri::AppHandle,
    store: std::sync::Arc<crate::corpus_store::CorpusStore>,
    job_id: String,
    dataset_id: String,
    embedding_field: String,
    output_field: String,
    n_neighbors: u32,
    min_dist: f64,
    random_state: u32,
    python_exe: String,
    script_path: std::path::PathBuf,
) -> Result<(), String> {
    let now = || {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64
    };

    let mut run = AnalysisRunRecord {
        key: job_id.clone(),
        run_type: "umap".into(),
        config: serde_json::json!({ "embeddingField": embedding_field }),
        status: "running".into(),
        started_at: Some(now()),
        completed_at: None,
        processed: None,
        errors: None,
        error_message: None,
    };
    let _ = store.upsert_analysis_run(&dataset_id, &run).await;

    // Load all recordings with their embeddings
    let all_docs = store.recording_list_all_json(&dataset_id).await?;
    let items: Vec<JsonValue> = all_docs.iter().filter_map(|doc| {
        let rec_id = doc["id"].as_str()?;
        let embedding = doc["fields"].get(&embedding_field)?;
        if !embedding.is_array() { return None; }
        Some(serde_json::json!({
            "id":        rec_id,
            "embedding": embedding,
        }))
    }).collect();

    if items.is_empty() {
        run.status = "completed".into();
        run.processed = Some(0);
        run.errors = Some(0);
        run.completed_at = Some(now());
        let _ = store.upsert_analysis_run(&dataset_id, &run).await;
        let _ = app.emit("dataset:umap-done", UmapDonePayload {
            job_id, dataset_id, processed: 0, errors: 0,
            status: "completed".into(), error_message: None,
        });
        return Ok(());
    }

    let total = items.len() as u64;
    let sidecar_config = serde_json::json!({
        "mode":         "umap",
        "items":        items,
        "n_neighbors":  n_neighbors,
        "min_dist":     min_dist,
        "random_state": random_state,
    });
    let config_line = serde_json::to_string(&sidecar_config)
        .map_err(|e| format!("serialising UMAP config: {e}"))?;

    let mut child = tokio::process::Command::new(&python_exe)
        .arg(&script_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Python ({python_exe}) could not be started: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("{config_line}\n").as_bytes()).await;
    }

    let stdout = child.stdout.take().ok_or("stdout unavailable")?;
    let mut lines = BufReader::new(stdout).lines();

    let mut processed: u64 = 0;
    let mut errors: u64 = 0;
    let mut current: u64 = 0;

    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim().to_string();
        if line.is_empty() { continue; }
        let event: JsonValue = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        match event.get("type").and_then(|v| v.as_str()) {
            Some("umap_progress") => {
                let _ = app.emit("dataset:umap-progress", UmapProgressPayload {
                    job_id: job_id.clone(),
                    dataset_id: dataset_id.clone(),
                    current,
                    total,
                });
            }

            Some("umap_result") => {
                let rec_id = match event["recording_id"].as_str() {
                    Some(id) => id.to_string(),
                    None => { errors += 1; continue; }
                };
                let x = event["x"].as_f64().unwrap_or(0.0);
                let y = event["y"].as_f64().unwrap_or(0.0);
                let coords = serde_json::json!([x, y]);
                if store.recording_set_dynamic_field(&rec_id, &output_field, coords).await.is_ok() {
                    processed += 1;
                    current += 1;
                    let _ = app.emit("dataset:umap-progress", UmapProgressPayload {
                        job_id: job_id.clone(),
                        dataset_id: dataset_id.clone(),
                        current,
                        total,
                    });
                } else {
                    errors += 1;
                }
            }

            Some("error") => { errors += 1; }
            Some("done") => break,
            _ => {}
        }
    }

    let _ = child.wait().await;

    // Register umap2d field in dataset schema (idempotent)
    if processed > 0 {
        if let Ok(Some(mut dataset)) = store.dataset_get(&dataset_id).await {
            if !dataset.field_schema.iter().any(|f| f.name == output_field) {
                dataset.field_schema.push(FieldDefinition {
                    name: output_field.clone(),
                    kind: "vector".into(),
                    description: Some("UMAP 2-D projection".into()),
                    group: Some("Embeddings".into()),
                    system: false,
                });
                dataset.updated_at = now();
                let _ = store.dataset_update(&dataset).await;
            }
        }
    }

    run.status = "completed".into();
    run.processed = Some(processed);
    run.errors = Some(errors);
    run.completed_at = Some(now());
    let _ = store.upsert_analysis_run(&dataset_id, &run).await;

    let _ = app.emit("dataset:umap-done", UmapDonePayload {
        job_id,
        dataset_id,
        processed,
        errors,
        status: "completed".into(),
        error_message: None,
    });
    Ok(())
}

// ── Command: recording_get_similar ───────────────────────────────────

/// Finds the most similar recordings in the same dataset using cosine similarity
/// on pre-computed embedding vectors. Computation is done in Rust (no Python call needed).
#[tauri::command]
pub async fn recording_get_similar(
    store: State<'_, CorpusStoreState>,
    args: RecordingGetSimilarArgs,
) -> Result<Vec<SimilarityResult>, String> {
    let dataset_id      = args.dataset_id.trim().to_string();
    let query_id        = args.recording_id.trim().to_string();
    let embedding_field = args.embedding_field.as_deref().unwrap_or("embedding");
    let top_k           = args.top_k.unwrap_or(10);

    if dataset_id.is_empty() || query_id.is_empty() {
        return Err("dataset_id and recording_id must not be empty".into());
    }
    sanitize_field_name(embedding_field)?;

    // Load all recordings with their embedding field
    let all_docs = store.recording_list_all_json(&dataset_id).await?;

    // Extract embeddings as f32 vecs
    let mut query_vec: Option<Vec<f32>> = None;
    let mut corpus: Vec<(String, String, Vec<f32>)> = Vec::new(); // (id, filepath, embedding)

    for doc in &all_docs {
        let Some(rec_id) = doc["id"].as_str() else { continue };
        let Some(filepath) = doc["filepath"].as_str() else { continue };
        let Some(emb_val) = doc["fields"].get(embedding_field) else { continue };
        let Some(arr) = emb_val.as_array() else { continue };
        let emb: Vec<f32> = arr.iter()
            .filter_map(|v| v.as_f64().map(|f| f as f32))
            .collect();
        if emb.is_empty() { continue; }

        if rec_id == query_id {
            query_vec = Some(emb.clone());
        }
        corpus.push((rec_id.to_string(), filepath.to_string(), emb));
    }

    let query = query_vec.ok_or_else(|| {
        format!("No embedding found for recording '{query_id}' in field '{embedding_field}'")
    })?;

    // Cosine similarity = dot(a_norm, b_norm)
    let query_norm = l2_norm(&query);
    let mut results: Vec<SimilarityResult> = corpus
        .into_iter()
        .filter(|(id, _, _)| id != &query_id)
        .map(|(rec_id, filepath, emb)| {
            let emb_norm = l2_norm(&emb);
            let sim = dot_product(&query_norm, &emb_norm) as f64;
            SimilarityResult { recording_id: rec_id, filepath, similarity: sim }
        })
        .collect();

    results.sort_by(|a, b| b.similarity.partial_cmp(&a.similarity).unwrap_or(std::cmp::Ordering::Equal));
    results.truncate(top_k);
    Ok(results)
}

fn l2_norm(v: &[f32]) -> Vec<f32> {
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm < 1e-10 {
        return v.to_vec();
    }
    v.iter().map(|x| x / norm).collect()
}

fn dot_product(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

// ── Command: dataset_compute_uniqueness ─────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetComputeUniquenessArgs {
    pub dataset_id: String,
    /// Source embedding field (default: "embedding").
    pub embedding_field: Option<String>,
    /// Output field for the uniqueness score (default: "uniqueness").
    pub output_field: Option<String>,
    /// Number of nearest neighbours (default: 10).
    pub k: Option<usize>,
    pub python_executable: Option<String>,
    pub sidecar_script: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UniquenessRunSummary {
    pub job_id: String,
    pub dataset_id: String,
    pub processed: u64,
}

/// Computes a uniqueness score for each recording as 1 − mean cosine similarity
/// to its k nearest neighbours. Runs via the Python sidecar (uniqueness mode).
#[tauri::command]
pub async fn dataset_compute_uniqueness(
    app: tauri::AppHandle,
    store: State<'_, CorpusStoreState>,
    args: DatasetComputeUniquenessArgs,
) -> Result<UniquenessRunSummary, String> {
    let dataset_id      = args.dataset_id.trim().to_string();
    let embedding_field = args.embedding_field.clone().unwrap_or_else(|| "embedding".into());
    let output_field    = sanitize_field_name(
        &args.output_field.clone().unwrap_or_else(|| "uniqueness".into())
    )?;
    let k               = args.k.unwrap_or(10);
    sanitize_field_name(&embedding_field)?;

    if dataset_id.is_empty() {
        return Err("dataset_id must not be empty".into());
    }
    store.dataset_get(&dataset_id).await?.ok_or_else(|| format!("Dataset '{dataset_id}' not found"))?;

    let python_exe  = resolve_python(args.python_executable.as_deref());
    let script_path = resolve_embedding_script(&app, args.sidecar_script.as_deref())?;
    let job_id      = uuid::Uuid::new_v4().to_string();

    // Load all recordings with embeddings
    let all_docs = store.recording_list_all_json(&dataset_id).await?;
    let items: Vec<JsonValue> = all_docs.iter().filter_map(|doc| {
        let rec_id   = doc["id"].as_str()?;
        let embedding = doc["fields"].get(&embedding_field)?;
        if !embedding.is_array() { return None; }
        Some(serde_json::json!({ "id": rec_id, "embedding": embedding }))
    }).collect();

    if items.is_empty() {
        return Ok(UniquenessRunSummary { job_id, dataset_id, processed: 0 });
    }

    let sidecar_config = serde_json::json!({
        "mode": "uniqueness",
        "items": items,
        "k": k,
    });
    let config_line = serde_json::to_string(&sidecar_config)
        .map_err(|e| format!("serialising uniqueness config: {e}"))?;

    let mut child = tokio::process::Command::new(&python_exe)
        .arg(&script_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Python could not be started: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("{config_line}\n").as_bytes()).await;
    }

    let stdout = child.stdout.take().ok_or("stdout unavailable")?;
    let mut lines = BufReader::new(stdout).lines();
    let mut processed: u64 = 0;

    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim().to_string();
        if line.is_empty() { continue; }
        let event: JsonValue = match serde_json::from_str(&line) { Ok(v) => v, Err(_) => continue };

        if event["type"].as_str() == Some("uniqueness_result") {
            let rec_id = match event["recording_id"].as_str() { Some(id) => id.to_string(), None => continue };
            let score  = event["score"].as_f64().unwrap_or(0.0);
            if store.recording_set_dynamic_field(&rec_id, &output_field, serde_json::json!(score)).await.is_ok() {
                processed += 1;
            }
        } else if event["type"].as_str() == Some("done") {
            break;
        }
    }
    let _ = child.wait().await;

    // Register uniqueness field in schema
    if processed > 0 {
        if let Ok(Some(mut dataset)) = store.dataset_get(&dataset_id).await {
            if !dataset.field_schema.iter().any(|f| f.name == output_field) {
                dataset.field_schema.push(FieldDefinition {
                    name: output_field,
                    kind: "regression".into(),
                    description: Some("Uniqueness score (1 − mean cosine similarity to kNN)".into()),
                    group: Some("Embeddings".into()),
                    system: false,
                });
                let _ = store.dataset_update(&dataset).await;
            }
        }
    }

    let _ = app.emit("dataset:uniqueness-done", serde_json::json!({
        "jobId": job_id.clone(), "datasetId": dataset_id.clone(), "processed": processed,
    }));
    Ok(UniquenessRunSummary { job_id, dataset_id, processed })
}

// ══════════════════════════════════════════════════════════════════════
// Phase 4: Clustering (HDBSCAN via Python sidecar)
// ══════════════════════════════════════════════════════════════════════

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetRunClusteringArgs {
    pub dataset_id: String,
    /// Field that holds the float-array embedding.
    pub embedding_field: String,
    /// Field to write the integer cluster_id to. Default "clusterId".
    pub output_field: Option<String>,
    /// Field to write the HDBSCAN membership probability to. Default "clusterProb".
    pub probability_field: Option<String>,
    /// HDBSCAN min_cluster_size. Default 5.
    pub min_cluster_size: Option<u32>,
    /// HDBSCAN min_samples. Default = min_cluster_size.
    pub min_samples: Option<u32>,
    pub python_executable: Option<String>,
    pub sidecar_script: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusteringRunSummary {
    pub job_id: String,
    pub dataset_id: String,
    pub output_field: String,
    pub processed: u64,
    pub n_clusters: i64,
    pub n_noise: i64,
}

/// Tauri command: run HDBSCAN clustering on embedding vectors in a dataset.
#[tauri::command]
pub async fn dataset_run_clustering(
    app: tauri::AppHandle,
    store: State<'_, CorpusStoreState>,
    args: DatasetRunClusteringArgs,
) -> Result<ClusteringRunSummary, String> {
    let dataset_id     = args.dataset_id.clone();
    let embedding_field = args.embedding_field.clone();
    let output_field   = args.output_field.clone().unwrap_or_else(|| "clusterId".into());
    let prob_field     = args.probability_field.clone().unwrap_or_else(|| "clusterProb".into());

    let python_exe   = args.python_executable.clone().unwrap_or_else(|| "python3".into());
    let script_path  = if let Some(s) = &args.sidecar_script {
        std::path::PathBuf::from(s)
    } else {
        resolve_embedding_script(&app, None)?
    };

    let job_id = crate::helpers::time::new_id("cluster")
        .unwrap_or_else(|_| format!("cluster-{}", uuid_fallback()));

    let now = || {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64
    };

    let mut run = AnalysisRunRecord {
        key: job_id.clone(),
        run_type: "clustering".into(),
        config: serde_json::json!({
            "embeddingField": embedding_field,
            "outputField":    output_field,
        }),
        status: "running".into(),
        started_at: Some(now()),
        completed_at: None,
        processed: None,
        errors: None,
        error_message: None,
    };
    let _ = store.upsert_analysis_run(&dataset_id, &run).await;

    // Load all recordings with embeddings
    let all_docs = store.recording_list_all_json(&dataset_id).await?;
    let items: Vec<JsonValue> = all_docs.iter().filter_map(|doc| {
        let rec_id   = doc["id"].as_str()?;
        let embedding = doc["fields"].get(&embedding_field)?;
        if !embedding.is_array() { return None; }
        Some(serde_json::json!({ "id": rec_id, "embedding": embedding }))
    }).collect();

    if items.is_empty() {
        run.status = "completed".into();
        run.processed = Some(0);
        run.completed_at = Some(now());
        let _ = store.upsert_analysis_run(&dataset_id, &run).await;
        let _ = app.emit("dataset:clustering-done", serde_json::json!({
            "jobId": job_id, "datasetId": dataset_id,
            "processed": 0, "nClusters": 0, "nNoise": 0,
        }));
        return Ok(ClusteringRunSummary {
            job_id, dataset_id, output_field,
            processed: 0, n_clusters: 0, n_noise: 0,
        });
    }

    let sidecar_config = serde_json::json!({
        "mode":             "clustering",
        "items":            items,
        "min_cluster_size": args.min_cluster_size.unwrap_or(5),
        "min_samples":      args.min_samples,
    });
    let config_line = serde_json::to_string(&sidecar_config)
        .map_err(|e| format!("serialising clustering config: {e}"))?;

    let mut child = tokio::process::Command::new(&python_exe)
        .arg(&script_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Python ({python_exe}) could not be started: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("{config_line}\n").as_bytes()).await;
    }

    let stdout = child.stdout.take().ok_or("stdout unavailable")?;
    let mut lines = BufReader::new(stdout).lines();

    let mut processed: u64 = 0;
    let mut n_clusters: i64 = 0;
    let mut n_noise: i64 = 0;

    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim().to_string();
        if line.is_empty() { continue; }
        let event: JsonValue = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        match event["type"].as_str() {
            Some("cluster_result") => {
                let rec_id     = match event["recording_id"].as_str() { Some(s) => s.to_string(), None => continue };
                let cluster_id = event["cluster_id"].as_i64().unwrap_or(-1);
                let prob       = event["probability"].as_f64().unwrap_or(0.0);
                let _ = store.recording_set_dynamic_field(&rec_id, &output_field, serde_json::json!(cluster_id)).await;
                let _ = store.recording_set_dynamic_field(&rec_id, &prob_field,   serde_json::json!(prob)).await;
                processed += 1;
            }
            Some("clustering_progress") => {
                let _ = app.emit("dataset:clustering-progress", serde_json::json!({
                    "jobId": job_id, "datasetId": dataset_id,
                    "message": event["message"],
                }));
            }
            Some("done") => {
                n_clusters = event["n_clusters"].as_i64().unwrap_or(0);
                n_noise    = event["n_noise"].as_i64().unwrap_or(0);
                break;
            }
            _ => {}
        }
    }
    let _ = child.wait().await;

    // Register fields in dataset schema
    if processed > 0 {
        if let Ok(Some(mut dataset)) = store.dataset_get(&dataset_id).await {
            for (fname, kind, desc) in [
                (output_field.as_str(), "integer", "HDBSCAN cluster ID (−1 = noise)"),
                (prob_field.as_str(),   "regression", "HDBSCAN membership probability"),
            ] {
                if !dataset.field_schema.iter().any(|f| f.name == fname) {
                    dataset.field_schema.push(FieldDefinition {
                        name: fname.to_string(),
                        kind: kind.to_string(),
                        description: Some(desc.to_string()),
                        group: Some("Clustering".into()),
                        system: false,
                    });
                }
            }
            let _ = store.dataset_update(&dataset).await;
        }
    }

    run.status       = "completed".into();
    run.processed    = Some(processed);
    run.completed_at = Some(now());
    let _ = store.upsert_analysis_run(&dataset_id, &run).await;

    let _ = app.emit("dataset:clustering-done", serde_json::json!({
        "jobId": job_id.clone(), "datasetId": dataset_id.clone(),
        "processed": processed, "nClusters": n_clusters, "nNoise": n_noise,
    }));

    Ok(ClusteringRunSummary {
        job_id, dataset_id, output_field, processed, n_clusters, n_noise,
    })
}

// ══════════════════════════════════════════════════════════════════════
// Phase 4: Hardness score (pure Rust — reads stored SoundEvents)
// ══════════════════════════════════════════════════════════════════════

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetComputeHardnessArgs {
    pub dataset_id: String,
    /// SoundEvents field to read detections from (e.g. "birdnetV24").
    pub field_name: String,
    /// Field to write the hardness score to. Default "hardness".
    pub output_field: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardnessRunSummary {
    pub dataset_id: String,
    pub output_field: String,
    pub processed: u64,
}

/// Hardness = 1 - max_confidence among all sound events in `field_name`.
/// A recording with no detections gets hardness = 0.0 (the model is certain there
/// is nothing to find). A recording where the top detection has low confidence
/// gets hardness close to 1.0 (the model is uncertain).
#[tauri::command]
pub async fn dataset_compute_hardness(
    store: State<'_, CorpusStoreState>,
    args: DatasetComputeHardnessArgs,
) -> Result<HardnessRunSummary, String> {
    let dataset_id   = args.dataset_id.clone();
    let field_name   = args.field_name.clone();
    let output_field = args.output_field.clone().unwrap_or_else(|| "hardness".into());

    let all_docs = store.recording_list_all_json(&dataset_id).await?;
    let mut processed: u64 = 0;

    for doc in &all_docs {
        let rec_id = match doc["id"].as_str() { Some(s) => s.to_string(), None => continue };

        // Read the SoundEvents field
        let field_val = match doc["fields"].get(&field_name) {
            Some(v) => v,
            None    => continue,
        };

        // Compute max confidence across sound events
        let hardness: f64 = if let Some(events) = field_val["soundEvents"].as_array() {
            let max_conf = events.iter()
                .filter_map(|e| e["confidence"].as_f64())
                .fold(0.0_f64, f64::max);
            (1.0 - max_conf).clamp(0.0, 1.0)
        } else {
            continue  // field exists but wrong shape — skip
        };

        if store
            .recording_set_dynamic_field(
                &rec_id,
                &output_field,
                serde_json::json!(hardness),
            )
            .await
            .is_ok()
        {
            processed += 1;
        }
    }

    // Register field in dataset schema
    if processed > 0 {
        if let Ok(Some(mut dataset)) = store.dataset_get(&dataset_id).await {
            if !dataset.field_schema.iter().any(|f| f.name == output_field) {
                dataset.field_schema.push(FieldDefinition {
                    name: output_field.clone(),
                    kind: "regression".into(),
                    description: Some(
                        format!("Hardness score derived from '{field_name}' (1 − max confidence)")
                    ),
                    group: Some("Active Learning".into()),
                    system: false,
                });
                let _ = store.dataset_update(&dataset).await;
            }
        }
    }

    Ok(HardnessRunSummary { dataset_id, output_field, processed })
}

// ── Tiny UUID fallback (used when new_id fails) ───────────────────────

fn uuid_fallback() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}
