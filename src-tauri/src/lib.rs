// ═══════════════════════════════════════════════════════════════════════
// src-tauri/src/lib.rs — IPC command implementations
//
// Commands are intentionally thin: they translate between the TS layer
// and the native filesystem.  No business logic lives here; the domain
// model is owned by the TypeScript frontend.
// ═══════════════════════════════════════════════════════════════════════

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use serde_json::Value as JsonValue;
use serde::{Deserialize, Serialize};
use tauri::Manager;

#[cfg(feature = "grpc")]
pub mod grpc;
mod project_store;

use project_store::ProjectStore;

// ── Path helpers ─────────────────────────────────────────────────────

/// Returns the platform-specific directory where project files are kept.
///   macOS : ~/Library/Application Support/io.github.limitlessgreen.signavis/projects/
///   Linux : ~/.local/share/io.github.limitlessgreen.signavis/projects/
///   Windows: %APPDATA%\io.github.limitlessgreen.signavis\projects\
fn projects_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("projects"))
        .map_err(|e| e.to_string())
}

fn project_store(app: &tauri::AppHandle) -> Result<ProjectStore, String> {
    Ok(ProjectStore::new(projects_dir(app)?))
}

fn assets_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("assets"))
        .map_err(|e| e.to_string())
}

fn jobs_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("jobs"))
        .map_err(|e| e.to_string())
}

fn now_millis() -> Result<u64, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("clock error: {e}"))?;
    Ok(duration.as_millis() as u64)
}

fn new_id(prefix: &str) -> Result<String, String> {
    Ok(format!("{prefix}-{}", now_millis()?))
}

fn ensure_array_field<'a>(value: &'a mut JsonValue, field: &str) -> Result<&'a mut Vec<JsonValue>, String> {
    let obj = value
        .as_object_mut()
        .ok_or("project value must be an object")?;
    if !obj.contains_key(field) {
        obj.insert(field.to_string(), serde_json::json!([]));
    }
    obj.get_mut(field)
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| format!("project field '{field}' must be an array"))
}

fn write_job_json(app: &tauri::AppHandle, job: &JsonValue, origin: &str) -> Result<(), String> {
    let jobs_root = jobs_dir(app)?;
    std::fs::create_dir_all(&jobs_root).map_err(|e| format!("{origin}: {e}"))?;
    let job_id = job["id"].as_str().ok_or("job must contain id")?;
    let job_path = jobs_root.join(format!("{job_id}.json"));
    let content = serde_json::to_string_pretty(job).map_err(|e| format!("{origin}: {e}"))?;
    std::fs::write(job_path, content).map_err(|e| format!("{origin}: {e}"))
}

