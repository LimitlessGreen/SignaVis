use std::path::PathBuf;
use tauri::Manager;
use crate::project_store::ProjectStore;

/// Returns the platform-specific directory where project files are kept.
///   macOS : ~/Library/Application Support/io.github.limitlessgreen.signavis/projects/
///   Linux : ~/.local/share/io.github.limitlessgreen.signavis/projects/
///   Windows: %APPDATA%\io.github.limitlessgreen.signavis\projects\
pub fn projects_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("projects"))
        .map_err(|e| e.to_string())
}

pub fn project_store(app: &tauri::AppHandle) -> Result<ProjectStore, String> {
    Ok(ProjectStore::new(projects_dir(app)?))
}

pub fn assets_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("assets"))
        .map_err(|e| e.to_string())
}

pub fn jobs_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("jobs"))
        .map_err(|e| e.to_string())
}
