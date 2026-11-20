//! Content identity of audio files: quick hash, re-linking renamed/moved files, duplicates.
//!
//! Quick hash = xxh3-128 over (size, first 64 KiB, last 64 KiB). Reads ≤ 128 KiB per file, so it
//! is cheap even for 100 k files on a USB disk, and recordings of the same length differ in their
//! audio bytes. It finds candidates fast; it is not a cryptographic checksum.
//! Full hash = SHA-256 over the whole file ('sha256:<hex>'): confirms a re-link or a duplicate,
//! and gives checksums for archiving/publication (sha256sum, BagIt). Reads every byte, so it runs
//! as a separate, resumable background step.

use crate::{Catalog, ImportProfile, Result, resolve, scan::ScannedFile};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use xxhash_rust::xxh3::Xxh3;

const CHUNK: u64 = 64 * 1024;

pub fn quick_hash(path: &Path) -> std::io::Result<String> {
    let mut f = File::open(path)?;
    let size = f.metadata()?.len();
    let mut h = Xxh3::new();
    h.update(&size.to_le_bytes());
    let mut buf = vec![0u8; CHUNK as usize];
    let n = read_full(&mut f, &mut buf)?;
    h.update(&buf[..n]);
    if size > 2 * CHUNK {
        f.seek(SeekFrom::Start(size - CHUNK))?;
        let n = read_full(&mut f, &mut buf)?;
        h.update(&buf[..n]);
    } else if size > CHUNK {
        let n = read_full(&mut f, &mut buf)?;
        h.update(&buf[..n]);
    }
    Ok(format!("{:032x}", h.digest128()))
}

fn read_full(f: &mut File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match f.read(&mut buf[n..])? { 0 => break, k => n += k }
    }
    Ok(n)
}

pub fn full_hash(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    let mut f = File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        match f.read(&mut buf)? { 0 => break, n => h.update(&buf[..n]) }
    }
    Ok(format!("sha256:{:x}", h.finalize()))
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HashKind { Quick, Full }

