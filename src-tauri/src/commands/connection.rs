use crate::connection_manager::{ConnectionManager, ConnectionConfig, ConnectionStatus};
use std::sync::Arc;
use crate::corpus_store::CorpusStore;

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

/// Login to a remote SurrealDB server; stores the JWT token in the connection manager
/// and connects the corpus store to the server.
#[tauri::command]
pub async fn connection_login(
    app: tauri::AppHandle,
    manager: tauri::State<'_, ConnectionManager>,
    store: tauri::State<'_, Arc<CorpusStore>>,
    username: String,
    password: String,
) -> Result<String, String> {
    let token = manager.login(username, password, app).await?;

    // Connect the corpus store to the server (server-db feature only)
    #[cfg(feature = "server-db")]
    {
        let ws = manager.db_ws_endpoint();
        let ns = manager.namespace();
        let db = manager.database();
        store.reconnect_server(&ws, &ns, &db, &token).await?;
    }

    Ok(token)
}

#[tauri::command]
pub fn connection_logout(
    app: tauri::AppHandle,
    manager: tauri::State<'_, ConnectionManager>,
    store: tauri::State<'_, Arc<CorpusStore>>,
) {
    manager.logout(&app);
    store.disconnect_server();
}

#[tauri::command]
pub fn connection_get_whoami(
    manager: tauri::State<'_, ConnectionManager>,
) -> Option<String> {
    manager.whoami()
}
