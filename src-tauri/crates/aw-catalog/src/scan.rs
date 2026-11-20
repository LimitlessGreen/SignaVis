//! Folder scan: audio files + known sidecars, with skip rules for derived folders.

use regex::Regex;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const AUDIO_EXTENSIONS: &[&str] = &["wav", "flac", "mp3", "ogg", "oga", "opus", "m4a", "aac", "webm", "w4v"];

#[derive(Debug, Clone)]
pub struct ScannedFile {
    pub rel_path: String,
    pub size: u64,
    pub mtime_ms: i64,
}

#[derive(Debug, Clone, Default)]
pub struct ScanResult {
    pub audio: Vec<ScannedFile>,
    /// BirdNET/Raven selection tables (`*.selection.table.txt`).
    pub selection_tables: Vec<ScannedFile>,
    /// Folders skipped as derived data (relative path).
    pub skipped_dirs: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ScanOptions {
    /// Folder names (full match, case-insensitive) treated as derived data: not scanned for audio,
    /// but still searched for sidecars.
    pub derived_dirs: Vec<Regex>,
    pub max_depth: usize,
}

impl Default for ScanOptions {
    fn default() -> Self {
        let pats = [
            r"ergebnis.*", r"results?.*", r"output.*", r"segments?", r"probe", r"clips?", r"excerpts?",
            r"normali[sz]ed.*", r"\.signavis", r"\.git", r"node_modules", r"\.st(folder|versions)", r"db",
        ];
        Self {
            derived_dirs: pats.iter().map(|p| Regex::new(&format!("(?i)^{p}$")).unwrap()).collect(),
            max_depth: 16,
        }
    }
}

fn rel(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

pub fn scan(root: &Path, opts: &ScanOptions) -> ScanResult {
    let mut out = ScanResult::default();
    let mut stack: Vec<(PathBuf, usize, bool)> = vec![(root.to_path_buf(), 0, false)];
    while let Some((dir, depth, derived)) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) => { out.errors.push(format!("{}: {e}", dir.display())); continue; }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(ft) = entry.file_type() else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            if ft.is_dir() {
                if depth + 1 > opts.max_depth { continue; }
                let is_derived = derived || opts.derived_dirs.iter().any(|r| r.is_match(&name));
                if is_derived && !derived { out.skipped_dirs.push(rel(root, &path)); }
                stack.push((path, depth + 1, is_derived));
                continue;
            }
            if !ft.is_file() { continue; }
            let lower = name.to_ascii_lowercase();
            let is_table = lower.ends_with(".selection.table.txt");
            let is_audio = !derived && lower.rsplit_once('.').is_some_and(|(_, e)| AUDIO_EXTENSIONS.contains(&e));
            if !is_table && !is_audio { continue; }
            let Ok(md) = entry.metadata() else { continue };
            let mtime_ms = md.modified().ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as i64);
            let f = ScannedFile { rel_path: rel(root, &path), size: md.len(), mtime_ms };
            if is_table { out.selection_tables.push(f) } else { out.audio.push(f) }
        }
    }
    out.audio.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    out.selection_tables.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    out.skipped_dirs.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_derived_folders_but_keeps_tables() {
        let dir = std::env::temp_dir().join(format!("aw-catalog-scan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for p in ["R1/Woche_1/a.wav", "R1/Woche_1/Probe/a.wav", "R1/Ergebnis/a.BirdNET.selection.table.txt", "R1/notes.txt"] {
            let f = dir.join(p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, b"x").unwrap();
        }
        let r = scan(&dir, &ScanOptions::default());
        assert_eq!(r.audio.iter().map(|f| f.rel_path.as_str()).collect::<Vec<_>>(), ["R1/Woche_1/a.wav"]);
        assert_eq!(r.selection_tables.len(), 1);
        assert_eq!(r.skipped_dirs, ["R1/Ergebnis", "R1/Woche_1/Probe"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
