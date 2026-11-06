// ═══════════════════════════════════════════════════════════════════════
// launch.rs — "open this" requests from outside the app
//
// Sources: command-line arguments (first start, and the second instance
// forwarded by the single-instance plugin), signavis:// deep links, and
// files handed over by macOS (Finder "Open With").
//
// Requests are queued here and the window is told with the event
// LAUNCH_EVENT; the frontend then pulls them with `take_launch_requests`
// (also once at start-up), so nothing is lost before the page is ready.
//
// Deep links (which any web page can trigger) may only open a Xeno-canto
// recording and set the language. Local files come only from the command
// line / file association, i.e. from an action on this computer.
// ═══════════════════════════════════════════════════════════════════════

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager, Url};

pub const SCHEME: &str = "signavis";
pub const LAUNCH_EVENT: &str = "lite-launch";

/// Mirrors AUDIO_EXTENSIONS in src/domain/project/IProjectStore.ts.
const AUDIO_EXTENSIONS: &[&str] = &["wav", "mp3", "flac", "ogg", "oga", "opus", "m4a", "aac", "webm"];

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LaunchRequest {
    /// signavis://open?xc=XC123&lang=de
    Xc { xc: String, lang: Option<String> },
    /// Local audio file (absolute path).
    File { path: String },
}

#[derive(Default)]
pub struct LaunchQueue(pub Mutex<Vec<LaunchRequest>>);

/// "XC123", "xc123", "123", "https://xeno-canto.org/123" → "XC123".
fn normalize_xc(raw: &str) -> Option<String> {
    let digits: String = raw
        .trim()
        .trim_end_matches('/')
        .rsplit('/')
        .next()?
        .trim_start_matches(|c| c == 'X' || c == 'x' || c == 'C' || c == 'c')
        .to_string();
    let n = digits.trim_start_matches('0');
    (!n.is_empty() && n.len() <= 9 && n.chars().all(|c| c.is_ascii_digit())).then(|| format!("XC{n}"))
}

/// Language codes look like "de", "en_uk", "pt-BR", "scientific".
fn valid_lang(lang: &str) -> bool {
    (2..=16).contains(&lang.len()) && lang.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// signavis://open?xc=…&lang=… → request. Anything else is ignored.
pub fn parse_deep_link(url: &Url) -> Option<LaunchRequest> {
    if url.scheme() != SCHEME {
        return None;
    }
    // "signavis://open?…" has host "open"; tolerate "signavis:open?…" and "signavis:///open?…".
    let target = url.host_str().unwrap_or("").to_string() + url.path().trim_matches('/');
    if target != "open" {
        return None;
    }
    let mut xc = None;
    let mut lang = None;
    for (k, v) in url.query_pairs() {
        match k.to_ascii_lowercase().as_str() {
            "xc" | "xcid" => xc = normalize_xc(&v),
            "lang" if valid_lang(&v) => lang = Some(v.into_owned()),
            _ => {}
        }
    }
    Some(LaunchRequest::Xc { xc: xc?, lang })
}

fn file_request(path: &Path) -> Option<LaunchRequest> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if !AUDIO_EXTENSIONS.contains(&ext.as_str()) || !path.is_file() {
        return None;
    }
    let abs = std::fs::canonicalize(path).ok().unwrap_or_else(|| path.to_path_buf());
    // canonicalize adds \\?\ on Windows; the frontend wants a plain path.
    let s = abs.to_string_lossy().trim_start_matches(r"\\?\").to_string();
    Some(LaunchRequest::File { path: s })
}

/// Command-line arguments (without the program name), resolved against `cwd`.
pub fn parse_args<I: IntoIterator<Item = String>>(args: I, cwd: &Path) -> Vec<LaunchRequest> {
    args.into_iter()
        .filter_map(|a| {
            if a.starts_with(&format!("{SCHEME}:")) {
                Url::parse(&a).ok().and_then(|u| parse_deep_link(&u))
            } else if a.starts_with('-') {
                None // flags (e.g. from the OS or WebView2) are not files
            } else {
                let p = PathBuf::from(&a);
                file_request(&if p.is_absolute() { p } else { cwd.join(p) })
            }
        })
        .collect()
}

/// Queue requests, bring the window to the front and tell the page.
pub fn push<R: tauri::Runtime>(app: &tauri::AppHandle<R>, requests: Vec<LaunchRequest>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
    if requests.is_empty() {
        return;
    }
    if let Some(queue) = app.try_state::<LaunchQueue>() {
        queue.0.lock().unwrap().extend(requests);
    }
    let _ = app.emit(LAUNCH_EVENT, ());
}

/// Deep-link URLs (plugin callback, macOS file URLs from RunEvent::Opened).
pub fn push_urls<R: tauri::Runtime>(app: &tauri::AppHandle<R>, urls: &[Url]) {
    let requests = urls
        .iter()
        .filter_map(|u| match u.scheme() {
            "file" => u.to_file_path().ok().and_then(|p| file_request(&p)),
            _ => parse_deep_link(u),
        })
        .collect();
    push(app, requests);
}

#[tauri::command]
pub fn take_launch_requests(queue: tauri::State<'_, LaunchQueue>) -> Vec<LaunchRequest> {
    std::mem::take(&mut *queue.0.lock().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(s: &str) -> Option<LaunchRequest> {
        parse_deep_link(&Url::parse(s).unwrap())
    }

    #[test]
    fn deep_links_open_xc_recordings_only() {
        assert_eq!(link("signavis://open?xc=XC1191997&lang=de"),
            Some(LaunchRequest::Xc { xc: "XC1191997".into(), lang: Some("de".into()) }));
        assert_eq!(link("signavis://open?xcid=0042"), Some(LaunchRequest::Xc { xc: "XC42".into(), lang: None }));
        assert_eq!(link("signavis://open/?XC=xc7&lang=en_uk"),
            Some(LaunchRequest::Xc { xc: "XC7".into(), lang: Some("en_uk".into()) }));
        // no / bad XC id, other actions, foreign schemes, unsafe parameters
        for bad in ["signavis://open", "signavis://open?xc=abc", "signavis://open?xc=0",
                    "signavis://delete?xc=1", "https://open?xc=1", "signavis://open?file=C:/x.wav"] {
            assert_eq!(link(bad), None, "{bad}");
        }
        assert_eq!(link("signavis://open?xc=1&lang=<script>"), Some(LaunchRequest::Xc { xc: "XC1".into(), lang: None }));
    }

    #[test]
    fn xc_ids_are_normalized() {
        assert_eq!(normalize_xc("https://xeno-canto.org/123456/").as_deref(), Some("XC123456"));
        assert_eq!(normalize_xc("Xc 12").as_deref(), None);
        assert_eq!(normalize_xc("1234567890").as_deref(), None);
    }

    #[test]
    fn args_yield_audio_files_and_links() {
        let dir = std::env::temp_dir().join(format!("signavis-launch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.WAV"), b"RIFF").unwrap();
        std::fs::write(dir.join("notes.txt"), b"x").unwrap();
        let reqs = parse_args(
            ["a.WAV", "notes.txt", "missing.mp3", "--flag", "signavis://open?xc=5"].map(String::from),
            &dir,
        );
        assert_eq!(reqs.len(), 2);
        match &reqs[0] {
            LaunchRequest::File { path } => assert!(path.ends_with("a.WAV") && !path.starts_with(r"\\?\")),
            other => panic!("{other:?}"),
        }
        assert_eq!(reqs[1], LaunchRequest::Xc { xc: "XC5".into(), lang: None });
        let _ = std::fs::remove_dir_all(&dir);
    }
}
