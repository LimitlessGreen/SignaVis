//! SignaVis project catalog (SQLite, `.signavis/catalog.sqlite`).
//! Plan: SignaVis-lab/plans/data-management-plan.md. Phase 0: schema, path templates, referenced
//! import, BirdNET selection tables as runs.

pub mod clock;
pub mod hash;
pub mod header;
pub mod pattern;
pub mod preview;
pub mod profile_spec;
pub mod query;
pub mod scan;
pub mod suggest;

use chrono::{NaiveDateTime, Utc};
use pattern::PatternSet;
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::HashMap;
use std::path::Path;

pub const SCHEMA_VERSION: &str = "1";
const SCHEMA: &str = include_str!("schema.sql");

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

/// Columns added after schema 1 was first written: CREATE TABLE IF NOT EXISTS does not add them
/// to an existing catalog, so add what is missing. Keep this list append-only.
const ADDED_COLUMNS: &[(&str, &str, &str)] = &[
    ("recording", "local_offset_min", "INTEGER"),
    ("site", "tz", "TEXT"),
];

fn migrate(conn: &Connection) -> Result<()> {
    for (table, col, decl) in ADDED_COLUMNS {
        let has: bool = conn.query_row(
            "SELECT COUNT(*) > 0 FROM pragma_table_info(?1) WHERE name = ?2", params![table, col], |r| r.get(0))?;
        if !has { conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {col} {decl}"))?; }
    }
    Ok(())
}

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
        migrate(&conn)?;
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

/// What a pattern field means. Field names in templates are free; the profile maps them.
#[derive(Debug, Clone, PartialEq)]
pub enum FieldRole {
    /// Value names a site (`site` row).
    Site,
    /// Value names a recorder/device (`device` row).
    Device,
    /// Date-time field = recording start (local clock).
    Start,
    /// Date part of the start (combined with `StartTime`).
    StartDate,
    /// Time-of-day part of the start.
    StartTime,
    /// Stored as metadata under another key.
    Meta(String),
    /// Matched but dropped.
    Ignore,
}

#[derive(Debug, Clone)]
pub struct FieldMapping {
    pub field: String,
    pub role: FieldRole,
    /// Display name for Site/Device rows, `{}` = value (e.g. "Site {}"). None = value as is.
    pub format: Option<String>,
    /// Value replacements before formatting (e.g. "34" → "34 (swapped)").
    pub lookup: HashMap<String, String>,
}

impl FieldMapping {
    pub fn new(field: &str, role: FieldRole) -> Self {
        Self { field: field.into(), role, format: None, lookup: HashMap::new() }
    }
    pub fn with_format(mut self, f: &str) -> Self { self.format = Some(f.into()); self }
    fn value(&self, raw: &str) -> String {
        let v = self.lookup.get(raw).map_or(raw, |s| s.as_str());
        match &self.format { Some(f) => f.replace("{}", v), None => v.to_string() }
    }
}

/// Import profile: templates + field roles + clock. Saved per project and reusable
/// (presets for common recorders; profiles of other users can be imported).
/// Unmapped fields go to `meta` under their own name.
#[derive(Debug, Clone)]
pub struct ImportProfile {
    pub name: String,
    pub patterns: PatternSet,
    pub mappings: Vec<FieldMapping>,
    /// Recorder clock: fixed minutes ahead of UTC (no daylight saving) unless `tz` names an IANA zone.
    pub utc_offset_min: i32,
    pub tz: Option<String>,
}

impl ImportProfile {
    pub fn clock(&self) -> clock::Clock {
        self.tz.as_deref().and_then(clock::Clock::parse).unwrap_or(clock::Clock::Fixed(self.utc_offset_min))
    }
}

impl ImportProfile {
    pub fn describe(&self) -> String {
        let mut s = format!("profile {}\n", self.name);
        for p in &self.patterns.0 { s += &format!("pattern {}\n", p.template); }
        for m in &self.mappings { s += &format!("map {} -> {:?} {:?}\n", m.field, m.role, m.format); }
        s
    }
    fn mapping(&self, field: &str) -> Option<&FieldMapping> { self.mappings.iter().find(|m| m.field == field) }
}

#[derive(Debug, Default)]
pub struct ImportReport {
    pub import_id: i64,
    pub inserted: usize,
    pub already_known: usize,
    pub unmatched: Vec<String>,
    /// Matched, but no start time could be derived.
    pub no_start: usize,
    pub per_pattern: Vec<usize>,
}

fn upsert_named(tx: &rusqlite::Transaction, table: &str, name: &str, cache: &mut HashMap<String, i64>) -> Result<i64> {
    if let Some(id) = cache.get(name) { return Ok(*id); }
    tx.execute(&format!("INSERT OR IGNORE INTO {table}(uid, name) VALUES (?1, ?2)"), params![new_uid(), name])?;
    let id: i64 = tx.query_row(&format!("SELECT id FROM {table} WHERE name = ?1"), [name], |r| r.get(0))?;
    cache.insert(name.to_string(), id);
    Ok(id)
}


/// Resolved catalog values of one path match.
#[derive(Debug, Default, PartialEq)]
pub struct Resolved {
    pub site: Option<String>,
    pub device: Option<String>,
    pub start: Option<NaiveDateTime>,
    pub meta: Vec<(String, String)>,
}

/// Apply the profile's roles to a match (also used by the import preview).
pub fn resolve(profile: &ImportProfile, m: &pattern::PatternMatch) -> Resolved {
    let mut r = Resolved::default();
    let (mut date, mut time) = (None, None);
    for (field, raw) in &m.fields {
        match profile.mapping(field) {
            None => r.meta.push((field.clone(), raw.clone())),
            Some(map) => match &map.role {
                FieldRole::Site => r.site = Some(map.value(raw)),
                FieldRole::Device => r.device = Some(map.value(raw)),
                FieldRole::Start => r.start = m.times.get(field).copied(),
                FieldRole::StartDate => date = m.times.get(field).map(|t| t.date()),
                FieldRole::StartTime => time = m.time_only.get(field).copied()
                    .or_else(|| m.times.get(field).map(|t| t.time())),
                FieldRole::Meta(key) => r.meta.push((key.clone(), map.value(raw))),
                FieldRole::Ignore => {}
            },
        }
    }
    if r.start.is_none() {
        if let Some(d) = date { r.start = Some(d.and_time(time.unwrap_or_default())); }
    }
    r
}

/// Referenced import of scanned audio files into `root_id`. Idempotent per (root, rel_path).
pub fn import_scanned(cat: &mut Catalog, root_id: i64, files: &[scan::ScannedFile], profile: &ImportProfile) -> Result<ImportReport> {
    let tx = cat.conn.transaction()?;
    tx.execute("INSERT INTO import_batch(uid, created_at, root_id, source, pattern) VALUES (?1, ?2, ?3, 'folder', ?4)",
        params![new_uid(), now_ms(), root_id, profile.describe()])?;
    let import_id = tx.last_insert_rowid();
    let mut rep = ImportReport { import_id, per_pattern: vec![0; profile.patterns.0.len()], ..Default::default() };
    let (mut sites, mut devices) = (HashMap::new(), HashMap::new());
    {
        let mut ins_asset = tx.prepare(
            "INSERT OR IGNORE INTO asset(uid, root_id, rel_path, size, mtime, import_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")?;
        let mut ins_rec = tx.prepare(
            "INSERT INTO recording(uid, asset_id, source, start_ms, local_offset_min, tz, site_id, device_id) VALUES (?1, ?2, 'file', ?3, ?4, ?5, ?6, ?7)")?;
        let mut ins_meta = tx.prepare(
            "INSERT OR REPLACE INTO meta(recording_id, key, value, origin) VALUES (?1, ?2, ?3, 'pattern')")?;
        for f in files {
            if ins_asset.execute(params![new_uid(), root_id, f.rel_path, f.size as i64, f.mtime_ms, import_id])? == 0 {
                rep.already_known += 1;
                continue;
            }
            let asset_id = tx.last_insert_rowid();
            let res = match profile.patterns.matches(&f.rel_path) {
                Some((i, m)) => { rep.per_pattern[i] += 1; Some(resolve(profile, &m)) }
                None => { rep.unmatched.push(f.rel_path.clone()); None }
            };
            if res.as_ref().is_some_and(|r| r.start.is_none()) { rep.no_start += 1; }
            let res = res.unwrap_or_default();
            let site_id = res.site.as_deref().map(|s| upsert_named(&tx, "site", s, &mut sites)).transpose()?;
            let device_id = res.device.as_deref().map(|s| upsert_named(&tx, "device", s, &mut devices)).transpose()?;
            let clk = profile.clock();
            let utc = res.start.map(|t| clk.to_utc(t));
            ins_rec.execute(params![new_uid(), asset_id, utc.map(|u| u.0), utc.map(|u| u.1), utc.map(|_| clk.label()), site_id, device_id])?;
            let rec_id = tx.last_insert_rowid();
            for (k, v) in &res.meta { ins_meta.execute(params![rec_id, k, v])?; }
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
    use chrono::TimeZone;

    #[test]
    fn old_catalog_gets_new_columns() {
        let path = std::env::temp_dir().join(format!("aw-migrate-{}.sqlite", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch("CREATE TABLE site (id INTEGER PRIMARY KEY, uid TEXT NOT NULL UNIQUE, name TEXT NOT NULL UNIQUE);
                             CREATE TABLE recording (id INTEGER PRIMARY KEY, uid TEXT NOT NULL UNIQUE, asset_id INTEGER, source TEXT NOT NULL,
                               start_ms INTEGER, tz TEXT, site_id INTEGER, device_id INTEGER);").unwrap();
        }
        let cat = Catalog::open(&path).unwrap();
        assert!(sites(&cat).unwrap().is_empty());
        cat.conn.execute("UPDATE recording SET local_offset_min = 0", []).unwrap();
        drop(cat);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn import_is_idempotent_and_maps_fields() {
        let mut cat = Catalog::open_in_memory().unwrap();
        let root = cat.add_root("sk", "referenced", "test", "/x").unwrap();
        let files: Vec<_> = ["Rekorder_11_Standort_2/Woche_1/SK11_2023_03_13_17_00_01.wav", "odd/file.wav"]
            .iter().map(|p| scan::ScannedFile { rel_path: p.to_string(), size: 1, mtime_ms: 0 }).collect();
        let opts = ImportProfile {
            name: "test".into(),
            patterns: PatternSet::parse(&["Rekorder_{rec}_Standort_{loc}/Woche_{week:int}/SK{rec}_{t:%Y_%m_%d_%H_%M_%S}.wav"]).unwrap(),
            mappings: vec![
                FieldMapping::new("loc", FieldRole::Site).with_format("Standort {}"),
                FieldMapping::new("rec", FieldRole::Device).with_format("Rekorder {}"),
                FieldMapping::new("t", FieldRole::Start),
            ],
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
        assert_eq!(count(&cat, "SELECT COUNT(*) FROM meta WHERE key IN ('loc', 'rec', 't')").unwrap(), 0, "mapped fields not duplicated");
    }

    #[test]
    fn date_and_time_from_different_fields() {
        let profile = ImportProfile {
            name: "am".into(),
            patterns: PatternSet::parse(&["{site}/{day:%Y-%m-%d}/{dev}_{clock:%H%M%S}.flac"]).unwrap(),
            mappings: vec![
                FieldMapping::new("site", FieldRole::Site),
                FieldMapping::new("dev", FieldRole::Meta("serial".into())),
                FieldMapping::new("day", FieldRole::StartDate),
                FieldMapping::new("clock", FieldRole::StartTime),
            ],
            utc_offset_min: 0, tz: None,
        };
        let m = profile.patterns.matches("Moor/2024-05-01/AM07_043000.flac").unwrap().1;
        let r = resolve(&profile, &m);
        assert_eq!(r.site.as_deref(), Some("Moor"));
        assert_eq!(r.start.unwrap().to_string(), "2024-05-01 04:30:00");
        assert_eq!(r.meta, vec![("serial".to_string(), "AM07".to_string())]);
    }
}

/// Absolute path of a recording's file on this machine, if its root is located here.
pub fn recording_path(cat: &Catalog, recording_id: i64, machine: &str) -> Result<Option<std::path::PathBuf>> {
    let row: Option<(String, String)> = cat.conn.query_row(
        "SELECT l.path, a.rel_path FROM recording r JOIN asset a ON a.id = r.asset_id
         JOIN root_location l ON l.root_id = a.root_id AND l.machine = ?2 WHERE r.id = ?1",
        params![recording_id, machine], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
    Ok(row.map(|(base, rel)| Path::new(&base).join(rel)))
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootInfo { pub id: i64, pub name: String, pub kind: String, pub path: Option<String>, pub assets: i64 }

pub fn roots(cat: &Catalog, machine: &str) -> Result<Vec<RootInfo>> {
    let mut st = cat.conn.prepare(
        "SELECT r.id, r.name, r.kind, l.path, (SELECT COUNT(*) FROM asset a WHERE a.root_id = r.id)
         FROM root r LEFT JOIN root_location l ON l.root_id = r.id AND l.machine = ?1 ORDER BY r.name")?;
    let v = st.query_map([machine], |r| Ok(RootInfo { id: r.get(0)?, name: r.get(1)?, kind: r.get(2)?, path: r.get(3)?, assets: r.get(4)? }))?
        .collect::<std::result::Result<_, _>>()?;
    Ok(v)
}

/// Stable name of this machine for `root_location`.
pub fn machine_name() -> String {
    std::env::var("COMPUTERNAME").ok()
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok().map(|s| s.trim().to_string()))
        .or_else(|| std::env::var("HOSTNAME").ok())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "local".into())
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteInfo { pub id: i64, pub name: String, pub tz: Option<String>, pub recordings: i64, pub clocks: Vec<String> }

/// Sites with their clock (site setting, and the clocks actually used by their recordings).
pub fn sites(cat: &Catalog) -> Result<Vec<SiteInfo>> {
    let mut st = cat.conn.prepare(
        "SELECT s.id, s.name, s.tz, COUNT(r.id), COALESCE(GROUP_CONCAT(DISTINCT r.tz), '')
         FROM site s LEFT JOIN recording r ON r.site_id = s.id GROUP BY s.id")?;
    let mut v: Vec<SiteInfo> = st.query_map([], |r| Ok(SiteInfo {
        id: r.get(0)?, name: r.get(1)?, tz: r.get(2)?, recordings: r.get(3)?,
        clocks: r.get::<_, String>(4)?.split(',').filter(|x| !x.is_empty()).map(String::from).collect(),
    }))?.collect::<std::result::Result<_, _>>()?;
    v.sort_by(|a, b| query::natural_cmp(&a.name, &b.name));
    Ok(v)
}
