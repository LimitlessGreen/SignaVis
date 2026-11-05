// ═══════════════════════════════════════════════════════════════════════
// SignaVis Lite — desktop shell around the static labeling app.
//
// Probe mode (Phase 0 spike): with SIGNAVIS_LITE_PROBE=<file> set, the
// window opens lite-probe.html, which checks the webview's capabilities,
// hands the JSON report to `probe_report`, and the app exits.
// ═══════════════════════════════════════════════════════════════════════

use tauri::{WebviewUrl, WebviewWindowBuilder};

const PROBE_ENV: &str = "SIGNAVIS_LITE_PROBE";

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
        .invoke_handler(tauri::generate_handler![probe_report])
        .setup(|app| {
            let page = if std::env::var_os(PROBE_ENV).is_some() {
                "demo/lite-probe.html"
            } else {
                "demo/labeling-app.html"
            };
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App(page.into()))
                .title("SignaVis Lite")
                .inner_size(1400.0, 900.0)
                .min_inner_size(900.0, 600.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running SignaVis Lite");
}
