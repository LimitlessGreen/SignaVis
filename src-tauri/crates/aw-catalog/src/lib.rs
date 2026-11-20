//! SignaVis project catalog (SQLite, `.signavis/catalog.sqlite`).
//! Plan: SignaVis-lab/plans/data-management-plan.md. Phase 0: schema, path templates, referenced
//! import, BirdNET selection tables as runs.

pub mod pattern;
pub mod scan;

use chrono::{NaiveDateTime, TimeZone, Utc};
use pattern::PatternSet;
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::HashMap;
use std::path::Path;

pub const SCHEMA_VERSION: &str = "1";
const SCHEMA: &str = include_str!("schema.sql");

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

pub fn now_ms() -> i64 { Utc::now().timestamp_millis() }
pub fn new_uid() -> String { uuid::Uuid::now_v7().to_string() }

pub struct Catalog { pub conn: Connection }

impl Catalog {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() { std::fs::create_dir_all(dir)?; }
        Self::init(Connection::open(path)?)
    }
    pub fn open_in_memory() -> Result<Self> { Self::init(Connection::open_in_memory()?) }

    fn init(conn: Connection) -> Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.execute_batch(SCHEMA)?;
        conn.execute(
            "INSERT OR IGNORE INTO catalog_info(key, value) VALUES ('schema', ?1)", [SCHEMA_VERSION])?;
        Ok(Self { conn })
    }

    pub fn add_root(&self, name: &str, kind: &str, machine: &str, abs_path: &str) -> Result<i64> {
        self.conn.execute("INSERT OR IGNORE INTO root(uid, name, kind) VALUES (?1, ?2, ?3)",
            params![new_uid(), name, kind])?;
        let id: i64 = self.conn.query_row("SELECT id FROM root WHERE name = ?1", [name], |r| r.get(0))?;
        self.conn.execute("INSERT OR REPLACE INTO root_location(root_id, machine, path) VALUES (?1, ?2, ?3)",
            params![id, machine, abs_path])?;
        Ok(id)
    }
}

/// How pattern fields map to catalog entities.
#[derive(Debug, Clone)]
pub struct ImportOptions {
    pub patterns: PatternSet,
    /// Field naming the site / device; their values become `site` / `device` rows ("prefix + value").
    pub site_field: Option<(String, String)>,
    pub device_field: Option<(String, String)>,
    /// Offset of the recorder clock to UTC in minutes (spike; later an IANA zone).
    pub utc_offset_min: i32,
    pub tz: Option<String>,
}

#[derive(Debug, Default)]
pub struct ImportReport {
    pub import_id: i64,
    pub inserted: usize,
    pub already_known: usize,
    pub unmatched: Vec<String>,
    pub per_pattern: Vec<usize>,
}

fn upsert_named(tx: &rusqlite::Transaction, table: &str, name: &str, cache: &mut HashMap<String, i64>) -> Result<i64> {
    if let Some(id) = cache.get(name) { return Ok(*id); }
    tx.execute(&format!("INSERT OR IGNORE INTO {table}(uid, name) VALUES (?1, ?2)"), params![new_uid(), name])?;
    let id: i64 = tx.query_row(&format!("SELECT id FROM {table} WHERE name = ?1"), [name], |r| r.get(0))?;
    cache.insert(name.to_string(), id);
    Ok(id)
}

fn local_to_utc_ms(t: NaiveDateTime, offset_min: i32) -> i64 {
    Utc.from_utc_datetime(&t).timestamp_millis() - offset_min as i64 * 60_000
}

