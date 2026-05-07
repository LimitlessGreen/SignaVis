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
    let grpc_addr = std::env::var("AW_GRPC_ADDR")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
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

// ── App entry point ───────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .setup(|_app| {
            #[cfg(feature = "grpc")]
            {
                let app_handle = _app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Ok(addr) = std::env::var("AW_GRPC_ADDR") {
                        if let Ok(base_dir) = app_handle.path().app_data_dir().map(|d| d.join("projects")) {
                            let store = ProjectStore::new(base_dir);
                            if let Err(err) = grpc::spawn_server(addr, store).await {
                                eprintln!("gRPC server failed: {err}");
                            }
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Audio Workbench");
}