fn read_job_json(app: &tauri::AppHandle, id: &str) -> Result<JsonValue, String> {
    let jobs_root = jobs_dir(app)?;
    let job_path = jobs_root.join(format!("{id}.json"));
    let content = std::fs::read_to_string(job_path).map_err(|e| format!("read_local_job: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("read_local_job: malformed JSON: {e}"))
}

fn structured_job_error(code: &str, message: &str, details: JsonValue) -> JsonValue {
    serde_json::json!({
        "code": code,
        "message": message,
        "details": details,
    })
}

fn set_job_failed(job: &mut JsonValue, code: &str, message: &str, details: JsonValue) -> Result<(), String> {
    let now = now_millis()? as i64;
    job["status"] = serde_json::json!("failed");
    job["progress"] = serde_json::json!(1.0);
    job["updatedAt"] = serde_json::json!(now);
    if job["finishedAt"].is_null() {
        job["finishedAt"] = serde_json::json!(now);
    }
    job["error"] = structured_job_error(code, message, details);
    Ok(())
}

#[cfg(feature = "grpc")]
fn grpc_bind_addr() -> String {
    std::env::var("AW_GRPC_ADDR")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "127.0.0.1:50051".to_string())
}

// ── IPC Commands ──────────────────────────────────────────────────────

/// Read and return a project by id. Returns an error string when not found.
#[tauri::command]
async fn read_project(app: tauri::AppHandle, id: String) -> Result<JsonValue, String> {
    project_store(&app)?.read_project_json(&id)
}

/// Persist a project.  The `id` field inside the JSON is used as filename.
#[tauri::command]
async fn write_project(app: tauri::AppHandle, project: JsonValue) -> Result<(), String> {
    project_store(&app)?.write_project_json(&project)
}

/// Return all project ids stored on disk (unsorted).
#[tauri::command]
async fn list_project_ids(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    project_store(&app)?.list_project_ids()
}

/// Return lightweight project summaries sorted by updatedAt descending.
#[tauri::command]
async fn list_projects(app: tauri::AppHandle) -> Result<Vec<JsonValue>, String> {
    project_store(&app)?.list_project_summaries()
}

/// Remove a project file.  Succeeds silently when the project does not exist.
#[tauri::command]
async fn delete_project(app: tauri::AppHandle, id: String) -> Result<(), String> {
    project_store(&app)?.delete_project(&id)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectCreateArgs {
    name: Option<String>,
}

/// Create a minimal project document on disk and return it.
#[tauri::command]
async fn project_create(app: tauri::AppHandle, args: Option<ProjectCreateArgs>) -> Result<JsonValue, String> {
    let id = new_id("proj")?;
    let now = now_millis()? as i64;
    let mut project = serde_json::json!({
        "id": id,
        "name": args
            .and_then(|a| a.name)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "New Project".to_string()),
        "createdAt": now,
        "updatedAt": now,
        "audioSource": null,
        "labels": [],
        "annotations": [],
        "assets": [],
    });
    project_store(&app)?.write_project_json(&project)?;
    if let Some(name) = project["name"].as_str() {
        let project_name = name.to_string();
        project["name"] = serde_json::json!(project_name);
    }
    Ok(project)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssetImportLocalArgs {
    project_id: String,
    source_path: String,
}

/// Import a local file as project asset by copying it into app data storage.
#[tauri::command]
async fn asset_import_local(app: tauri::AppHandle, args: AssetImportLocalArgs) -> Result<JsonValue, String> {
    let source = PathBuf::from(args.source_path.trim());
    if !source.exists() {
        return Err(format!("source file does not exist: {}", source.display()));
    }
    if !source.is_file() {
        return Err(format!("source path is not a file: {}", source.display()));
    }

    let mut project = project_store(&app)?.read_project_json(&args.project_id)?;

    let assets_root = assets_dir(&app)?;
    std::fs::create_dir_all(&assets_root).map_err(|e| format!("asset_import_local: {e}"))?;
    let project_assets_dir = assets_root.join(&args.project_id);
    std::fs::create_dir_all(&project_assets_dir).map_err(|e| format!("asset_import_local: {e}"))?;

    let asset_id = new_id("asset")?;
    let file_name = source
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("source file name is invalid utf-8")?;
    let dest_file_name = format!("{asset_id}_{file_name}");
    let dest_path = project_assets_dir.join(dest_file_name);
    std::fs::copy(&source, &dest_path).map_err(|e| format!("asset_import_local: {e}"))?;

    let size_bytes = std::fs::metadata(&dest_path)
        .map_err(|e| format!("asset_import_local: {e}"))?
        .len();

    let imported_at = now_millis()? as i64;
    let asset = serde_json::json!({
        "id": asset_id,
        "kind": "audio",
        "sourcePath": source.to_string_lossy(),
        "storagePath": dest_path.to_string_lossy(),
        "sizeBytes": size_bytes,
        "importedAt": imported_at,
    });

    ensure_array_field(&mut project, "assets")?.push(asset.clone());
    project["updatedAt"] = serde_json::json!(imported_at);
    project_store(&app)?.write_project_json(&project)?;

    Ok(asset)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisRunLocalArgs {
    project_id: String,
    asset_id: Option<String>,
    backend: Option<String>,
}

/// Scaffold command for local analysis. It creates a persisted job record
/// so the frontend can build a complete vertical slice before real execution exists.
#[tauri::command]
async fn analysis_run_local(app: tauri::AppHandle, args: AnalysisRunLocalArgs) -> Result<JsonValue, String> {
    // Validate project existence early for deterministic UI errors.
    let project = project_store(&app)?.read_project_json(&args.project_id)?;

    let job_id = new_id("job")?;
    let created_at = now_millis()? as i64;
    let backend = args
        .backend
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "local".to_string());
    let mut job = serde_json::json!({
        "id": job_id,
        "projectId": args.project_id,
        "assetId": args.asset_id,
        "backend": backend,
        "status": "queued",
        "progress": 0.0,
        "createdAt": created_at,
        "startedAt": null,
        "finishedAt": null,
        "error": null,
        "result": {
            "message": "analysis_run_local scaffold command executed",
            "detections": []
        }
    });

    write_job_json(&app, &job, "analysis_run_local")?;

    job["status"] = serde_json::json!("running");
    job["startedAt"] = serde_json::json!(created_at);
    job["progress"] = serde_json::json!(0.5);
    write_job_json(&app, &job, "analysis_run_local")?;

    // Fail with structured error payloads for deterministic UI handling.
    if backend != "local" && backend != "server" && backend != "cloud" {
        set_job_failed(
            &mut job,
            "invalid_backend",
            "Unsupported analysis backend",
            serde_json::json!({ "backend": backend }),
        )?;
        write_job_json(&app, &job, "analysis_run_local")?;
        return Ok(job);
    }

    if let Some(asset_id) = args.asset_id.as_ref() {
        let found = project
            .get("assets")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().any(|a| a.get("id").and_then(|v| v.as_str()) == Some(asset_id.as_str())))
            .unwrap_or(false);

        if !found {
            set_job_failed(
                &mut job,
                "asset_not_found",
                "Referenced assetId does not exist in project",
                serde_json::json!({
                    "projectId": args.project_id,
                    "assetId": asset_id,
                }),
            )?;
            write_job_json(&app, &job, "analysis_run_local")?;
            return Ok(job);
        }
    }

    job["status"] = serde_json::json!("done");
    job["finishedAt"] = serde_json::json!(now_millis()? as i64);
    job["progress"] = serde_json::json!(1.0);
    job["updatedAt"] = serde_json::json!(now_millis()? as i64);
    write_job_json(&app, &job, "analysis_run_local")?;

    Ok(job)
}

/// Return one persisted local job by id.
#[tauri::command]
async fn read_local_job(app: tauri::AppHandle, id: String) -> Result<JsonValue, String> {
    read_job_json(&app, &id)
}

/// Return local jobs sorted by createdAt descending. Optional project filter.
#[tauri::command]
async fn list_local_jobs(app: tauri::AppHandle, project_id: Option<String>) -> Result<Vec<JsonValue>, String> {
    let jobs_root = jobs_dir(&app)?;
    if !jobs_root.exists() {
        return Ok(vec![]);
    }

    let entries = std::fs::read_dir(&jobs_root).map_err(|e| format!("list_local_jobs: {e}"))?;
    let mut jobs: Vec<JsonValue> = Vec::new();

    for entry in entries {
        let path = match entry {
            Ok(e) => e.path(),
            Err(_) => continue,
        };
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }

        let raw = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let job: JsonValue = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if let Some(ref pid) = project_id {
            if job["projectId"].as_str() != Some(pid.as_str()) {
                continue;
            }
        }

        jobs.push(job);
    }

    jobs.sort_by(|a, b| {
        let au = a["createdAt"].as_i64().unwrap_or(0);
        let bu = b["createdAt"].as_i64().unwrap_or(0);
        bu.cmp(&au)
    });

    Ok(jobs)
}

