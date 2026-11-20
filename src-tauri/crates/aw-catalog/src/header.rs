//! Audio headers: duration, sample rate, channels (all formats via symphonia, no decoding), plus
//! metadata embedded in WAV files: GUANO (bat/bird recorders) and the INFO comment (AudioMoth).
//! Header values never override what the import profile derived from the path.

use crate::{Catalog, Result};
use rusqlite::params;
use serde::Serialize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInfo {
    pub duration_s: Option<f64>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
    /// (key, value) from GUANO / INFO chunks, keys like "guano:Make", "comment".
    pub meta: Vec<(String, String)>,
}

pub fn read_info(path: &Path) -> std::io::Result<AudioInfo> {
    use symphonia::core::{formats::FormatOptions, io::MediaSourceStream, meta::MetadataOptions, probe::Hint};
    let file = File::open(path)?;
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) { hint.with_extension(ext); }
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    let mut info = AudioInfo::default();
    if let Some(t) = probed.format.default_track() {
        let p = &t.codec_params;
        info.sample_rate = p.sample_rate;
        info.channels = p.channels.map(|c| c.count() as u32);
        if let (Some(n), Some(sr)) = (p.n_frames, p.sample_rate) {
            if sr > 0 { info.duration_s = Some(n as f64 / sr as f64); }
        }
    }
    let lower = path.to_string_lossy().to_lowercase();
    if lower.ends_with(".wav") || lower.ends_with(".w4v") {
        info.meta = wav_chunks(path).unwrap_or_default();
    }
    Ok(info)
}

/// GUANO and INFO/ICMT from a RIFF file; walks the chunk list with seeks (data is skipped).
fn wav_chunks(path: &Path) -> std::io::Result<Vec<(String, String)>> {
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();
    let mut head = [0u8; 12];
    f.read_exact(&mut head)?;
    if &head[0..4] != b"RIFF" || &head[8..12] != b"WAVE" { return Ok(vec![]); }
    let mut out = Vec::new();
    let mut pos = 12u64;
    while pos + 8 <= len {
        f.seek(SeekFrom::Start(pos))?;
        let mut h = [0u8; 8];
        if f.read_exact(&mut h).is_err() { break; }
        let size = u32::from_le_bytes([h[4], h[5], h[6], h[7]]) as u64;
        let id = &h[0..4];
        let small = size <= 64 * 1024;
        if id == b"guan" && small {
            let mut b = vec![0u8; size as usize];
            f.read_exact(&mut b)?;
            for line in String::from_utf8_lossy(&b).lines() {
                if let Some((k, v)) = line.split_once(':') {
                    let (k, v) = (k.trim(), v.trim());
                    if !k.is_empty() && !v.is_empty() && k != "GUANO|Version" { out.push((format!("guano:{k}"), v.to_string())); }
                }
            }
        } else if id == b"LIST" && small {
            let mut b = vec![0u8; size as usize];
            f.read_exact(&mut b)?;
            if b.starts_with(b"INFO") {
                let mut i = 4;
                while i + 8 <= b.len() {
                    let sub = &b[i..i + 4];
                    let n = u32::from_le_bytes([b[i + 4], b[i + 5], b[i + 6], b[i + 7]]) as usize;
                    let end = (i + 8 + n).min(b.len());
                    let text = String::from_utf8_lossy(&b[i + 8..end]).trim_end_matches('\0').trim().to_string();
                    let key = match sub { b"ICMT" => Some("comment"), b"IART" => Some("artist"), b"INAM" => Some("title"), _ => None };
                    if let Some(k) = key { if !text.is_empty() { out.push((k.to_string(), text)); } }
                    i = end + (n & 1);
                }
            }
        }
        pos += 8 + size + (size & 1);
    }
    Ok(out)
}

