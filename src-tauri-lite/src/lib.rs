// ═══════════════════════════════════════════════════════════════════════
// SignaVis Lite — desktop shell around the static labeling app.
//
// One instance only: a second start (deep link, "Open with", command line)
// hands its arguments to the running app (launch.rs) and exits.
//
// Probe mode (Phase 0 spike): with SIGNAVIS_LITE_PROBE=<file> set, the
// window opens lite-probe.html, which checks the webview's capabilities,
// hands the JSON report to `probe_report`, and the app exits.
// ═══════════════════════════════════════════════════════════════════════

mod data_cache;
mod launch;
mod project_fs;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;

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
    let app = tauri::Builder::default()
        // Must be the first plugin: a second instance exits before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let args = argv.into_iter().skip(1);
            launch::push(app, launch::parse_args(args, std::path::Path::new(&cwd)));
        }))
        .plugin(tauri_plugin_deep_link::init())
        .register_asynchronous_uri_scheme_protocol(data_cache::SCHEME, data_cache::handle)
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
            launch::take_launch_requests,
        ])
        .manage(launch::LaunchQueue::default())
        .setup(|app| {
            // Installers register signavis:// ; an AppImage, and a dev build on
            // Windows, have to do it themselves at run time.
            #[cfg(any(target_os = "linux", all(windows, debug_assertions)))]
            if let Err(e) = app.deep_link().register_all() {
                eprintln!("[launch] cannot register {}://: {e}", launch::SCHEME);
            }
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| launch::push_urls(&handle, &event.urls()));
            // Arguments of this (first) start: files to open, or a deep link on Windows/Linux.
            let cwd = std::env::current_dir().unwrap_or_default();
            let initial = launch::parse_args(std::env::args().skip(1), &cwd);
            app.state::<launch::LaunchQueue>().0.lock().unwrap().extend(initial);

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
        .build(tauri::generate_context!())
        .expect("error while building SignaVis Lite");
    app.run(|_handle, _event| {
        // macOS hands files from Finder ("Open With") over as an event, not as arguments.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = &_event {
            launch::push_urls(_handle, urls);
        }
    });
}