/// Mark a local job as cancelled.
#[tauri::command]
async fn cancel_local_job(app: tauri::AppHandle, id: String) -> Result<JsonValue, String> {
    let mut job = read_job_json(&app, &id)?;
    job["status"] = serde_json::json!("cancelled");
    job["updatedAt"] = serde_json::json!(now_millis()? as i64);
    if job["finishedAt"].is_null() {
        job["finishedAt"] = serde_json::json!(now_millis()? as i64);
    }
    write_job_json(&app, &job, "cancel_local_job")?;

    Ok(job)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopRuntimeInfo {
    grpc_enabled: bool,
    grpc_addr: Option<String>,
    analysis_http_endpoint: Option<String>,
}

/// Return lightweight runtime info so the desktop frontend can react to
/// optional gRPC/analysis passthrough configuration.
#[tauri::command]
async fn get_desktop_runtime_info() -> Result<DesktopRuntimeInfo, String> {
    #[cfg(feature = "grpc")]
    let grpc_addr = Some(grpc_bind_addr());
    #[cfg(not(feature = "grpc"))]
    let grpc_addr: Option<String> = None;

    let analysis_http_endpoint = std::env::var("AW_ANALYSIS_HTTP_ENDPOINT")
        .ok()
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty());

    Ok(DesktopRuntimeInfo {
        grpc_enabled: grpc_addr.is_some(),
        grpc_addr,
        analysis_http_endpoint,
    })
}