/// Recordings of a root whose header has not been read yet: (recording id, relative path).
pub fn header_todo(cat: &Catalog, root_id: i64) -> Result<Vec<(i64, String)>> {
    let mut st = cat.conn.prepare(
        "SELECT r.id, a.rel_path FROM recording r JOIN asset a ON a.id = r.asset_id
         WHERE a.root_id = ?1 AND r.sample_rate IS NULL AND a.status != 'missing'
           AND NOT EXISTS (SELECT 1 FROM meta m WHERE m.recording_id = r.id AND m.key = 'header:error')
         ORDER BY a.rel_path")?;
    let v = st.query_map([root_id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<std::result::Result<_, _>>()?;
    Ok(v)
}

/// Read a batch from disk (no catalog access).
pub fn read_batch(base: &Path, batch: &[(i64, String)], cancel: &AtomicBool) -> (Vec<(i64, std::result::Result<AudioInfo, String>)>, bool) {
    let mut out = Vec::with_capacity(batch.len());
    for (id, rel) in batch {
        if cancel.load(Ordering::Relaxed) { return (out, true); }
        out.push((*id, read_info(&base.join(rel)).map_err(|e| e.to_string())));
    }
    (out, false)
}

/// Store header values. Errors are kept as metadata `header:error` (so they are not retried forever).
pub fn store_infos(cat: &mut Catalog, infos: &[(i64, std::result::Result<AudioInfo, String>)]) -> Result<()> {
    let tx = cat.conn.transaction()?;
    {
        let mut up = tx.prepare("UPDATE recording SET duration_s = ?2, sample_rate = ?3, channels = ?4 WHERE id = ?1")?;
        // Header metadata never replaces values from the path pattern or manual edits.
        let mut meta = tx.prepare("INSERT OR IGNORE INTO meta(recording_id, key, value, origin) VALUES (?1, ?2, ?3, 'header')")?;
        for (id, r) in infos {
            match r {
                Ok(i) => {
                    up.execute(params![id, i.duration_s, i.sample_rate.unwrap_or(0), i.channels])?;
                    for (k, v) in &i.meta { meta.execute(params![id, k, v])?; }
                }
                Err(e) => { meta.execute(params![id, "header:error", e])?; }
            }
        }
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal PCM WAV with optional extra chunks after the data.
    fn wav(sr: u32, ch: u16, frames: u32, extra: &[(&[u8; 4], Vec<u8>)]) -> Vec<u8> {
        let data_len = frames * ch as u32 * 2;
        let mut body = Vec::new();
        body.extend(b"WAVE");
        body.extend(b"fmt ");
        body.extend(16u32.to_le_bytes());
        body.extend(1u16.to_le_bytes());
        body.extend(ch.to_le_bytes());
        body.extend(sr.to_le_bytes());
        body.extend((sr * ch as u32 * 2).to_le_bytes());
        body.extend((ch * 2).to_le_bytes());
        body.extend(16u16.to_le_bytes());
        body.extend(b"data");
        body.extend(data_len.to_le_bytes());
        body.extend(vec![0u8; data_len as usize]);
        for (id, b) in extra {
            body.extend(*id);
            body.extend((b.len() as u32).to_le_bytes());
            body.extend(b);
            if b.len() % 2 == 1 { body.push(0); }
        }
        let mut out = b"RIFF".to_vec();
        out.extend((body.len() as u32).to_le_bytes());
        out.extend(body);
        out
    }

    #[test]
    fn reads_format_guano_and_comment() {
        let dir = std::env::temp_dir().join(format!("aw-header-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut info = b"INFO".to_vec();
        let c = b"Recorded at 17:00:01 by AudioMoth 24F3190361DA5D5C\0";
        info.extend(b"ICMT");
        info.extend((c.len() as u32).to_le_bytes());
        info.extend(c);
        let guano = b"GUANO|Version:1.0\nMake:Wildlife Acoustics\nLoc Position:52.1 10.5\n".to_vec();
        let p = dir.join("a.wav");
        std::fs::write(&p, wav(48_000, 1, 96_000, &[(b"LIST", info), (b"guan", guano)])).unwrap();
        let i = read_info(&p).unwrap();
        assert_eq!((i.sample_rate, i.channels), (Some(48_000), Some(1)));
        assert!((i.duration_s.unwrap() - 2.0).abs() < 1e-9);
        assert!(i.meta.contains(&("guano:Make".into(), "Wildlife Acoustics".into())));
        assert!(i.meta.contains(&("guano:Loc Position".into(), "52.1 10.5".into())));
        assert!(i.meta.iter().any(|(k, v)| k == "comment" && v.contains("AudioMoth")));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn job_fills_recordings_and_marks_unreadable_files() {
        use crate::{import_scanned, profile_spec::ProfileSpec, scan::{ScanOptions, scan}};
        let dir = std::env::temp_dir().join(format!("aw-header-job-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("good.wav"), wav(32_000, 2, 32_000, &[])).unwrap();
        std::fs::write(dir.join("broken.wav"), b"not audio").unwrap();
        let mut cat = Catalog::open_in_memory().unwrap();
        let root = cat.add_root("r", "referenced", "m", &dir.to_string_lossy()).unwrap();
        let prof = ProfileSpec { name: "t".into(), patterns: vec!["{x}.wav".into()], ..Default::default() }.build().unwrap();
        import_scanned(&mut cat, root, &scan(&dir, &ScanOptions::default()).audio, &prof).unwrap();
        let todo = header_todo(&cat, root).unwrap();
        assert_eq!(todo.len(), 2);
        let (infos, _) = read_batch(&dir, &todo, &AtomicBool::new(false));
        store_infos(&mut cat, &infos).unwrap();
        assert!(header_todo(&cat, root).unwrap().is_empty(), "errors are not retried");
        let (sr, ch, d): (i64, i64, f64) = cat.conn.query_row(
            "SELECT sample_rate, channels, duration_s FROM recording r JOIN asset a ON a.id = r.asset_id WHERE a.rel_path = 'good.wav'",
            [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!((sr, ch, d), (32_000, 2, 1.0));
        assert_eq!(crate::count(&cat, "SELECT COUNT(*) FROM meta WHERE key = 'header:error'").unwrap(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