impl HashKind {
    fn column(self) -> &'static str { match self { HashKind::Quick => "quick_hash", HashKind::Full => "full_hash" } }
    pub fn compute(self, path: &Path) -> std::io::Result<String> {
        match self { HashKind::Quick => quick_hash(path), HashKind::Full => full_hash(path) }
    }
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HashReport { pub hashed: usize, pub failed: Vec<String>, pub cancelled: bool }

/// Present assets of a root without a hash of `kind`: (asset id, relative path).
pub fn hash_todo(cat: &Catalog, root_id: i64, kind: HashKind) -> Result<Vec<(i64, String)>> {
    let mut st = cat.conn.prepare(&format!(
        "SELECT id, rel_path FROM asset WHERE root_id = ?1 AND {} IS NULL AND status != 'missing' ORDER BY rel_path", kind.column()))?;
    let v = st.query_map([root_id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<std::result::Result<_, _>>()?;
    Ok(v)
}

pub fn store_hashes(cat: &mut Catalog, kind: HashKind, hashes: &[(i64, String)]) -> Result<()> {
    let tx = cat.conn.transaction()?;
    {
        let mut up = tx.prepare(&format!("UPDATE asset SET {} = ?2 WHERE id = ?1", kind.column()))?;
        for (id, h) in hashes { up.execute(params![id, h])?; }
    }
    tx.commit()?;
    Ok(())
}

/// Hash one batch from disk (no catalog access, so callers can hold no lock meanwhile).
pub fn hash_batch(base: &Path, kind: HashKind, batch: &[(i64, String)], cancel: &AtomicBool, rep: &mut HashReport) -> Vec<(i64, String)> {
    let mut done = Vec::with_capacity(batch.len());
    for (id, rel) in batch {
        if cancel.load(Ordering::Relaxed) { rep.cancelled = true; break; }
        match kind.compute(&base.join(rel)) {
            Ok(h) => done.push((*id, h)),
            Err(e) => rep.failed.push(format!("{rel}: {e}")),
        }
    }
    rep.hashed += done.len();
    done
}

pub const HASH_BATCH: usize = 500;

/// Fill missing hashes of `kind` for a root's present assets. Commits every batch (resumable).
pub fn hash_missing(cat: &mut Catalog, root_id: i64, base: &Path, kind: HashKind, cancel: &AtomicBool,
                    progress: &mut dyn FnMut(usize, usize)) -> Result<HashReport> {
    let todo = hash_todo(cat, root_id, kind)?;
    let mut rep = HashReport::default();
    let batch = if kind == HashKind::Full { 50 } else { HASH_BATCH };
    for (i, chunk) in todo.chunks(batch).enumerate() {
        let done = hash_batch(base, kind, chunk, cancel, &mut rep);
        store_hashes(cat, kind, &done)?;
        progress(i * batch + chunk.len(), todo.len());
        if rep.cancelled { break; }
    }
    Ok(rep)
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Moved { pub from: String, pub to: String, /** hash | sha256 | size+mtime */ pub by: &'static str }

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileReport {
    pub unchanged: usize,
    /// Same path, different size or mtime (content changed: hash cleared).
    pub changed: Vec<String>,
    /// Renamed/moved: the asset (and its recording, labels, detections) follows the file.
    pub moved: Vec<Moved>,
    /// Gone and not found elsewhere.
    pub missing: Vec<String>,
    /// Files that are new to the catalog (to be imported).
    #[serde(skip)]
    pub new_files: Vec<ScannedFile>,
    pub new_count: usize,
}

struct Known { id: i64, size: i64, mtime: i64, hash: Option<String>, full: Option<String>, status: String }

/// Compare a fresh scan of a root with the catalog. Renamed or moved files are matched by quick
/// hash (or, for assets not hashed yet, by unique size + mtime) and re-linked instead of being
/// imported again. With `profile`, the fields of a moved file are re-derived from its new path.
pub fn reconcile(cat: &mut Catalog, root_id: i64, base: &Path, scanned: &[ScannedFile],
                 profile: Option<&ImportProfile>) -> Result<ReconcileReport> {
    let mut known: HashMap<String, Known> = {
        let mut st = cat.conn.prepare("SELECT rel_path, id, size, mtime, quick_hash, full_hash, status FROM asset WHERE root_id = ?1")?;
        st.query_map([root_id], |r| Ok((r.get::<_, String>(0)?, Known {
            id: r.get(1)?, size: r.get(2)?, mtime: r.get(3)?, hash: r.get(4)?, full: r.get(5)?, status: r.get(6)?,
        })))?.collect::<std::result::Result<_, _>>()?
    };
    let mut rep = ReconcileReport::default();
    let tx = cat.conn.transaction()?;
    let mut candidates = Vec::new();
    for f in scanned {
        match known.remove(&f.rel_path) {
            Some(k) if k.size == f.size as i64 && k.mtime == f.mtime_ms => {
                if k.status != "ok" { tx.execute("UPDATE asset SET status = 'ok' WHERE id = ?1", [k.id])?; }
                rep.unchanged += 1;
            }
            Some(k) => {
                tx.execute("UPDATE asset SET size = ?2, mtime = ?3, quick_hash = NULL, full_hash = NULL, status = 'changed' WHERE id = ?1",
                    params![k.id, f.size as i64, f.mtime_ms])?;
                // Content changed: read the header again.
                tx.execute("UPDATE recording SET sample_rate = NULL, channels = NULL, duration_s = NULL WHERE asset_id = ?1", [k.id])?;
                tx.execute("DELETE FROM meta WHERE origin = 'header' AND recording_id IN (SELECT id FROM recording WHERE asset_id = ?1)", [k.id])?;
                rep.changed.push(f.rel_path.clone());
            }
            None => candidates.push(f.clone()),
        }
    }
    // What is left in `known` is gone from its old path.
    let mut gone_by_size: HashMap<i64, Vec<(String, Known)>> = HashMap::new();
    for (p, k) in known.drain() { gone_by_size.entry(k.size).or_default().push((p, k)); }
    for f in candidates {
        let Some(gone) = gone_by_size.get_mut(&(f.size as i64)) else { rep.new_files.push(f); continue };
        let mut hit = None;
        if gone.iter().any(|(_, k)| k.hash.is_some()) {
            if let Ok(h) = quick_hash(&base.join(&f.rel_path)) {
                hit = gone.iter().position(|(_, k)| k.hash.as_deref() == Some(h.as_str())).map(|i| (i, "hash"));
                // Confirm with SHA-256 when the old file had one (reads the candidate once).
                if let Some((i, _)) = hit {
                    if let Some(old) = gone[i].1.full.clone() {
                        match full_hash(&base.join(&f.rel_path)) {
                            Ok(new) if new == old => hit = Some((i, "sha256")),
                            _ => hit = None,
                        }
                    }
                }
            }
        }
        if hit.is_none() {
            // Not hashed yet: a rename keeps size and mtime; accept only a unique match.
            let same: Vec<usize> = gone.iter().enumerate()
                .filter(|(_, (_, k))| k.hash.is_none() && k.mtime == f.mtime_ms).map(|(i, _)| i).collect();
            if same.len() == 1 { hit = Some((same[0], "size+mtime")); }
        }
        let Some((i, by)) = hit else { rep.new_files.push(f); continue };
        let (old, k) = gone.swap_remove(i);
        tx.execute("UPDATE asset SET rel_path = ?2, mtime = ?3, status = 'ok' WHERE id = ?1", params![k.id, f.rel_path, f.mtime_ms])?;
        if let Some(p) = profile {
            if let Some((_, m)) = p.patterns.matches(&f.rel_path) {
                relink_fields(&tx, k.id, &resolve(p, &m), p)?;
            }
        }
        rep.moved.push(Moved { from: old, to: f.rel_path.clone(), by });
    }
    for (p, k) in gone_by_size.into_values().flatten() {
        tx.execute("UPDATE asset SET status = 'missing' WHERE id = ?1", [k.id])?;
        rep.missing.push(p);
    }
    tx.commit()?;
    rep.new_count = rep.new_files.len();
    rep.missing.sort();
    rep.changed.sort();
    Ok(rep)
}

/// Re-derive site/device/start/metadata of the recording of `asset_id` from a new path.
fn relink_fields(tx: &rusqlite::Transaction, asset_id: i64, r: &crate::Resolved, p: &ImportProfile) -> Result<()> {
    let rec: Option<i64> = tx.query_row("SELECT id FROM recording WHERE asset_id = ?1", [asset_id], |r| r.get(0)).optional()?;
    let Some(rec) = rec else { return Ok(()) };
    let named = |table: &str, name: &Option<String>| -> Result<Option<i64>> {
        let Some(n) = name else { return Ok(None) };
        tx.execute(&format!("INSERT OR IGNORE INTO {table}(uid, name) VALUES (?1, ?2)"), params![crate::new_uid(), n])?;
        Ok(Some(tx.query_row(&format!("SELECT id FROM {table} WHERE name = ?1"), [n], |r| r.get(0))?))
    };
    let (site, device) = (named("site", &r.site)?, named("device", &r.device)?);
    let clk = p.clock();
    let utc = r.start.map(|t| clk.to_utc(t));
    tx.execute("UPDATE recording SET site_id = ?2, device_id = ?3, start_ms = ?4, local_offset_min = ?5, tz = ?6 WHERE id = ?1",
        params![rec, site, device, utc.map(|u| u.0), utc.map(|u| u.1), utc.map(|_| clk.label())])?;
    tx.execute("DELETE FROM meta WHERE recording_id = ?1 AND origin = 'pattern'", [rec])?;
    for (k, v) in &r.meta {
        tx.execute("INSERT OR REPLACE INTO meta(recording_id, key, value, origin) VALUES (?1, ?2, ?3, 'pattern')", params![rec, k, v])?;
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    pub hash: String, pub size: i64, pub paths: Vec<String>,
    /// All members have the same SHA-256 (else: same quick hash only, not yet confirmed).
    pub verified: bool,
}

/// Files with identical quick hash (same content), largest groups first.
pub fn duplicates(cat: &Catalog, limit: usize) -> Result<(usize, Vec<DuplicateGroup>)> {
    let total: i64 = cat.conn.query_row(
        "SELECT COUNT(*) FROM (SELECT 1 FROM asset WHERE quick_hash IS NOT NULL AND status != 'missing' GROUP BY quick_hash HAVING COUNT(*) > 1)",
        [], |r| r.get(0))?;
    let mut st = cat.conn.prepare(
        "SELECT quick_hash, MAX(size), GROUP_CONCAT(rel_path, char(10)),
                COUNT(full_hash) = COUNT(*) AND COUNT(DISTINCT full_hash) = 1 FROM asset
         WHERE quick_hash IS NOT NULL AND status != 'missing' GROUP BY quick_hash HAVING COUNT(*) > 1
         ORDER BY COUNT(*) DESC, MIN(rel_path) LIMIT ?1")?;
    let v = st.query_map([limit as i64], |r| Ok(DuplicateGroup {
        hash: r.get(0)?, size: r.get(1)?, paths: r.get::<_, String>(2)?.split('\n').map(String::from).collect(),
        verified: r.get(3)?,
    }))?.collect::<std::result::Result<_, _>>()?;
    Ok((total as usize, v))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{import_scanned, profile_spec::{MappingSpec, ProfileSpec}, scan::{ScanOptions, scan}};

    fn write(dir: &Path, rel: &str, bytes: &[u8]) {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, bytes).unwrap();
    }

    fn noise(seed: u64, len: usize) -> Vec<u8> {
        let mut x = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (0..len).map(|_| { x ^= x << 13; x ^= x >> 7; x ^= x << 17; x as u8 }).collect()
    }

    #[test]
    fn quick_hash_sees_head_and_tail_and_size() {
        let dir = std::env::temp_dir().join(format!("aw-hash-a-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let a = noise(1, 300_000);
        let mut tail = a.clone();
        *tail.last_mut().unwrap() ^= 1;
        let mut middle = a.clone();
        middle[150_000] ^= 1;
        write(&dir, "a.wav", &a);
        write(&dir, "tail.wav", &tail);
        write(&dir, "mid.wav", &middle);
        write(&dir, "small.wav", b"abc");
        let h = |n: &str| quick_hash(&dir.join(n)).unwrap();
        assert_ne!(h("a.wav"), h("tail.wav"));
        assert_eq!(h("a.wav"), h("mid.wav"), "middle bytes are not read (documented limit)");
        assert_eq!(h("small.wav").len(), 32);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rename_and_move_keep_the_recording_and_update_fields() {
        let dir = std::env::temp_dir().join(format!("aw-hash-b-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write(&dir, "S1/R1_20240501_040000.wav", &noise(1, 200_000));
        write(&dir, "S1/R1_20240501_050000.wav", &noise(2, 200_000));
        write(&dir, "S1/R1_20240501_060000.wav", &noise(3, 200_000));
        let spec = ProfileSpec {
            name: "t".into(), patterns: vec!["S{s}/R{d}_{t:%Y%m%d_%H%M%S}.wav".into()],
            mappings: vec![
                MappingSpec { field: "s".into(), role: "site".into(), format: Some("Site {}".into()), ..Default::default() },
                MappingSpec { field: "d".into(), role: "device".into(), ..Default::default() },
                MappingSpec { field: "t".into(), role: "start".into(), ..Default::default() },
            ],
            ..Default::default()
        };
        let profile = spec.build().unwrap();
        let mut cat = Catalog::open_in_memory().unwrap();
        let root = cat.add_root("r", "referenced", "m", &dir.to_string_lossy()).unwrap();
        import_scanned(&mut cat, root, &scan(&dir, &ScanOptions::default()).audio, &profile).unwrap();
        // A label on the first recording must follow the file.
        cat.conn.execute("INSERT INTO label_set(uid, name, created_at, updated_at) VALUES ('ls', 'x', 0, 0)", []).unwrap();
        cat.conn.execute("INSERT INTO label(uid, label_set_id, recording_id, t0, t1, class, created_at, updated_at)
            SELECT 'l1', 1, r.id, 0, 5, 'owl', 0, 0 FROM recording r JOIN asset a ON a.id = r.asset_id
            WHERE a.rel_path = 'S1/R1_20240501_040000.wav'", []).unwrap();
        let rep = hash_missing(&mut cat, root, &dir, HashKind::Quick, &AtomicBool::new(false), &mut |_, _| {}).unwrap();
        assert_eq!(rep.hashed, 3);

        // Hashed file moved to another site folder; second one renamed before hashing would also work
        // (covered below); third one deleted; one new file; one duplicate copy.
        std::fs::create_dir_all(dir.join("S2")).unwrap();
        std::fs::rename(dir.join("S1/R1_20240501_040000.wav"), dir.join("S2/R1_20240501_040000.wav")).unwrap();
        std::fs::remove_file(dir.join("S1/R1_20240501_060000.wav")).unwrap();
        write(&dir, "S1/R1_20240502_040000.wav", &noise(9, 200_000));
        std::fs::copy(dir.join("S1/R1_20240501_050000.wav"), dir.join("S1/copy.wav")).unwrap();

        let rep = reconcile(&mut cat, root, &dir, &scan(&dir, &ScanOptions::default()).audio, Some(&profile)).unwrap();
        assert_eq!(rep.unchanged, 1);
        assert_eq!(rep.moved.len(), 1);
        assert_eq!((rep.moved[0].to.as_str(), rep.moved[0].by), ("S2/R1_20240501_040000.wav", "hash"));
        assert_eq!(rep.missing, vec!["S1/R1_20240501_060000.wav".to_string()]);
        assert_eq!(rep.new_count, 2, "new recording + copy (same size, different path, original still present)");
        let (site, labels): (String, i64) = cat.conn.query_row(
            "SELECT s.name, (SELECT COUNT(*) FROM label l WHERE l.recording_id = r.id) FROM asset a
             JOIN recording r ON r.asset_id = a.id JOIN site s ON s.id = r.site_id WHERE a.rel_path = 'S2/R1_20240501_040000.wav'",
            [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((site.as_str(), labels), ("Site 2", 1));

        import_scanned(&mut cat, root, &rep.new_files, &profile).unwrap();
        hash_missing(&mut cat, root, &dir, HashKind::Quick, &AtomicBool::new(false), &mut |_, _| {}).unwrap();
        let (n, groups) = duplicates(&cat, 10).unwrap();
        assert_eq!(n, 1);
        assert_eq!(groups[0].paths, vec!["S1/R1_20240501_050000.wav", "S1/copy.wav"]);
        assert!(!groups[0].verified);
        hash_missing(&mut cat, root, &dir, HashKind::Full, &AtomicBool::new(false), &mut |_, _| {}).unwrap();
        assert!(duplicates(&cat, 10).unwrap().1[0].verified);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn sha256_rejects_a_quick_hash_collision() {
        let dir = std::env::temp_dir().join(format!("aw-hash-d-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let a = noise(1, 300_000);
        let mut b = a.clone();
        b[150_000] ^= 1;   // same size, head and tail: equal quick hash
        write(&dir, "a.wav", &a);
        let mut cat = Catalog::open_in_memory().unwrap();
        let root = cat.add_root("r", "referenced", "m", &dir.to_string_lossy()).unwrap();
        let profile = ProfileSpec { name: "t".into(), patterns: vec!["{x}.wav".into()], ..Default::default() }.build().unwrap();
        import_scanned(&mut cat, root, &scan(&dir, &ScanOptions::default()).audio, &profile).unwrap();
        for k in [HashKind::Quick, HashKind::Full] {
            hash_missing(&mut cat, root, &dir, k, &AtomicBool::new(false), &mut |_, _| {}).unwrap();
        }
        assert!(aw_full(&cat).starts_with("sha256:"));
        std::fs::remove_file(dir.join("a.wav")).unwrap();
        write(&dir, "b.wav", &b);
        let rep = reconcile(&mut cat, root, &dir, &scan(&dir, &ScanOptions::default()).audio, None).unwrap();
        assert!(rep.moved.is_empty(), "different content must not be re-linked");
        assert_eq!((rep.missing.len(), rep.new_count), (1, 1));
        // Same content renamed: confirmed by SHA-256.
        std::fs::remove_file(dir.join("b.wav")).unwrap();
        write(&dir, "c.wav", &a);
        let rep = reconcile(&mut cat, root, &dir, &scan(&dir, &ScanOptions::default()).audio, None).unwrap();
        assert_eq!(rep.moved[0].by, "sha256");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn aw_full(cat: &Catalog) -> String {
        cat.conn.query_row("SELECT full_hash FROM asset LIMIT 1", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn full_hash_matches_sha256sum() {
        let dir = std::env::temp_dir().join(format!("aw-hash-e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write(&dir, "x.wav", b"abc");
        assert_eq!(full_hash(&dir.join("x.wav")).unwrap(),
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn unhashed_rename_matches_by_unique_size_and_mtime() {
        let dir = std::env::temp_dir().join(format!("aw-hash-c-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write(&dir, "a.wav", &noise(1, 1000));
        let mut cat = Catalog::open_in_memory().unwrap();
        let root = cat.add_root("r", "referenced", "m", &dir.to_string_lossy()).unwrap();
        let profile = ProfileSpec { name: "t".into(), patterns: vec!["{x}.wav".into()], ..Default::default() }.build().unwrap();
        import_scanned(&mut cat, root, &scan(&dir, &ScanOptions::default()).audio, &profile).unwrap();
        std::fs::rename(dir.join("a.wav"), dir.join("b.wav")).unwrap();
        let rep = reconcile(&mut cat, root, &dir, &scan(&dir, &ScanOptions::default()).audio, None).unwrap();
        assert_eq!(rep.moved.len(), 1);
        assert_eq!(rep.moved[0].by, "size+mtime");
        assert_eq!(rep.new_count, 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
