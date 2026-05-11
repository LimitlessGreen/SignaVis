use serde::Deserialize;
use serde_json::Value as JsonValue;
use crate::helpers::path::project_store;
use crate::helpers::time::{now_millis, new_id};

#[tauri::command]
pub async fn read_project(app: tauri::AppHandle, id: String) -> Result<JsonValue, String> {
    project_store(&app)?.read_project_json(&id)
}

#[tauri::command]
pub async fn write_project(app: tauri::AppHandle, project: JsonValue) -> Result<(), String> {
    project_store(&app)?.write_project_json(&project)
}

#[tauri::command]
pub async fn list_project_ids(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    project_store(&app)?.list_project_ids()
}

#[tauri::command]
pub async fn list_projects(app: tauri::AppHandle) -> Result<Vec<JsonValue>, String> {
    project_store(&app)?.list_project_summaries()
}

#[tauri::command]
pub async fn delete_project(app: tauri::AppHandle, id: String) -> Result<(), String> {
    project_store(&app)?.delete_project(&id)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCreateArgs {
    pub name: Option<String>,
}

#[tauri::command]
pub async fn project_create(
    app: tauri::AppHandle,
    args: Option<ProjectCreateArgs>,
) -> Result<JsonValue, String> {
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