#[cfg(feature = "grpc")]
#[derive(Debug, serde::Deserialize)]
struct GrpcAnalyzeOptionsArgs {
    sample_rate: u32,
    overlap: f64,
    min_confidence: f64,
    geo_threshold: f64,
}

#[cfg(feature = "grpc")]
async fn grpc_analysis_client(
) -> Result<grpc::analysis::analysis_service_client::AnalysisServiceClient<tonic::transport::Channel>, String> {
    let endpoint = format!("http://{}", grpc_bind_addr());
    grpc::analysis::analysis_service_client::AnalysisServiceClient::connect(endpoint)
        .await
        .map_err(|e| format!("grpc analysis connect failed: {e}"))
}

#[tauri::command]
async fn grpc_analysis_load_model(model_url: String) -> Result<JsonValue, String> {
    #[cfg(feature = "grpc")]
    {
        let mut client = grpc_analysis_client().await?;
        let response = client
            .load_model(grpc::analysis::LoadModelRequest { model_url })
            .await
            .map_err(|e| format!("grpc load_model failed: {e}"))?
            .into_inner();

        return Ok(serde_json::json!({
            "labelCount": response.label_count,
            "hasAreaModel": response.has_area_model,
        }));
    }

    #[cfg(not(feature = "grpc"))]
    {
        let _ = model_url;
        Err("gRPC bridge is not available in this desktop build".to_string())
    }
}

#[tauri::command]
async fn grpc_analysis_set_location(
    latitude: f64,
    longitude: f64,
    date_iso8601: Option<String>,
) -> Result<JsonValue, String> {
    #[cfg(feature = "grpc")]
    {
        let mut client = grpc_analysis_client().await?;
        let response = client
            .set_location(grpc::analysis::SetLocationRequest {
                latitude,
                longitude,
                date_iso8601: date_iso8601.unwrap_or_default(),
            })
            .await
            .map_err(|e| format!("grpc set_location failed: {e}"))?
            .into_inner();

        return Ok(serde_json::json!({
            "ok": response.ok,
            "week": response.week,
        }));
    }

    #[cfg(not(feature = "grpc"))]
    {
        let _ = (latitude, longitude, date_iso8601);
        Err("gRPC bridge is not available in this desktop build".to_string())
    }
}

