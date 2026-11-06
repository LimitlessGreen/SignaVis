// ═══════════════════════════════════════════════════════════════════════
// project_fs.rs — file access for project folders (NativeProjectStore.ts)
//
// Every command takes the project root (absolute) plus a path relative to
// it. Relative paths are checked: no absolute paths, no '..', no drive
// prefixes — the frontend can only touch files below a root it names.
// Writes go to a temp file next to the target and are renamed into place.
// Binary payloads travel as raw IPC bodies (no JSON number arrays).
// ═══════════════════════════════════════════════════════════════════════

use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::Manager;

/// Mirrors AUDIO_EXTENSIONS in src/domain/project/IProjectStore.ts.
const AUDIO_EXTENSIONS: &[&str] = &["wav", "mp3", "flac", "ogg", "oga", "opus", "m4a", "aac", "webm"];
/// Mirrors SKIP_DIRS in DirectoryProjectStore.ts (plus hidden directories).
const SKIP_DIRS: &[&str] = &["node_modules", ".git", ".signavis-trash"];
const MAX_DEPTH: usize = 8;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    path: String,
    size: u64,
    last_modified: f64,
}

/// Join `rel` onto `root`, refusing anything that could leave the root.
fn resolve(root: &str, rel: &str) -> Result<PathBuf, String> {
    let root = Path::new(root);
    if !root.is_absolute() {
        return Err(format!("project root is not absolute: {}", root.display()));
    }
    let rel_path = Path::new(rel);
    let mut out = root.to_path_buf();
    let mut parts = 0;
    for c in rel_path.components() {
        match c {
            // '\' and ':' are separators / drive markers on Windows; reject them
            // everywhere so a path means the same on every OS.
            Component::Normal(p) if p.to_string_lossy().contains(['\\', ':']) => {
                return Err(format!("invalid project path: {rel}"));
            }
            Component::Normal(p) => {
                out.push(p);
                parts += 1;
            }
            Component::CurDir => {}
            _ => return Err(format!("invalid project path: {rel}")),
        }
    }
    if parts == 0 {
        return Err(format!("invalid project path: {rel}"));
    }
    Ok(out)
}

fn modified_ms(meta: &std::fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

fn header<'a>(request: &'a Request<'_>, name: &str) -> Result<String, String> {
    let raw = request
        .headers()
        .get(name)
        .ok_or_else(|| format!("missing header {name}"))?
        .to_str()
        .map_err(|e| format!("header {name}: {e}"))?;
    // Headers are ASCII; the frontend percent-encodes paths.
    percent_decode(raw)
}

fn percent_decode(s: &str) -> Result<String, String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|e| e.to_string())?;
            out.push(u8::from_str_radix(hex, 16).map_err(|e| format!("bad escape %{hex}: {e}"))?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

fn write_atomic(target: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    let name = target.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = target.with_file_name(format!(".{name}.{}.tmp", std::process::id()));
    std::fs::write(&tmp, data).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("replace {}: {e}", target.display())
    })
}

/// Size and mtime of a file, or None when it does not exist.
#[tauri::command]
pub fn project_stat(root: String, path: String) -> Result<Option<FileInfo>, String> {
    let full = resolve(&root, &path)?;
    match std::fs::metadata(&full) {
        Ok(meta) if meta.is_file() => Ok(Some(FileInfo { path, size: meta.len(), last_modified: modified_ms(&meta) })),
        Ok(_) => Ok(None),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("stat {}: {e}", full.display())),
    }
}

/// File bytes as a raw response. A missing file is the error "not-found".
#[tauri::command]
pub fn project_read(root: String, path: String) -> Result<Response, String> {
    let full = resolve(&root, &path)?;
    match std::fs::read(&full) {
        Ok(bytes) => Ok(Response::new(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err("not-found".into()),
        Err(e) => Err(format!("read {}: {e}", full.display())),
    }
}

/// Raw body = file content; headers `x-root` and `x-path` (percent-encoded).
#[tauri::command]
pub fn project_write(request: Request<'_>) -> Result<(), String> {
    let root = header(&request, "x-root")?;
    let path = header(&request, "x-path")?;
    let full = resolve(&root, &path)?;
    match request.body() {
        InvokeBody::Raw(bytes) => write_atomic(&full, bytes),
        InvokeBody::Json(_) => Err("project_write expects a raw body".into()),
    }
}

/// Audio files below the root (relative '/' paths), like DirectoryProjectStore.listAudio.
#[tauri::command]
pub fn project_list_audio(root: String) -> Result<Vec<FileInfo>, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("not a folder: {root}"));
    }
    let mut out = Vec::new();
    let walker = walkdir::WalkDir::new(&root_path).max_depth(MAX_DEPTH + 1).into_iter().filter_entry(|e| {
        if e.depth() == 0 || !e.file_type().is_dir() {
            return true;
        }
        let name = e.file_name().to_string_lossy();
        !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_ref())
    });
    for entry in walker.flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let ext = entry.path().extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
        if !AUDIO_EXTENSIONS.contains(&ext.as_str()) {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(&root_path) else { continue };
        let rel = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
        let Ok(meta) = entry.metadata() else { continue };
        out.push(FileInfo { path: rel, size: meta.len(), last_modified: modified_ms(&meta) });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// Folder of the default project (created on demand): <app data>/projects/default.
#[tauri::command]
pub fn default_project_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("projects").join("default");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> String {
        if cfg!(windows) { r"C:\proj".into() } else { "/proj".into() }
    }

    #[test]
    fn resolve_accepts_nested_relative_paths() {
        let p = resolve(&root(), "xc/XC1.mp3").unwrap();
        assert!(p.ends_with(Path::new("xc").join("XC1.mp3")));
        assert!(p.starts_with(root()));
    }

    #[test]
    fn resolve_rejects_escapes() {
        for bad in ["../x", "a/../../x", "", ".", "/etc/passwd", r"C:\x", r"\\server\share\x"] {
            assert!(resolve(&root(), bad).is_err(), "{bad:?} should be rejected");
        }
        assert!(resolve("relative/root", "a.wav").is_err());
    }

    #[test]
    fn percent_decoding_round_trips_unicode_paths() {
        assert_eq!(percent_decode("C%3A%5CUsers%5CJ%C3%BCrgen").unwrap(), r"C:\Users\Jürgen");
        assert_eq!(percent_decode("plain").unwrap(), "plain");
        assert!(percent_decode("%zz").is_err());
    }

    #[test]
    fn write_list_read_round_trip() {
        let dir = std::env::temp_dir().join(format!("signavis-lite-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let root = dir.to_string_lossy().into_owned();
        write_atomic(&resolve(&root, "audio/a.wav").unwrap(), b"RIFF").unwrap();
        write_atomic(&resolve(&root, "xc/XC1.mp3").unwrap(), b"ID3x").unwrap();
        write_atomic(&resolve(&root, ".hidden/b.wav").unwrap(), b"x").unwrap();
        write_atomic(&resolve(&root, "project.signavis.json").unwrap(), b"{}").unwrap();
        let listed: Vec<String> = project_list_audio(root.clone()).unwrap().into_iter().map(|f| f.path).collect();
        assert_eq!(listed, vec!["audio/a.wav", "xc/XC1.mp3"]);
        let stat = project_stat(root.clone(), "audio/a.wav".into()).unwrap().unwrap();
        assert_eq!(stat.size, 4);
        assert!(project_stat(root.clone(), "missing.wav".into()).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
