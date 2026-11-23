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

/// A hash and the file state (size, mtime) it was computed from.
#[derive(Debug, Clone)]
pub struct Hashed { pub id: i64, pub hash: String, pub size: i64, pub mtime_ms: i64 }

fn file_state(p: &Path) -> std::io::Result<(i64, i64)> {
    let md = std::fs::metadata(p)?;
    let mtime = md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as i64);
    Ok((md.len() as i64, mtime))
}

/// Hash one batch from disk (no catalog access, so callers can hold no lock meanwhile).
/// A file that changes while it is read is reported as failed, not hashed.
pub fn hash_batch(base: &Path, kind: HashKind, batch: &[(i64, String)], cancel: &AtomicBool, rep: &mut HashReport) -> Vec<Hashed> {
    let mut done = Vec::with_capacity(batch.len());
    for (id, rel) in batch {
        if cancel.load(Ordering::Relaxed) { rep.cancelled = true; break; }
        let p = base.join(rel);
        let r = file_state(&p).and_then(|before| {
            let h = kind.compute(&p)?;
            if file_state(&p)? != before { return Err(std::io::Error::other("changed while reading")); }
            Ok((h, before))
        });
        match r {
            Ok((hash, (size, mtime_ms))) => done.push(Hashed { id: *id, hash, size, mtime_ms }),
            Err(e) => rep.failed.push(format!("{rel}: {e}")),
        }
    }
    rep.hashed += done.len();
    done
}

/// Store hashes only where the catalog still has the file state they were computed from: an asset
/// that a rescan marked changed meanwhile keeps no hash and is hashed again next time.
pub fn store_checked(cat: &mut Catalog, kind: HashKind, hashes: &[Hashed]) -> Result<usize> {
    let tx = cat.conn.transaction()?;
    let mut n = 0;
    {
        let mut up = tx.prepare(&format!("UPDATE asset SET {} = ?2 WHERE id = ?1 AND size = ?3 AND mtime = ?4", kind.column()))?;
        for h in hashes { n += up.execute(params![h.id, h.hash, h.size, h.mtime_ms])?; }
    }
    tx.commit()?;
    Ok(n)
}

pub const HASH_BATCH: usize = 500;

