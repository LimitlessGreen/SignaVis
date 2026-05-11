use crate::connection_manager::{ConnectionManager, ConnectionConfig, ConnectionStatus};

#[tauri::command]
pub fn connection_get_config(
    manager: tauri::State<'_, ConnectionManager>,
) -> ConnectionConfig {
    manager.config()
}

#[tauri::command]
pub fn connection_get_status(
    manager: tauri::State<'_, ConnectionManager>,
) -> ConnectionStatus {
    manager.status()
}

#[tauri::command]
pub fn connection_set_config(
    app: tauri::AppHandle,
    manager: tauri::State<'_, ConnectionManager>,
    config: ConnectionConfig,
) -> ConnectionStatus {
    manager.set_config(config, &app);
    manager.status()
}
