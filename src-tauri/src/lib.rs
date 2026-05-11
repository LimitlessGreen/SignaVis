// ═══════════════════════════════════════════════════════════════════════
// src-tauri/src/lib.rs — App entry point + IPC command registration
//
// Business logic lives in commands/ and helpers/.
// Domain model is owned by the TypeScript frontend.
// ═══════════════════════════════════════════════════════════════════════

#[cfg(feature = "grpc")]
pub mod grpc;
mod connection_manager;
mod helpers;
mod project_store;

pub mod commands;

use connection_manager::{load_config, ConnectionManager};
use commands::*;
use tauri::Manager;


pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // ?????? Connection manager ????????????????????????????????????????????????????????????????????????????????????????????????
            let conn_config = load_config(app.handle());
            let conn_manager = ConnectionManager::new(conn_config);
            conn_manager.start(app.handle());
            app.manage(conn_manager);

            // ?????? gRPC server (feature-gated) ?????????????????????????????????????????????????????????????????????
            #[cfg(feature = "grpc")]
            {
                let _ = tracing_subscriber::fmt()
                    .with_env_filter(
                        tracing_subscriber::EnvFilter::try_from_default_env()
                            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
                    )
                    .try_init();

                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let addr = commands::grpc::grpc_bind_addr();
                    if let Ok(base_dir) = app_handle
                        .path()
                        .app_data_dir()
                        .map(|d| d.join("projects"))
                    {
                        let store = project_store::ProjectStore::new(base_dir);
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
            connection_get_config,
            connection_get_status,
            connection_set_config,
            grpc_analysis_load_model,
            grpc_analysis_set_location,
            grpc_analysis_get_species,
            grpc_analysis_clear_location,
            grpc_analysis_analyze,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SignaVis");
}