/// Fill missing hashes of `kind` for a root's present assets. Commits every batch (resumable).
pub fn hash_missing(cat: &mut Catalog, root_id: i64, base: &Path, kind: HashKind, cancel: &AtomicBool,
                    progress: &mut dyn FnMut(usize, usize)) -> Result<HashReport> {
    let todo = hash_todo(cat, root_id, kind)?;
    let mut rep = HashReport::default();
    let batch = if kind == HashKind::Full { 50 } else { HASH_BATCH };
    let mut attempted = 0;
    for chunk in todo.chunks(batch) {
        let failed_before = rep.failed.len();
        let done = hash_batch(base, kind, chunk, cancel, &mut rep);
        store_checked(cat, kind, &done)?;
        // Files actually tried (a cancelled batch stops early), failures included.
        attempted += done.len() + rep.failed.len() - failed_before;
        progress(attempted, todo.len());
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

/// Assets of one size that are gone from their path, indexed by what can identify them again.
#[derive(Default)]
struct Bucket {
    items: Vec<Option<(String, Known)>>,
    by_quick: HashMap<String, Vec<usize>>,
    by_full: HashMap<String, Vec<usize>>,
    /// Neither digest: only size + mtime can match.
    by_mtime: HashMap<i64, Vec<usize>>,
    /// Live assets with a SHA-256 but no quick hash (any file of this size may be one of them).
    full_only: usize,
}

impl Bucket {
    fn add(&mut self, p: String, k: Known) {
        let i = self.items.len();
        if let Some(h) = &k.hash { self.by_quick.entry(h.clone()).or_default().push(i); }
        if let Some(h) = &k.full { self.by_full.entry(h.clone()).or_default().push(i); }
        if k.hash.is_none() && k.full.is_none() { self.by_mtime.entry(k.mtime).or_default().push(i); }
        if k.hash.is_none() && k.full.is_some() { self.full_only += 1; }
        self.items.push(Some((p, k)));
    }

    fn live<'a>(&'a self, v: Option<&'a Vec<usize>>) -> impl Iterator<Item = usize> + 'a {
        v.into_iter().flatten().copied().filter(|&i| self.items[i].is_some())
    }

    /// The gone asset this file is, hashing the file at most once per digest kind:
    /// SHA-256 first (verified), then a quick hash of an asset without SHA-256, then a unique
    /// size + mtime among assets with no digest at all.
    fn find(&self, file: &Path, mtime: i64) -> Option<(usize, &'static str)> {
        let quick = if self.by_quick.is_empty() { None } else { quick_hash(file).ok() };
        let quick_hits: Vec<usize> = quick.as_ref().map(|q| self.live(self.by_quick.get(q)).collect()).unwrap_or_default();
        // Assets that have a SHA-256 and could be this file (same quick hash, or no quick hash).
        let needs_full = quick_hits.iter().any(|&i| self.items[i].as_ref().unwrap().1.full.is_some())
            || self.full_only > 0;
        if needs_full {
            if let Ok(full) = full_hash(file) {
                let q = quick.as_deref();
                if let Some(i) = self.live(self.by_full.get(&full))
                    .find(|&i| { let k = &self.items[i].as_ref().unwrap().1; k.hash.is_none() || k.hash.as_deref() == q }) {
                    return Some((i, "sha256"));
                }
            }
        }
        if let Some(&i) = quick_hits.iter().find(|&&i| self.items[i].as_ref().unwrap().1.full.is_none()) {
            return Some((i, "hash"));
        }
        let same: Vec<usize> = self.live(self.by_mtime.get(&mtime)).collect();
        (same.len() == 1).then(|| (same[0], "size+mtime"))
    }

    fn take(&mut self, i: usize) -> (String, Known) {
        let (p, k) = self.items[i].take().unwrap();
        if k.hash.is_none() && k.full.is_some() { self.full_only -= 1; }
        (p, k)
    }
}

/// The file of `asset_id` changed: forget the clock offset its old header gave. Its time goes back
/// to the import clock (or, after the commit, the recorder's clock periods: returns the device).
fn drop_header_clock(tx: &rusqlite::Transaction, asset_id: i64, profile: Option<&ImportProfile>) -> Result<Option<i64>> {
    let row: Option<(i64, Option<i64>, Option<i64>, Option<i64>)> = tx.query_row(&format!(
        "SELECT r.id, r.device_id, r.header_offset_min, {} FROM recording r WHERE r.asset_id = ?1", crate::WALL),
        [asset_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).optional()?;
    let Some((rec, device, Some(_), wall)) = row else { return Ok(None) };
    tx.execute("UPDATE recording SET header_offset_min = NULL WHERE id = ?1", [rec])?;
    if let (Some(p), Some(w)) = (profile, wall) {
        let clk = p.clock();
        let (utc, off, _) = clk.to_utc(chrono::DateTime::from_timestamp_millis(w).unwrap_or_default().naive_utc());
        tx.execute("UPDATE recording SET start_ms = ?2, local_offset_min = ?3, tz = ?4 WHERE id = ?1", params![rec, utc, off, clk.label()])?;
    }
    Ok(device)
}

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
    let mut reclock: Vec<i64> = Vec::new();
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
                tx.execute("DELETE FROM thumb WHERE recording_id IN (SELECT id FROM recording WHERE asset_id = ?1)", [k.id])?;
                // What the old header gave is gone too: its position, and its clock offset.
                tx.execute("UPDATE recording SET lat = NULL, lon = NULL, alt = NULL, pos_accuracy_m = NULL, pos_origin = NULL
                            WHERE asset_id = ?1 AND pos_origin = 'header'", [k.id])?;
                if let Some(dev) = drop_header_clock(&tx, k.id, profile)? { reclock.push(dev); }
                rep.changed.push(f.rel_path.clone());
            }
            None => candidates.push(f.clone()),
        }
    }
    // What is left in `known` is gone from its old path.
    let mut gone_by_size: HashMap<i64, Bucket> = HashMap::new();
    for (p, k) in known.drain() { gone_by_size.entry(k.size).or_default().add(p, k); }
    for f in candidates {
        let Some(gone) = gone_by_size.get_mut(&(f.size as i64)) else { rep.new_files.push(f); continue };
        let Some((i, by)) = gone.find(&base.join(&f.rel_path), f.mtime_ms) else { rep.new_files.push(f); continue };
        let (old, k) = gone.take(i);
        tx.execute("UPDATE asset SET rel_path = ?2, mtime = ?3, status = 'ok' WHERE id = ?1", params![k.id, f.rel_path, f.mtime_ms])?;
        if let Some(p) = profile {
            if let Some((_, m)) = p.patterns.matches(&f.rel_path) {
                relink_fields(&tx, k.id, &resolve(p, &m), p)?;
            }
        }
        rep.moved.push(Moved { from: old, to: f.rel_path.clone(), by });
    }
    for (p, k) in gone_by_size.into_values().flat_map(|b| b.items.into_iter().flatten()) {
        tx.execute("UPDATE asset SET status = 'missing' WHERE id = ?1", [k.id])?;
        rep.missing.push(p);
    }
    tx.commit()?;
    reclock.sort_unstable();
    reclock.dedup();
    crate::clock::reapply_device_clocks(cat, &reclock)?;
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
    tx.execute("UPDATE recording SET site_id = ?2, device_id = ?3, start_ms = ?4, local_offset_min = ?5, tz = ?6, wall_ms = ?7 WHERE id = ?1",
        params![rec, site, device, utc.map(|u| u.0), utc.map(|u| u.1), utc.map(|_| clk.label()), r.start.map(|t| t.and_utc().timestamp_millis())])?;
    tx.execute("DELETE FROM meta WHERE recording_id = ?1 AND origin = 'pattern'", [rec])?;
    // A value set by hand stays; the path wins over the header (as at import).
    for (k, v) in &r.meta {
        tx.execute("INSERT INTO meta(recording_id, key, value, origin) VALUES (?1, ?2, ?3, 'pattern')
                    ON CONFLICT(recording_id, key) DO UPDATE SET value = excluded.value, origin = 'pattern' WHERE meta.origin != 'manual'",
            params![rec, k, v])?;
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
        "SELECT quick_hash, MAX(size), json_group_array(rel_path),
                COUNT(full_hash) = COUNT(*) AND COUNT(DISTINCT full_hash) = 1 FROM asset
         WHERE quick_hash IS NOT NULL AND status != 'missing' GROUP BY quick_hash HAVING COUNT(*) > 1
         ORDER BY COUNT(*) DESC, MIN(rel_path) LIMIT ?1")?;
    let v = st.query_map([limit as i64], |r| Ok(DuplicateGroup {
        // JSON array: a file name may contain any character, a newline too.
        hash: r.get(0)?, size: r.get(1)?, paths: serde_json::from_str(&r.get::<_, String>(2)?).unwrap_or_default(),
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

    fn tmp(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("aw-hash-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }
    fn plain() -> ImportProfile { ProfileSpec { name: "t".into(), patterns: vec!["{x}.wav".into()], ..Default::default() }.build().unwrap() }
    fn hash_all(cat: &mut Catalog, root: i64, dir: &Path, kinds: &[HashKind]) {
        for k in kinds { hash_missing(cat, root, dir, *k, &AtomicBool::new(false), &mut |_, _| {}).unwrap(); }
    }

    #[test]
    fn every_quick_hash_match_is_checked_with_sha256() {
        let dir = tmp("f");
        let a = noise(1, 300_000);
        let mut b = a.clone();
        b[150_000] ^= 1;   // same quick hash as a, different SHA-256
        write(&dir, "a.wav", &a);
        write(&dir, "b.wav", &b);
        let mut cat = Catalog::open_in_memory().unwrap();
        let root = cat.add_root("r", "referenced", "m", &dir.to_string_lossy()).unwrap();
        import_scanned(&mut cat, root, &scan(&dir, &ScanOptions::default()).audio, &plain()).unwrap();
        hash_all(&mut cat, root, &dir, &[HashKind::Quick, HashKind::Full]);
        std::fs::remove_file(dir.join("a.wav")).unwrap();
        std::fs::rename(dir.join("b.wav"), dir.join("moved-b.wav")).unwrap();
        let rep = reconcile(&mut cat, root, &dir, &scan(&dir, &ScanOptions::default()).audio, None).unwrap();
        assert_eq!(rep.moved.len(), 1);
        assert_eq!((rep.moved[0].from.as_str(), rep.moved[0].by), ("b.wav", "sha256"));
        assert_eq!(rep.missing, vec!["a.wav".to_string()]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_sha256_only_asset_is_not_matched_by_size_and_mtime() {
        let dir = tmp("g");
        write(&dir, "a.wav", &noise(1, 1000));
        let mut cat = Catalog::open_in_memory().unwrap();
        let root = cat.add_root("r", "referenced", "m", &dir.to_string_lossy()).unwrap();
        import_scanned(&mut cat, root, &scan(&dir, &ScanOptions::default()).audio, &plain()).unwrap();
        hash_all(&mut cat, root, &dir, &[HashKind::Full]);
        let mtime = std::fs::metadata(dir.join("a.wav")).unwrap().modified().unwrap();
        std::fs::remove_file(dir.join("a.wav")).unwrap();
        write(&dir, "other.wav", &noise(2, 1000));
        std::fs::File::options().write(true).open(dir.join("other.wav")).unwrap().set_modified(mtime).unwrap();
        let rep = reconcile(&mut cat, root, &dir, &scan(&dir, &ScanOptions::default()).audio, None).unwrap();
        assert!(rep.moved.is_empty(), "different content with the same size and mtime");
        assert_eq!(rep.new_count, 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_changed_file_loses_what_its_old_header_gave() {
        let dir = tmp("h");
        write(&dir, "S1/R1_20240501_120000.wav", &noise(1, 1000));
        let spec = ProfileSpec {
            name: "t".into(), patterns: vec!["S{s}/R{d}_{t:%Y%m%d_%H%M%S}.wav".into()],
            mappings: vec![
                MappingSpec { field: "d".into(), role: "device".into(), ..Default::default() },
                MappingSpec { field: "t".into(), role: "start".into(), ..Default::default() },
            ],
            utc_offset_min: 60, ..Default::default()
        };
        let profile = spec.build().unwrap();
        let mut cat = Catalog::open_in_memory().unwrap();
        let root = cat.add_root("r", "referenced", "m", &dir.to_string_lossy()).unwrap();
        import_scanned(&mut cat, root, &scan(&dir, &ScanOptions::default()).audio, &profile).unwrap();
        let start0: i64 = cat.conn.query_row("SELECT start_ms FROM recording", [], |r| r.get(0)).unwrap();
        // The old header said UTC+02:00 and gave a GPS position.
        let id: i64 = cat.conn.query_row("SELECT id FROM recording", [], |r| r.get(0)).unwrap();
        let info = crate::header::AudioInfo { sample_rate: Some(48000), offset_min: Some(120),
            meta: vec![("guano:Loc Position".into(), "52 13".into())], ..Default::default() };
        crate::header::store_infos(&mut cat, &[(id, Ok(info))]).unwrap();
        assert_eq!(cat.conn.query_row("SELECT start_ms FROM recording", [], |r| r.get::<_, i64>(0)).unwrap(), start0 - 3_600_000);
        cat.conn.execute("INSERT INTO meta(recording_id, key, value, origin) VALUES (?1, 'habitat', 'reed', 'manual')", [id]).unwrap();
        cat.conn.execute("INSERT INTO thumb(recording_id, w, h, max_hz, data, created_ms) VALUES (?1, 1, 1, 1, x'00', 0)", [id]).unwrap();
        write(&dir, "S1/R1_20240501_120000.wav", &noise(2, 2000));   // replaced: no header offset, no GPS
        let rep = reconcile(&mut cat, root, &dir, &scan(&dir, &ScanOptions::default()).audio, Some(&profile)).unwrap();
        assert_eq!(rep.changed.len(), 1);
        let (start, lat, hdr): (i64, Option<f64>, Option<i64>) = cat.conn.query_row(
            "SELECT start_ms, lat, header_offset_min FROM recording", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!((start, lat, hdr), (start0, None, None), "back to the import clock, no header position");
        assert_eq!(cat.conn.query_row("SELECT COUNT(*) FROM thumb", [], |r| r.get::<_, i64>(0)).unwrap(), 0, "old preview gone");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_moved_file_keeps_metadata_set_by_hand() {
        let dir = tmp("i");
        write(&dir, "A/x.wav", &noise(1, 1000));
        let profile = ProfileSpec {
            name: "t".into(), patterns: vec!["{habitat}/{f}.wav".into()],
            mappings: vec![MappingSpec { field: "habitat".into(), role: "meta:habitat".into(), ..Default::default() }],
            ..Default::default()
        }.build().unwrap();
        let mut cat = Catalog::open_in_memory().unwrap();
        let root = cat.add_root("r", "referenced", "m", &dir.to_string_lossy()).unwrap();
        import_scanned(&mut cat, root, &scan(&dir, &ScanOptions::default()).audio, &profile).unwrap();
        cat.conn.execute("UPDATE meta SET value = 'reed bed', origin = 'manual' WHERE key = 'habitat'", []).unwrap();
        std::fs::create_dir_all(dir.join("B")).unwrap();
        std::fs::rename(dir.join("A/x.wav"), dir.join("B/x.wav")).unwrap();
        reconcile(&mut cat, root, &dir, &scan(&dir, &ScanOptions::default()).audio, Some(&profile)).unwrap();
        let (v, o): (String, String) = cat.conn.query_row("SELECT value, origin FROM meta WHERE key = 'habitat'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((v.as_str(), o.as_str()), ("reed bed", "manual"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn duplicate_paths_may_contain_newlines() {
        let mut cat = Catalog::open_in_memory().unwrap();
        let root = cat.add_root("r", "referenced", "m", "/x").unwrap();
        for p in ["survey\nnight.wav", "b.wav"] {
            cat.conn.execute("INSERT INTO asset(uid, root_id, rel_path, size, mtime, quick_hash) VALUES (?1, ?2, ?3, 1, 0, 'q')",
                params![crate::new_uid(), root, p]).unwrap();
        }
        let (_, g) = duplicates(&cat, 10).unwrap();
        assert_eq!(g[0].paths.len(), 2);
        assert!(g[0].paths.contains(&"survey\nnight.wav".to_string()));
    }

    #[test]
    fn a_cancelled_run_reports_only_attempted_files() {
        let dir = tmp("j");
        for i in 0..3 { write(&dir, &format!("{i}.wav"), &noise(i, 100)); }
        let mut cat = Catalog::open_in_memory().unwrap();
        let root = cat.add_root("r", "referenced", "m", &dir.to_string_lossy()).unwrap();
        import_scanned(&mut cat, root, &scan(&dir, &ScanOptions::default()).audio, &plain()).unwrap();
        let mut last = (usize::MAX, 0);
        hash_missing(&mut cat, root, &dir, HashKind::Quick, &AtomicBool::new(true), &mut |d, t| last = (d, t)).unwrap();
        assert_eq!(last, (0, 3));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_hash_of_an_older_file_state_is_not_stored() {
        let dir = tmp("k");
        write(&dir, "a.wav", &noise(1, 1000));
        let mut cat = Catalog::open_in_memory().unwrap();
        let root = cat.add_root("r", "referenced", "m", &dir.to_string_lossy()).unwrap();
        import_scanned(&mut cat, root, &scan(&dir, &ScanOptions::default()).audio, &plain()).unwrap();
        let todo = hash_todo(&cat, root, HashKind::Quick).unwrap();
        let mut rep = HashReport::default();
        let done = hash_batch(&dir, HashKind::Quick, &todo, &AtomicBool::new(false), &mut rep);
        // Meanwhile a rescan saw new content (other size): the old hash must not be stored.
        cat.conn.execute("UPDATE asset SET size = size + 1, quick_hash = NULL, status = 'changed'", []).unwrap();
        assert_eq!(store_checked(&mut cat, HashKind::Quick, &done).unwrap(), 0);
        let h: Option<String> = cat.conn.query_row("SELECT quick_hash FROM asset", [], |r| r.get(0)).unwrap();
        assert_eq!(h, None);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