/// Referenced import of scanned audio files into `root_id`. Idempotent per (root, rel_path).
pub fn import_scanned(cat: &mut Catalog, root_id: i64, files: &[scan::ScannedFile], opts: &ImportOptions) -> Result<ImportReport> {
    let tx = cat.conn.transaction()?;
    let pattern_text = opts.patterns.0.iter().map(|p| p.template.as_str()).collect::<Vec<_>>().join("\n");
    tx.execute("INSERT INTO import_batch(uid, created_at, root_id, source, pattern) VALUES (?1, ?2, ?3, 'folder', ?4)",
        params![new_uid(), now_ms(), root_id, pattern_text])?;
    let import_id = tx.last_insert_rowid();
    let mut rep = ImportReport { import_id, per_pattern: vec![0; opts.patterns.0.len()], ..Default::default() };
    let (mut sites, mut devices) = (HashMap::new(), HashMap::new());
    {
        let mut ins_asset = tx.prepare(
            "INSERT OR IGNORE INTO asset(uid, root_id, rel_path, size, mtime, import_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")?;
        let mut ins_rec = tx.prepare(
            "INSERT INTO recording(uid, asset_id, source, start_ms, tz, site_id, device_id) VALUES (?1, ?2, 'file', ?3, ?4, ?5, ?6)")?;
        let mut ins_meta = tx.prepare(
            "INSERT OR REPLACE INTO meta(recording_id, key, value, origin) VALUES (?1, ?2, ?3, 'pattern')")?;
        for f in files {
            if ins_asset.execute(params![new_uid(), root_id, f.rel_path, f.size as i64, f.mtime_ms, import_id])? == 0 {
                rep.already_known += 1;
                continue;
            }
            let asset_id = tx.last_insert_rowid();
            let m = opts.patterns.matches(&f.rel_path);
            if m.is_none() { rep.unmatched.push(f.rel_path.clone()); }
            let (mut site_id, mut device_id, mut start) = (None, None, None);
            if let Some((i, m)) = &m {
                rep.per_pattern[*i] += 1;
                start = m.start.map(|t| local_to_utc_ms(t, opts.utc_offset_min));
                if let Some((field, prefix)) = &opts.site_field {
                    if let Some(v) = m.fields.get(field) { site_id = Some(upsert_named(&tx, "site", &format!("{prefix}{v}"), &mut sites)?); }
                }
                if let Some((field, prefix)) = &opts.device_field {
                    if let Some(v) = m.fields.get(field) { device_id = Some(upsert_named(&tx, "device", &format!("{prefix}{v}"), &mut devices)?); }
                }
            }
            ins_rec.execute(params![new_uid(), asset_id, start, opts.tz, site_id, device_id])?;
            let rec_id = tx.last_insert_rowid();
            if let Some((_, m)) = &m {
                for (k, v) in &m.fields { ins_meta.execute(params![rec_id, k, v])?; }
            }
            rep.inserted += 1;
        }
    }
    tx.execute("UPDATE import_batch SET n_assets = ?1 WHERE id = ?2", params![rep.inserted as i64, import_id])?;
    tx.commit()?;
    Ok(rep)
}

#[derive(Debug, Default)]
pub struct TableImportReport {
    pub run_id: i64,
    pub tables: usize,
    pub detections: usize,
    pub unmatched_tables: Vec<String>,
}

