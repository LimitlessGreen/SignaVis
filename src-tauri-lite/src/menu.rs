// ═══════════════════════════════════════════════════════════════════════
// menu.rs — native application menu of SignaVis Lite
//
// Most items are handled by the page: their id is sent as the event
// MENU_EVENT and labeling-app.html calls the matching function. Quit goes
// through the window's close request, so the close guard (save first)
// applies. "Open Recent" is filled by the page (set_recent_items).
//
// Shortcuts avoid what the app itself uses (Ctrl/Cmd + C, V, Z, Y, A, …).
// The Edit menu exists only on macOS, where text fields need it for
// Cmd+C/V; Undo/Redo stay with the app's own undo stack.
// ═══════════════════════════════════════════════════════════════════════

use serde::Deserialize;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_opener::OpenerExt;

pub const MENU_EVENT: &str = "lite-menu";
const RECENT_PREFIX: &str = "recent:";
const DOCS_URL: &str = "https://limitlessgreen.github.io/SignaVis/docs/";
const ISSUES_URL: &str = "https://github.com/LimitlessGreen/SignaVis/issues";
const WEB_APP_URL: &str = "https://limitlessgreen.github.io/SignaVis/demo/labeling-app.html?browser=1";

pub struct RecentMenu<R: Runtime>(pub Mutex<Option<Submenu<R>>>);

#[derive(Deserialize)]
pub struct RecentEntry {
    id: String,
    label: String,
}

fn item<R: Runtime>(app: &AppHandle<R>, id: &str, text: &str, accel: Option<&str>) -> tauri::Result<MenuItem<R>> {
    let mut b = MenuItemBuilder::with_id(id, text);
    if let Some(a) = accel {
        b = b.accelerator(a);
    }
    b.build(app)
}

fn fill_recent<R: Runtime>(app: &AppHandle<R>, sub: &Submenu<R>, entries: &[RecentEntry]) -> tauri::Result<()> {
    for old in sub.items()? {
        sub.remove(&old)?;
    }
    if entries.is_empty() {
        let none = MenuItemBuilder::with_id("recent-none", "No recent items").enabled(false).build(app)?;
        sub.append(&none)?;
        return Ok(());
    }
    for e in entries {
        sub.append(&item(app, &format!("{RECENT_PREFIX}{}", e.id), &e.label, None)?)?;
    }
    sub.append(&PredefinedMenuItem::separator(app)?)?;
    sub.append(&item(app, "recent-clear", "Clear Recent", None)?)?;
    Ok(())
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let recent = SubmenuBuilder::new(app, "Open Recent").build()?;
    fill_recent(app, &recent, &[])?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&item(app, "open-file", "Open Audio File…", Some("CmdOrCtrl+O"))?)
        .item(&item(app, "open-folder", "Open Project Folder…", Some("CmdOrCtrl+Shift+O"))?)
        .item(&recent)
        .item(&item(app, "default-project", "Use Default Project", None)?)
        .separator()
        .item(&item(app, "export-labels", "Export Labels…", Some("CmdOrCtrl+Shift+E"))?)
        .item(&item(app, "prefetch-model", "Download BirdNET Model for Offline Use", None)?)
        .separator()
        .item(&item(app, "quit", if cfg!(windows) { "Exit" } else { "Quit" }, Some("CmdOrCtrl+Q"))?)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&item(app, "fullscreen", "Toggle Full Screen", Some(if cfg!(target_os = "macos") { "Ctrl+Cmd+F" } else { "F11" }))?)
        .build()?;

    // Store builds are updated by the Store: no "Check for Updates…".
    let check_updates = item(app, "check-updates", "Check for Updates…", None)?;
    let mut help = SubmenuBuilder::new(app, "Help")
        .item(&item(app, "docs", "Documentation", None)?)
        .item(&item(app, "issues", "Report an Issue", None)?)
        .item(&item(app, "web-app", "Open the Web Version", None)?)
        .separator();
    if !cfg!(feature = "store") {
        help = help.item(&check_updates);
    }
    let help = help.item(&item(app, "about", "About SignaVis Lite", None)?).build()?;

    app.manage(RecentMenu(Mutex::new(Some(recent))));

    let mut menu = MenuBuilder::new(app);
    #[cfg(target_os = "macos")]
    {
        let app_menu = SubmenuBuilder::new(app, "SignaVis Lite")
            .item(&item(app, "about", "About SignaVis Lite", None)?)
            .item(&item(app, "check-updates", "Check for Updates…", None)?)
            .separator()
            .item(&PredefinedMenuItem::hide(app, None)?)
            .item(&PredefinedMenuItem::hide_others(app, None)?)
            .item(&PredefinedMenuItem::show_all(app, None)?)
            .separator()
            .item(&item(app, "quit", "Quit SignaVis Lite", Some("Cmd+Q"))?)
            .build()?;
        let edit = SubmenuBuilder::new(app, "Edit")
            .item(&PredefinedMenuItem::cut(app, None)?)
            .item(&PredefinedMenuItem::copy(app, None)?)
            .item(&PredefinedMenuItem::paste(app, None)?)
            .item(&PredefinedMenuItem::select_all(app, None)?)
            .build()?;
        menu = menu.item(&app_menu).item(&file).item(&edit);
    }
    #[cfg(not(target_os = "macos"))]
    {
        menu = menu.item(&file);
    }
    menu.item(&view).item(&help).build()
}

pub fn on_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let win = app.get_webview_window("main");
    let open = |url: &str| {
        if let Err(e) = app.opener().open_url(url, None::<&str>) {
            eprintln!("[menu] cannot open {url}: {e}");
        }
    };
    match id {
        // Through the close request, so the page can save first (close guard).
        "quit" => {
            if let Some(w) = win {
                let _ = w.close();
            } else {
                app.exit(0);
            }
        }
        "fullscreen" => {
            if let Some(w) = win {
                let _ = w.set_fullscreen(!w.is_fullscreen().unwrap_or(false));
            }
        }
        "docs" => open(DOCS_URL),
        "issues" => open(ISSUES_URL),
        "web-app" => open(WEB_APP_URL),
        _ => {
            let _ = app.emit(MENU_EVENT, id);
        }
    }
}

/// The page sends its recent list (newest first); ids come back as "recent:<id>".
#[tauri::command]
pub fn set_recent_items<R: Runtime>(app: AppHandle<R>, items: Vec<RecentEntry>) -> Result<(), String> {
    let state = app.try_state::<RecentMenu<R>>().ok_or("menu not built")?;
    let guard = state.0.lock().unwrap();
    let sub = guard.as_ref().ok_or("menu not built")?;
    fill_recent(&app, sub, &items).map_err(|e| e.to_string())
}