#[tauri::command]
async fn grpc_analysis_get_species() -> Result<Vec<JsonValue>, String> {
    #[cfg(feature = "grpc")]
    {
        let mut client = grpc_analysis_client().await?;
        let response = client
            .get_species(grpc::analysis::GetSpeciesRequest {})
            .await
            .map_err(|e| format!("grpc get_species failed: {e}"))?
            .into_inner();

        let items = response
            .species
            .into_iter()
            .map(|i| {
                serde_json::json!({
                    "scientific": i.scientific,
                    "common": i.common,
                    "geoscore": i.geoscore,
                })
            })
            .collect();

        return Ok(items);
    }

    #[cfg(not(feature = "grpc"))]
    {
        Err("gRPC bridge is not available in this desktop build".to_string())
    }
}

#[tauri::command]
async fn grpc_analysis_clear_location() -> Result<(), String> {
    #[cfg(feature = "grpc")]
    {
        let mut client = grpc_analysis_client().await?;
        client
            .clear_location(grpc::analysis::ClearLocationRequest {})
            .await
            .map_err(|e| format!("grpc clear_location failed: {e}"))?;
        return Ok(());
    }

    #[cfg(not(feature = "grpc"))]
    {
        Err("gRPC bridge is not available in this desktop build".to_string())
    }
}

#[tauri::command]
async fn grpc_analysis_analyze(
    samples: Vec<f32>,
    options: Option<JsonValue>,
) -> Result<Vec<JsonValue>, String> {
    #[cfg(feature = "grpc")]
    {
        let mut client = grpc_analysis_client().await?;
        let opts = options
            .map(serde_json::from_value::<GrpcAnalyzeOptionsArgs>)
            .transpose()
            .map_err(|e| format!("invalid grpc analyze options: {e}"))?
            .unwrap_or(GrpcAnalyzeOptionsArgs {
            sample_rate: 48_000,
            overlap: 0.0,
            min_confidence: 0.25,
            geo_threshold: 0.0,
        });

        let response = client
            .analyze(grpc::analysis::AnalyzeRequest {
                samples,
                options: Some(grpc::analysis::AnalyzeOptions {
                    sample_rate: opts.sample_rate,
                    overlap: opts.overlap,
                    min_confidence: opts.min_confidence,
                    geo_threshold: opts.geo_threshold,
                }),
            })
            .await
            .map_err(|e| format!("grpc analyze failed: {e}"))?
            .into_inner();

        let detections = response
            .detections
            .into_iter()
            .map(|d| {
                serde_json::json!({
                    "start": d.start,
                    "end": d.end,
                    "scientific": d.scientific,
                    "common": d.common,
                    "confidence": d.confidence,
                    "geoscore": d.geoscore,
                })
            })
            .collect();

        return Ok(detections);
    }

    #[cfg(not(feature = "grpc"))]
    {
        let _ = (samples, options);
        Err("gRPC bridge is not available in this desktop build".to_string())
    }
}

// ── App entry point ───────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .setup(|_app| {
            #[cfg(feature = "grpc")]
            {
                // Initialise structured logging; RUST_LOG controls filter level.
                // try_init() is a no-op when a subscriber is already registered (e.g. in tests).
                let _ = tracing_subscriber::fmt()
                    .with_env_filter(
                        tracing_subscriber::EnvFilter::try_from_default_env()
                            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
                    )
                    .try_init();

                let app_handle = _app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let addr = grpc_bind_addr();
                    if let Ok(base_dir) = app_handle.path().app_data_dir().map(|d| d.join("projects")) {
                        let store = ProjectStore::new(base_dir);
                        if let Err(err) = grpc::spawn_server(addr, store).await {
                            eprintln!("gRPC server failed: {err}");
                        }
                    }
                });
            }
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            project_create,
            asset_import_local,
            analysis_run_local,
            read_local_job,
            list_local_jobs,
            cancel_local_job,
            read_project,
            write_project,
            list_project_ids,
            list_projects,
            delete_project,
            get_desktop_runtime_info,
            grpc_analysis_load_model,
            grpc_analysis_set_location,
            grpc_analysis_get_species,
            grpc_analysis_clear_location,
            grpc_analysis_analyze,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SignaVis");
}