/// Import BirdNET/Raven selection tables as one `imported` run. A table is matched to a recording
/// by file stem (`X.BirdNET.selection.table.txt` → `X.*`), preferring the same folder.
pub fn import_selection_tables(cat: &mut Catalog, root: &Path, root_id: i64, tables: &[scan::ScannedFile], model: &str) -> Result<TableImportReport> {
    let tx = cat.conn.transaction()?;
    tx.execute("INSERT INTO run(uid, kind, model, status, created_at, notes) VALUES (?1, 'imported', ?2, 'done', ?3, ?4)",
        params![new_uid(), model, now_ms(), format!("{} selection tables", tables.len())])?;
    let run_id = tx.last_insert_rowid();
    let mut rep = TableImportReport { run_id, ..Default::default() };
    // stem → [(rel_dir, recording_id)]
    let mut by_stem: HashMap<String, Vec<(String, i64)>> = HashMap::new();
    {
        let mut q = tx.prepare("SELECT a.rel_path, r.id FROM asset a JOIN recording r ON r.asset_id = a.id WHERE a.root_id = ?1")?;
        let rows = q.query_map([root_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        for row in rows {
            let (p, id) = row?;
            let (dir, file) = p.rsplit_once('/').unwrap_or(("", &p));
            let stem = file.rsplit_once('.').map_or(file, |(s, _)| s).to_string();
            by_stem.entry(stem).or_default().push((dir.to_string(), id));
        }
    }
    {
        let mut ins = tx.prepare(
            "INSERT INTO detection(run_id, recording_id, t0, t1, f0, f1, class, score) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")?;
        let mut cov = tx.prepare("INSERT OR IGNORE INTO run_coverage(run_id, recording_id) VALUES (?1, ?2)")?;
        for t in tables {
            let (dir, file) = t.rel_path.rsplit_once('/').unwrap_or(("", &t.rel_path));
            let stem = file.split('.').next().unwrap_or(file);
            let Some(cands) = by_stem.get(stem) else { rep.unmatched_tables.push(t.rel_path.clone()); continue };
            // Prefer the recording whose folder is the table folder's parent or the same folder.
            let parent = dir.rsplit_once('/').map_or("", |(p, _)| p);
            let rec_id = cands.iter().find(|(d, _)| d == parent || d == dir).unwrap_or(&cands[0]).1;
            let text = match std::fs::read_to_string(root.join(&t.rel_path)) {
                Ok(s) => s,
                Err(_) => { rep.unmatched_tables.push(t.rel_path.clone()); continue }
            };
            let mut lines = text.lines();
            let header: Vec<&str> = lines.next().unwrap_or("").split('\t').collect();
            let col = |n: &str| header.iter().position(|h| *h == n);
            let (Some(b), Some(e), Some(c), Some(s)) = (col("Begin Time (s)"), col("End Time (s)"), col("Species Code").or(col("Common Name")), col("Confidence"))
                else { rep.unmatched_tables.push(t.rel_path.clone()); continue };
            let (lo, hi) = (col("Low Freq (Hz)"), col("High Freq (Hz)"));
            cov.execute(params![run_id, rec_id])?;
            for line in lines {
                let v: Vec<&str> = line.split('\t').collect();
                let num = |i: usize| v.get(i).and_then(|x| x.trim().parse::<f64>().ok());
                let (Some(t0), Some(t1), Some(score)) = (num(b), num(e), num(s)) else { continue };
                let class = v.get(c).copied().unwrap_or("").trim();
                ins.execute(params![run_id, rec_id, t0, t1, lo.and_then(num), hi.and_then(num), class, score])?;
                rep.detections += 1;
            }
            rep.tables += 1;
        }
    }
    tx.commit()?;
    Ok(rep)
}

pub fn count(cat: &Catalog, sql: &str) -> Result<i64> {
    Ok(cat.conn.query_row(sql, [], |r| r.get(0)).optional()?.unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_is_idempotent_and_maps_fields() {
        let mut cat = Catalog::open_in_memory().unwrap();
        let root = cat.add_root("sk", "referenced", "test", "/x").unwrap();
        let files: Vec<_> = ["Rekorder_11_Standort_2/Woche_1/SK11_2023_03_13_17_00_01.wav", "odd/file.wav"]
            .iter().map(|p| scan::ScannedFile { rel_path: p.to_string(), size: 1, mtime_ms: 0 }).collect();
        let opts = ImportOptions {
            patterns: PatternSet::parse(&["Rekorder_{recorder}_Standort_{site}/Woche_{week:int}/SK{recorder}_{start:%Y_%m_%d_%H_%M_%S}.wav"]).unwrap(),
            site_field: Some(("site".into(), "Standort ".into())),
            device_field: Some(("recorder".into(), "Rekorder ".into())),
            utc_offset_min: 60, tz: Some("Europe/Berlin".into()),
        };
        let r = import_scanned(&mut cat, root, &files, &opts).unwrap();
        assert_eq!((r.inserted, r.unmatched.len()), (2, 1));
        let r2 = import_scanned(&mut cat, root, &files, &opts).unwrap();
        assert_eq!((r2.inserted, r2.already_known), (0, 2));
        let (site, start): (String, i64) = cat.conn.query_row(
            "SELECT s.name, r.start_ms FROM recording r JOIN site s ON s.id = r.site_id", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(site, "Standort 2");
        assert_eq!(start, Utc.with_ymd_and_hms(2023, 3, 13, 16, 0, 1).unwrap().timestamp_millis());
        assert_eq!(count(&cat, "SELECT COUNT(*) FROM meta WHERE key = 'week' AND value = '1'").unwrap(), 1);
    }
}
