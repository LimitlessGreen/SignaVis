// ═══════════════════════════════════════════════════════════════════════
// src-tauri/src/lib.rs — IPC command implementations
//
// Commands are intentionally thin: they translate between the TS layer
// and the native filesystem.  No business logic lives here; the domain
// model is owned by the TypeScript frontend.
// ═══════════════════════════════════════════════════════════════════════

use std::path::PathBuf;
use serde_json::Value as JsonValue;
use serde::Serialize;
use tauri::Manager;

#[cfg(feature = "grpc")]
pub mod grpc;
mod project_store;

use project_store::ProjectStore;

// ── Path helpers ─────────────────────────────────────────────────────

/// Returns the platform-specific directory where project files are kept.
///   macOS : ~/Library/Application Support/io.github.limitlessgreen.audio-workbench/projects/
///   Linux : ~/.local/share/io.github.limitlessgreen.audio-workbench/projects/
///   Windows: %APPDATA%\io.github.limitlessgreen.audio-workbench\projects\
fn projects_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("projects"))
        .map_err(|e| e.to_string())
}

fn project_store(app: &tauri::AppHandle) -> Result<ProjectStore, String> {
    Ok(ProjectStore::new(projects_dir(app)?))
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
        .expect("error while running Audio Workbench");
}
