// ═══════════════════════════════════════════════════════════════════════
// src-tauri/src/lib.rs — IPC command implementations
//
// Commands are intentionally thin: they translate between the TS layer
// and the native filesystem.  No business logic lives here; the domain
// model is owned by the TypeScript frontend.
// ═══════════════════════════════════════════════════════════════════════

use std::path::PathBuf;
use serde_json::Value as JsonValue;
use serde_json::json;
use tauri::Manager;

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

/// Maps a project id to a filesystem path.
/// Sanitizes the id to prevent path-traversal attacks.
fn project_path(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    // Reject any id that contains directory-separator characters.
    let safe_id: String = id
        .chars()
        .map(|c| if "/\\:*?\"<>|".contains(c) { '_' } else { c })
        .collect();

    if safe_id != id {
        return Err(format!("invalid project id: {id:?}"));
    }

    let dir = projects_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{safe_id}.awproject.json")))
}

// ── IPC Commands ──────────────────────────────────────────────────────

/// Read and return a project by id. Returns an error string when not found.
#[tauri::command]
async fn read_project(app: tauri::AppHandle, id: String) -> Result<JsonValue, String> {
    let path = project_path(&app, &id)?;
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("read_project: {e}"))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("read_project: malformed JSON: {e}"))
}

/// Persist a project.  The `id` field inside the JSON is used as filename.
#[tauri::command]
async fn write_project(app: tauri::AppHandle, project: JsonValue) -> Result<(), String> {
    let id = project["id"]
        .as_str()
        .ok_or("write_project: missing 'id' field")?;
    let path = project_path(&app, id)?;
    let content = serde_json::to_string_pretty(&project)
        .map_err(|e| format!("write_project: {e}"))?;
    std::fs::write(&path, content)
        .map_err(|e| format!("write_project: {e}"))?;
    Ok(())
}

/// Return all project ids stored on disk (unsorted).
#[tauri::command]
async fn list_project_ids(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = projects_dir(&app)?;
    if !dir.exists() {
        return Ok(vec![]);
    }
    let entries = std::fs::read_dir(&dir)
        .map_err(|e| format!("list_project_ids: {e}"))?;

    let ids = entries
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            let name = path.file_name()?.to_str()?;
            name.strip_suffix(".awproject.json").map(|s| s.to_string())
        })
        .collect();

    Ok(ids)
}

/// Return lightweight project summaries sorted by updatedAt descending.
#[tauri::command]
async fn list_projects(app: tauri::AppHandle) -> Result<Vec<JsonValue>, String> {
    let dir = projects_dir(&app)?;
    if !dir.exists() {
        return Ok(vec![]);
    }

    let entries = std::fs::read_dir(&dir)
        .map_err(|e| format!("list_projects: {e}"))?;

    let mut summaries: Vec<JsonValue> = vec![];
    for entry in entries {
        let path = match entry {
            Ok(e) => e.path(),
            Err(_) => continue,
        };
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(id) = name.strip_suffix(".awproject.json") else {
            continue;
        };

        let raw = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let project: JsonValue = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let label_count = project["labels"].as_array().map(|a| a.len()).unwrap_or(0) as u64;
        let annotation_count = project["annotations"].as_array().map(|a| a.len()).unwrap_or(0) as u64;
        summaries.push(json!({
            "id": id,
            "name": project["name"].as_str().unwrap_or("Unnamed Project"),
            "createdAt": project["createdAt"].as_i64().unwrap_or(0),
            "updatedAt": project["updatedAt"].as_i64().unwrap_or(0),
            "audioSource": project["audioSource"].clone(),
            "labelCount": label_count,
            "annotationCount": annotation_count,
        }));
    }

    summaries.sort_by(|a, b| {
        let au = a["updatedAt"].as_i64().unwrap_or(0);
        let bu = b["updatedAt"].as_i64().unwrap_or(0);
        bu.cmp(&au)
    });

    Ok(summaries)
}

/// Remove a project file.  Succeeds silently when the project does not exist.
#[tauri::command]
async fn delete_project(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let path = project_path(&app, &id)?;
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("delete_project: {e}"))?;
    }
    Ok(())
}

// ── App entry point ───────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            read_project,
            write_project,
            list_project_ids,
            list_projects,
            delete_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Audio Workbench");
}
