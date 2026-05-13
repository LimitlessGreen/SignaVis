// ═══════════════════════════════════════════════════════════════════════
// src-tauri/src/lib.rs — App entry point + IPC command registration
//
// Business logic lives in commands/ and helpers/.
// Domain model is owned by the TypeScript frontend.
// ═══════════════════════════════════════════════════════════════════════

#[cfg(feature = "grpc")]
pub mod grpc;
mod connection_manager;
mod corpus_store;
mod helpers;
mod project_store;

pub mod commands;

use connection_manager::{load_config, ConnectionManager};
use commands::*;
use corpus_store::CorpusStore;
use std::sync::Arc;
use tauri::Manager;


pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // ── Connection manager ───────────────────────────────────
            let conn_config = load_config(app.handle());
            let conn_manager = ConnectionManager::new(conn_config);
            conn_manager.start(app.handle());
            app.manage(conn_manager);

            // ── CorpusStore (SurrealDB embedded) ─────────────────────
            let corpus_data_dir = app
                .path()
                .app_data_dir()
                .map(|d| d.join("dataset"))
                .map_err(|e| format!("corpus_store: app_data_dir: {e}"))?;

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match CorpusStore::open(corpus_data_dir).await {
                    Ok(store) => {
                        app_handle.manage(Arc::new(store) as Arc<CorpusStore>);
                    }
                    Err(e) => {
                        eprintln!("CorpusStore init failed: {e}");
                    }
                }
            });

            // ── gRPC server (feature-gated) ──────────────────────────
            #[cfg(feature = "grpc")]
            {
                let _ = tracing_subscriber::fmt()
                    .with_env_filter(
                        tracing_subscriber::EnvFilter::try_from_default_env()
                            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
                    )
                    .try_init();

                let app_handle2 = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let addr = commands::grpc::grpc_bind_addr();
                    if let Ok(base_dir) = app_handle2
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
            // ── Legacy project commands (Labeling App) ───────────────
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
            // ── Dataset commands (v2 Architektur) ────────────────────
            dataset_create,
            dataset_list,
            dataset_get,
            dataset_delete,
            dataset_update_meta,
            dataset_add_field_to_schema,
            dataset_save_view,
            dataset_delete_view,
            // ── Recording commands (v2 Architektur) ──────────────────
            recording_import_folder,
            recording_list,
            recording_get,
            recording_set_tags,
            recording_delete,
            recording_count,
            recording_distinct_values,
            // ── Dataset-Analyse (BirdNET-Inferenz) ───────────────────
            dataset_run_birdnet,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SignaVis");
}
