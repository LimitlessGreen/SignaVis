// ═══════════════════════════════════════════════════════════════════════
// SignaVis Lite — desktop shell around the static labeling app.
//
// Probe mode (Phase 0 spike): with SIGNAVIS_LITE_PROBE=<file> set, the
// window opens lite-probe.html, which checks the webview's capabilities,
// hands the JSON report to `probe_report`, and the app exits.
// ═══════════════════════════════════════════════════════════════════════

mod project_fs;

use tauri::{WebviewUrl, WebviewWindowBuilder};

const PROBE_ENV: &str = "SIGNAVIS_LITE_PROBE";

/// Runs before any page script: lets the frontend tell Lite apart from the
/// full desktop shell (see src/infrastructure/tauri/runtime.ts).
const LITE_MARKER_SCRIPT: &str = concat!(
    "Object.defineProperty(window, '__SIGNAVIS_LITE__', { value: Object.freeze({ version: '",
    env!("CARGO_PKG_VERSION"),
    "' }), enumerable: false });"
);

#[tauri::command]
fn probe_report(app: tauri::AppHandle, report: String) -> Result<(), String> {
    let path = std::env::var(PROBE_ENV).map_err(|_| "probe mode is off".to_string())?;
    std::fs::write(&path, report).map_err(|e| format!("write {path}: {e}"))?;
    println!("probe report written to {path}");
    app.exit(0);
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            probe_report,
            project_fs::project_stat,
            project_fs::project_read,
            project_fs::project_write,
            project_fs::project_list_audio,
            project_fs::default_project_dir,
            project_fs::read_audio_file,
            project_fs::save_user_file,
        ])
        .setup(|app| {
            let page = if std::env::var_os(PROBE_ENV).is_some() {
                "demo/lite-probe.html"
            } else {
                "demo/labeling-app.html"
            };
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App(page.into()))
                .title("SignaVis Lite")
                .initialization_script(LITE_MARKER_SCRIPT)
                // Keep HTML5 drag & drop: dropping audio files and dragging label rows
                // (Tauri's own handler would swallow both on Windows).
                .disable_drag_drop_handler()
                .inner_size(1400.0, 900.0)
                .min_inner_size(900.0, 600.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running SignaVis Lite");
}
