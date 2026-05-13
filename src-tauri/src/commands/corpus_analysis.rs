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
use crate::corpus_store::FieldDefinition;
use crate::helpers::time::now_millis;

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
/// The Python sidecar process is executed synchronously in a Tokio task.
/// Progress events are emitted as Tauri events:
/// - `"dataset:birdnet-progress"` — after each file
/// - `"dataset:birdnet-result"`   — after a successful SurrealDB write
///
/// The command blocks until all files are processed.
#[tauri::command]
pub async fn dataset_run_birdnet(
    app: tauri::AppHandle,
    store: State<'_, CorpusStoreState>,
    args: DatasetBirdnetRunArgs,
) -> Result<BirdnetRunSummary, String> {
    // ── Validation ───────────────────────────────────────────────────
    let field_name = sanitize_field_name(&args.field_name)?;
    let dataset_id = args.dataset_id.trim().to_string();
    if dataset_id.is_empty() {
        return Err("dataset_id must not be empty".into());
    }

    // Dataset must exist
    store
        .dataset_get(&dataset_id)
        .await?
        .ok_or_else(|| format!("Dataset '{dataset_id}' not found"))?;

    let job_id = uuid::Uuid::new_v4().to_string();

    // ── Load recordings ───────────────────────────────────────────────
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

    // filepath → recording_id look-up
    let filepath_to_id: HashMap<String, String> = recordings
        .iter()
        .map(|r| (r.filepath.clone(), r.id.clone()))
        .collect();

    let filepaths: Vec<String> = recordings.iter().map(|r| r.filepath.clone()).collect();
    let total = filepaths.len() as u64;

    // ── Set up Python process ─────────────────────────────────────────
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
        .map_err(|e| format!("Serialising configuration: {e}"))?;

    // Spawn process (stderr is forwarded to Tauri console)
    let mut child = tokio::process::Command::new(&python_exe)
        .arg(&script_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Python ({python_exe}) could not be started: {e}"))?;

    // Send config via stdin, then send EOF
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(format!("{config_line}\n").as_bytes())
            .await
            .map_err(|e| format!("Writing to stdin: {e}"))?;
        // stdin is dropped here → EOF for the child process
    }

    // ── Process stdout line by line ───────────────────────────────────
    let stdout = child
        .stdout
        .take()
        .ok_or("stdout of child process not available")?;
    let mut lines = BufReader::new(stdout).lines();

    let mut processed: u64 = 0;
    let mut errors: u64 = 0;
    let mut skipped: u64 = 0;

    while let Some(line) = lines
        .next_line()
        .await
        .map_err(|e| format!("Reading stdout: {e}"))?
    {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        let event: JsonValue = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue, // Malformed line — ignore
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

    // Reap child process (prevents zombie processes)
    let _ = child.wait().await;

    // ── Register field in dataset schema (idempotent) ──────────────────
    if processed > 0 {
        if let Ok(Some(mut dataset)) = store.dataset_get(&dataset_id).await {
            if !dataset.field_schema.iter().any(|f| f.name == field_name) {
                dataset.field_schema.push(FieldDefinition {
                    name: field_name.clone(),
                    kind: "sound_events".into(),
                    description: Some(format!(
                        "BirdNET results ({})",
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
