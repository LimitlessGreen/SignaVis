// ═══════════════════════════════════════════════════════════════════════
// Self-update over GitHub Releases (tauri-plugin-updater).
//
// The release's latest.json lists one signed bundle per platform; the
// signature is checked against the public key in tauri.conf.json (our own
// Tauri updater key — independent of OS code signing).
//
// Flow: the page calls `update_check` (quietly at start, or from
// Help › Check for Updates…), asks the user, flushes its autosave, then
// calls `update_install`, which downloads, installs and restarts.
// ═══════════════════════════════════════════════════════════════════════

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The update found by the last `update_check`, kept for `update_install`.
#[derive(Default)]
pub struct PendingUpdate(pub Mutex<Option<Update>>);

#[derive(Serialize)]
pub struct UpdateInfo {
    version: String,
    current: String,
    notes: Option<String>,
}

#[derive(Serialize, Clone)]
struct Progress {
    done: u64,
    total: Option<u64>,
}

#[tauri::command]
pub async fn update_check<R: Runtime>(
    app: AppHandle<R>,
    pending: State<'_, PendingUpdate>,
) -> Result<Option<UpdateInfo>, String> {
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let info = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone(),
    });
    *pending.0.lock().unwrap() = update;
    Ok(info)
}

#[tauri::command]
pub async fn update_install<R: Runtime>(
    app: AppHandle<R>,
    pending: State<'_, PendingUpdate>,
) -> Result<(), String> {
    let update = pending
        .0
        .lock()
        .unwrap()
        .take()
        .ok_or("no update pending — check first")?;
    let mut done = 0u64;
    let progress_app = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                done += chunk as u64;
                let _ = progress_app.emit("lite-update-progress", Progress { done, total });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    // On Windows the installer has already taken over and ends the app.
    app.restart();
}
