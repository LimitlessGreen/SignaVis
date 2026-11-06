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
mod menu;
mod project_fs;
mod updater;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;

const PROBE_ENV: &str = "SIGNAVIS_LITE_PROBE";

/// Throw-away profile for screenshots and tests (scripts/lite-store-screenshots.mjs):
/// the default project and the webview's storage live in this folder instead of
/// the user's app data. The BirdNET/data cache stays shared.
const DATA_DIR_ENV: &str = "SIGNAVIS_LITE_DATA_DIR";

pub(crate) fn data_dir_override() -> Option<std::path::PathBuf> {
    std::env::var_os(DATA_DIR_ENV).filter(|v| !v.is_empty()).map(Into::into)
}

/// Runs before any page script: lets the frontend tell Lite apart from the
/// full desktop shell (see src/infrastructure/tauri/runtime.ts).
macro_rules! lite_marker {
    ($store:literal) => {
        concat!(
            "Object.defineProperty(window, '__SIGNAVIS_LITE__', { value: Object.freeze({ version: '",
            env!("CARGO_PKG_VERSION"),
            "', store: ",
            $store,
            " }), enumerable: false });"
        )
    };
}
#[cfg(not(feature = "store"))]
const LITE_MARKER_SCRIPT: &str = lite_marker!("false");
#[cfg(feature = "store")]
const LITE_MARKER_SCRIPT: &str = lite_marker!("true");

#[tauri::command]
fn probe_report(app: tauri::AppHandle, report: String) -> Result<(), String> {
    let path = std::env::var(PROBE_ENV).map_err(|_| "probe mode is off".to_string())?;
    std::fs::write(&path, report).map_err(|e| format!("write {path}: {e}"))?;
    println!("probe report written to {path}");
    app.exit(0);
    Ok(())
}

pub fn run() {
    let builder = tauri::Builder::default()
        // Must be the first plugin: a second instance exits before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let args = argv.into_iter().skip(1);
            launch::push(app, launch::parse_args(args, std::path::Path::new(&cwd)));
        }))
        .plugin(tauri_plugin_deep_link::init())
        // Size, position and maximized state of the window survive restarts.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .register_asynchronous_uri_scheme_protocol(data_cache::SCHEME, data_cache::handle)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
    // Store builds are updated by the Store (its policies forbid self-updating).
    #[cfg(not(feature = "store"))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    let app = builder
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
            menu::set_recent_items,
            data_cache::prefetch_model,
            updater::update_check,
            updater::update_install,
        ])
        .on_menu_event(|app, event| menu::on_event(app, event.id().as_ref()))
        .manage(launch::LaunchQueue::default())
        .manage(updater::PendingUpdate::default())
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

            let app_menu = menu::build(app.handle())?;
            app.set_menu(app_menu)?;

            let page = if std::env::var_os(PROBE_ENV).is_some() {
                "demo/lite-probe.html"
            } else {
                "demo/labeling-app.html"
            };
            let mut window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App(page.into()));
            if let Some(dir) = data_dir_override() {
                window = window.data_directory(dir.join("webview"));
            }
            window
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
