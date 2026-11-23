// ═══════════════════════════════════════════════════════════════════════
// catalog.rs — project catalog (data management, phase 1)
//
// One SQLite catalog per folder project: <root>/.signavis/catalog.sqlite
// (crate aw-catalog). Import sources can live outside the project
// (referenced roots, e.g. an external drive or NAS); the absolute path is
// stored per machine so the same catalog works on several computers.
// ═══════════════════════════════════════════════════════════════════════

use aw_catalog::{
    Catalog, import_scanned, import_selection_tables, machine_name,
    preview::{Preview, preview},
    profile_spec::ProfileSpec,
    query::{Cursor, Facets, Filter, HeatCell, Page, Sort},
    scan::{ScanResult, scan},
};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use aw_catalog::hash::HashKind;
use tauri::Emitter;

pub const HASH_EVENT: &str = "lite-catalog-hash";

const CATALOG_FILE: &str = ".signavis/catalog.sqlite";

#[derive(Default)]
pub struct CatalogState {
    open: Mutex<HashMap<String, Arc<Mutex<Catalog>>>>,
    /// Last scan per source folder and scan options (preview → import without scanning twice).
    scans: Arc<Mutex<HashMap<String, Arc<ScanResult>>>>,
    hash_cancel: Arc<AtomicBool>,
    hash_running: Arc<AtomicBool>,
}

fn err(e: impl std::fmt::Display) -> String { e.to_string() }

impl CatalogState {
    fn get(&self, project_root: &str) -> Result<Arc<Mutex<Catalog>>, String> {
        let mut open = self.open.lock().map_err(err)?;
        if let Some(c) = open.get(project_root) { return Ok(c.clone()); }
        let cat = Catalog::open(&Path::new(project_root).join(CATALOG_FILE)).map_err(err)?;
        let c = Arc::new(Mutex::new(cat));
        open.insert(project_root.to_string(), c.clone());
        Ok(c)
    }

    /// Scan of `source` with the profile's scan options: cached per (folder, options), the walk
    /// itself on the blocking pool (a slow network folder must not hold an async worker).
    async fn scan(&self, source: &str, spec: &ProfileSpec, refresh: bool) -> Result<Arc<ScanResult>, String> {
        let opts = spec.scan_options().map_err(err)?;   // invalid exclusions fail even on a cache hit
        let key = format!("{source}\n{}", spec.derived_dirs.join("\n"));
        if !refresh {
            if let Some(s) = self.scans.lock().map_err(err)?.get(&key) { return Ok(s.clone()); }
        }
        let (scans, source) = (self.scans.clone(), source.to_string());
        blocking(move || {
            let dir = PathBuf::from(&source);
            if !dir.is_dir() { return Err(format!("not a folder: {source}")); }
            let s = Arc::new(scan(&dir, &opts));
            scans.lock().map_err(err)?.insert(key, s.clone());
            Ok(s)
        }).await
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(err)?
}

/// Scan `source` (cached unless `refresh`) and show what `profile` makes of it. Writes nothing.
#[tauri::command]
pub async fn catalog_preview(
    state: tauri::State<'_, CatalogState>, source: String, profile: ProfileSpec, refresh: bool,
) -> Result<Preview, String> {
    let built = profile.build().map_err(err)?;
    let scanned = state.scan(&source, &profile, refresh).await?;
    blocking(move || Ok(preview(&scanned, &built, 200))).await
}

/// Suggested import profiles (path templates + roles) for a folder.
#[tauri::command]
pub async fn catalog_suggest(
    state: tauri::State<'_, CatalogState>, source: String, refresh: bool,
) -> Result<Vec<aw_catalog::suggest::Suggestion>, String> {
    let scanned = state.scan(&source, &ProfileSpec::default(), refresh).await?;
    blocking(move || Ok(aw_catalog::suggest::suggest_for_scan(&scanned, 6))).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub root_id: i64,
    /// Re-import of a known source: files found under a new name/folder, gone, changed.
    pub moved: usize,
    pub moved_examples: Vec<aw_catalog::hash::Moved>,
    pub missing: usize,
    pub changed: usize,
    pub inserted: usize,
    pub already_known: usize,
    pub unmatched: usize,
    pub no_start: usize,
    pub tables: usize,
    pub detections: usize,
}

/// Referenced import of `source` under the root name `root_name`; saves the profile.
#[tauri::command]
pub async fn catalog_import(
    state: tauri::State<'_, CatalogState>, project_root: String, source: String, root_name: String,
    profile: ProfileSpec, import_tables: bool,
) -> Result<ImportResult, String> {
    let built = profile.build().map_err(err)?;
    let scanned = state.scan(&source, &profile, false).await?;
    let cat = state.get(&project_root)?;
    blocking(move || {
        let mut cat = cat.lock().map_err(err)?;
        cat.save_profile(&profile).map_err(err)?;
        let root_id = cat.add_root(&root_name, "referenced", &machine_name(), &source).map_err(err)?;
        // Known source (same name): match renamed/moved files first, import only what is new.
        let rec = aw_catalog::hash::reconcile(&mut cat, root_id, Path::new(&source), &scanned.audio, Some(&built)).map_err(err)?;
        let rep = import_scanned(&mut cat, root_id, &rec.new_files, &built).map_err(err)?;
        let (mut tables, mut detections) = (0, 0);
        if import_tables && !scanned.selection_tables.is_empty() {
            let t = import_selection_tables(&mut cat, Path::new(&source), root_id, &scanned.selection_tables, "BirdNET (imported)")
                .map_err(err)?;
            (tables, detections) = (t.tables, t.detections);
        }
        Ok(ImportResult {
            root_id, moved: rec.moved.len(), moved_examples: rec.moved.into_iter().take(20).collect(),
            missing: rec.missing.len(), changed: rec.changed.len(), inserted: rep.inserted, already_known: rep.already_known + rec.unchanged, unmatched: rep.unmatched.len(),
            no_start: rep.no_start, tables, detections,
        })
    }).await
}

#[tauri::command]
pub async fn catalog_profiles(state: tauri::State<'_, CatalogState>, project_root: String) -> Result<Vec<ProfileSpec>, String> {
    let cat = state.get(&project_root)?;
    blocking(move || cat.lock().map_err(err)?.profiles().map_err(err)).await
}

#[tauri::command]
pub async fn catalog_roots(state: tauri::State<'_, CatalogState>, project_root: String) -> Result<Vec<aw_catalog::RootInfo>, String> {
    let cat = state.get(&project_root)?;
    blocking(move || aw_catalog::roots(&*cat.lock().map_err(err)?, &machine_name()).map_err(err)).await
}

#[tauri::command]
pub async fn catalog_facets(state: tauri::State<'_, CatalogState>, project_root: String, filter: Filter) -> Result<Facets, String> {
    let cat = state.get(&project_root)?;
    blocking(move || aw_catalog::query::facets(&*cat.lock().map_err(err)?, &filter).map_err(err)).await
}

#[tauri::command]
pub async fn catalog_list(
    state: tauri::State<'_, CatalogState>, project_root: String, filter: Filter, sort: Sort,
    after: Option<Cursor>, limit: usize,
) -> Result<Page, String> {
    let cat = state.get(&project_root)?;
    blocking(move || {
        aw_catalog::query::list(&*cat.lock().map_err(err)?, &filter, sort, after.as_ref(), limit.clamp(1, 2000)).map_err(err)
    }).await
}

#[tauri::command]
pub async fn catalog_heatmap(state: tauri::State<'_, CatalogState>, project_root: String, filter: Filter) -> Result<Vec<HeatCell>, String> {
    let cat = state.get(&project_root)?;
    blocking(move || aw_catalog::query::heatmap(&*cat.lock().map_err(err)?, &filter).map_err(err)).await
}

/// Absolute path of a recording on this machine (None: its root is not located here).
#[tauri::command]
pub async fn catalog_recording_path(
    state: tauri::State<'_, CatalogState>, project_root: String, recording_id: i64,
) -> Result<Option<String>, String> {
    let cat = state.get(&project_root)?;
    blocking(move || {
        let p = aw_catalog::recording_path(&*cat.lock().map_err(err)?, recording_id, &machine_name()).map_err(err)?;
        Ok(p.map(|p| p.to_string_lossy().into_owned()))
    }).await
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum JobKind { Header, Quick, Full }

impl From<HashKind> for JobKind {
    fn from(k: HashKind) -> Self { match k { HashKind::Quick => JobKind::Quick, HashKind::Full => JobKind::Full } }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HashProgress {
    project_root: String, kind: JobKind, done: usize, total: usize, finished: bool, failed: usize,
    /// Set on the final event when the job stopped because of an error (resume by starting again).
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Background job over all roots located on this machine: audio headers, quick hashes (fingerprints), and with
/// `full` afterwards SHA-256 checksums of the whole files. Progress as HASH_EVENT; resumable
/// (commits in batches); one job at a time.
#[tauri::command]
pub async fn catalog_hash_start(app: tauri::AppHandle, state: tauri::State<'_, CatalogState>, project_root: String, full: bool) -> Result<(), String> {
    let cat = state.get(&project_root)?;   // before taking the reservation: a failed open leaves none behind
    if state.hash_running.swap(true, Ordering::SeqCst) { return Err("hashing is already running".into()); }
    state.hash_cancel.store(false, Ordering::SeqCst);
    let (cancel, running) = (state.hash_cancel.clone(), state.hash_running.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| -> Result<(), String> {
            let roots = aw_catalog::roots(&*cat.lock().map_err(err)?, &machine_name()).map_err(err)?;
            let mut failed = 0;
            // 1. Headers (duration, sample rate, channels, GUANO/comment) — small reads.
            'headers: for r in &roots {
                let Some(base) = r.path.clone() else { continue };
                let todo = aw_catalog::header::header_todo(&*cat.lock().map_err(err)?, r.id).map_err(err)?;
                let mut done = 0;
                for chunk in todo.chunks(500) {
                    let (infos, cancelled) = aw_catalog::header::read_batch(Path::new(&base), chunk, &cancel);
                    failed += infos.iter().filter(|(_, r)| r.is_err()).count();
                    aw_catalog::header::store_infos(&mut *cat.lock().map_err(err)?, &infos).map_err(err)?;
                    done += infos.len();
                    let _ = app.emit(HASH_EVENT, HashProgress {
                        project_root: project_root.clone(), kind: JobKind::Header, done, total: todo.len(), finished: false, failed, error: None,
                    });
                    if cancelled { break 'headers; }
                }
            }
            if cancel.load(Ordering::SeqCst) {
                let _ = app.emit(HASH_EVENT, HashProgress { project_root: project_root.clone(), kind: JobKind::Header, done: 0, total: 0, finished: true, failed, error: None });
                return Ok(());
            }
            // 2. Fingerprints, 3. (optional) SHA-256.
            let kinds: &[HashKind] = if full { &[HashKind::Quick, HashKind::Full] } else { &[HashKind::Quick] };
            'all: for &kind in kinds {
                for r in &roots {
                    let Some(base) = r.path.clone() else { continue };
                    let todo = aw_catalog::hash::hash_todo(&*cat.lock().map_err(err)?, r.id, kind).map_err(err)?;
                    let batch = if kind == HashKind::Full { 20 } else { aw_catalog::hash::HASH_BATCH };
                    // Read the files without holding the catalog; lock only to store each batch.
                    let mut attempted = 0;
                    for chunk in todo.chunks(batch) {
                        let mut rep = aw_catalog::hash::HashReport::default();
                        let done = aw_catalog::hash::hash_batch(Path::new(&base), kind, chunk, &cancel, &mut rep);
                        aw_catalog::hash::store_checked(&mut *cat.lock().map_err(err)?, kind, &done).map_err(err)?;
                        failed += rep.failed.len();
                        attempted += done.len() + rep.failed.len();
                        let _ = app.emit(HASH_EVENT, HashProgress {
                            project_root: project_root.clone(), kind: kind.into(), done: attempted, total: todo.len(), finished: false, failed, error: None,
                        });
                        if rep.cancelled { break 'all; }
                    }
                }
            }
            let _ = app.emit(HASH_EVENT, HashProgress { project_root: project_root.clone(), kind: JobKind::Quick, done: 0, total: 0, finished: true, failed, error: None });
            Ok(())
        })();
        running.store(false, Ordering::SeqCst);
        if let Err(e) = result {
            eprintln!("[catalog] hashing failed: {e}");
            // Every exit ends the progress: the UI stops waiting and can offer to start again.
            let _ = app.emit(HASH_EVENT, HashProgress { project_root: project_root.clone(), kind: JobKind::Quick, done: 0, total: 0, finished: true, failed: 0, error: Some(e) });
        }
    });
    Ok(())
}

#[tauri::command]
pub fn catalog_hash_cancel(state: tauri::State<'_, CatalogState>) { state.hash_cancel.store(true, Ordering::SeqCst); }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Integrity {
    pub hashed: i64,
    pub unhashed: i64,
    pub no_header: i64,
    pub full_hashed: i64,
    pub full_unhashed: i64,
    pub bytes_without_checksum: i64,
    pub missing: i64,
    pub changed: i64,
    pub duplicate_groups: usize,
    pub duplicates: Vec<aw_catalog::hash::DuplicateGroup>,
    pub hashing: bool,
}

/// Hash coverage, missing/changed files and same-content groups.
#[tauri::command]
pub async fn catalog_integrity(state: tauri::State<'_, CatalogState>, project_root: String) -> Result<Integrity, String> {
    let cat = state.get(&project_root)?;
    let hashing = state.hash_running.load(Ordering::SeqCst);
    blocking(move || {
        let c = cat.lock().map_err(err)?;
        let n = |sql: &str| aw_catalog::count(&c, sql).map_err(err);
        let (groups, dups) = aw_catalog::hash::duplicates(&c, 50).map_err(err)?;
        Ok(Integrity {
            hashed: n("SELECT COUNT(*) FROM asset WHERE quick_hash IS NOT NULL")?,
            unhashed: n("SELECT COUNT(*) FROM asset WHERE quick_hash IS NULL AND status != 'missing'")?,
            no_header: n(aw_catalog::header::PENDING_HEADERS_SQL)?,
            full_hashed: n("SELECT COUNT(*) FROM asset WHERE full_hash IS NOT NULL")?,
            full_unhashed: n("SELECT COUNT(*) FROM asset WHERE full_hash IS NULL AND status != 'missing'")?,
            bytes_without_checksum: n("SELECT COALESCE(SUM(size), 0) FROM asset WHERE full_hash IS NULL AND status != 'missing'")?,
            missing: n("SELECT COUNT(*) FROM asset WHERE status = 'missing'")?,
            changed: n("SELECT COUNT(*) FROM asset WHERE status = 'changed'")?,
            duplicate_groups: groups, duplicates: dups, hashing,
        })
    }).await
}

#[tauri::command]
pub async fn catalog_sites(state: tauri::State<'_, CatalogState>, project_root: String) -> Result<Vec<aw_catalog::SiteInfo>, String> {
    let cat = state.get(&project_root)?;
    blocking(move || aw_catalog::sites(&*cat.lock().map_err(err)?).map_err(err)).await
}

/// Change a site's recorder clock ("Europe/Berlin", "UTC+01:00"); wall times stay, UTC is recomputed.
#[tauri::command]
pub async fn catalog_set_site_clock(
    state: tauri::State<'_, CatalogState>, project_root: String, site_id: i64, clock: String,
) -> Result<aw_catalog::clock::ClockReport, String> {
    let c = aw_catalog::clock::Clock::parse(&clock).ok_or_else(|| format!("unknown clock '{clock}'"))?;
    let cat = state.get(&project_root)?;
    blocking(move || aw_catalog::clock::set_site_clock(&mut *cat.lock().map_err(err)?, site_id, c).map_err(err)).await
}

#[tauri::command]
pub async fn catalog_devices(state: tauri::State<'_, CatalogState>, project_root: String) -> Result<Vec<aw_catalog::DeviceInfo>, String> {
    let cat = state.get(&project_root)?;
    blocking(move || aw_catalog::devices(&*cat.lock().map_err(err)?).map_err(err)).await
}

/// Likely manual clock changes (recording window jumps by whole hours between nights).
#[tauri::command]
pub async fn catalog_clock_shifts(state: tauri::State<'_, CatalogState>, project_root: String) -> Result<Vec<aw_catalog::clock::ClockShift>, String> {
    let cat = state.get(&project_root)?;
    blocking(move || aw_catalog::clock::detect_clock_shifts(&*cat.lock().map_err(err)?).map_err(err)).await
}

/// Replace a recorder's clock periods; wall times stay, UTC is recomputed.
#[tauri::command]
pub async fn catalog_set_device_clocks(
    state: tauri::State<'_, CatalogState>, project_root: String, device_id: i64, periods: Vec<aw_catalog::clock::ClockPeriod>,
) -> Result<aw_catalog::clock::ClockReport, String> {
    let cat = state.get(&project_root)?;
    blocking(move || aw_catalog::clock::set_device_clocks(&mut *cat.lock().map_err(err)?, device_id, &periods).map_err(err)).await
}

// ── Phase 2: sites, recorders, deployments, bulk edit, statistics ─────────

use aw_catalog::entities::{self as ent, BulkEdit, DeviceFields, Selection, SiteFields};

#[tauri::command]
pub async fn catalog_site_fields(state: tauri::State<'_, CatalogState>, project_root: String, site_id: i64) -> Result<SiteFields, String> {
    let cat = state.get(&project_root)?;
    blocking(move || ent::site_fields(&*cat.lock().map_err(err)?, site_id).map_err(err)).await
}

/// Create (`site_id` null) or update a site; returns its id.
#[tauri::command]
pub async fn catalog_save_site(state: tauri::State<'_, CatalogState>, project_root: String, site_id: Option<i64>, fields: SiteFields) -> Result<i64, String> {
    let cat = state.get(&project_root)?;
    blocking(move || ent::save_site(&*cat.lock().map_err(err)?, site_id, &fields).map_err(err)).await
}

#[tauri::command]
pub async fn catalog_device_fields(state: tauri::State<'_, CatalogState>, project_root: String, device_id: i64) -> Result<DeviceFields, String> {
    let cat = state.get(&project_root)?;
    blocking(move || ent::device_fields(&*cat.lock().map_err(err)?, device_id).map_err(err)).await
}

#[tauri::command]
pub async fn catalog_save_device(state: tauri::State<'_, CatalogState>, project_root: String, device_id: Option<i64>, fields: DeviceFields) -> Result<i64, String> {
    let cat = state.get(&project_root)?;
    blocking(move || ent::save_device(&*cat.lock().map_err(err)?, device_id, &fields).map_err(err)).await
}

/// Delete an unused site or recorder (`table`: "site" | "device").
#[tauri::command]
pub async fn catalog_delete_entity(state: tauri::State<'_, CatalogState>, project_root: String, table: String, id: i64) -> Result<(), String> {
    let cat = state.get(&project_root)?;
    blocking(move || ent::delete_entity(&mut *cat.lock().map_err(err)?, &table, id).map_err(err)).await
}

/// Merge sites or recorders into `into`; returns the number of recordings moved.
#[tauri::command]
pub async fn catalog_merge(state: tauri::State<'_, CatalogState>, project_root: String, table: String, from: Vec<i64>, into: i64) -> Result<usize, String> {
    let cat = state.get(&project_root)?;
    blocking(move || ent::merge(&mut *cat.lock().map_err(err)?, &table, &from, into).map_err(err)).await
}

#[tauri::command]
pub async fn catalog_derive_deployments(state: tauri::State<'_, CatalogState>, project_root: String, gap_days: f64) -> Result<ent::DeriveReport, String> {
    let cat = state.get(&project_root)?;
    blocking(move || ent::derive_deployments(&mut *cat.lock().map_err(err)?, gap_days).map_err(err)).await
}

#[tauri::command]
pub async fn catalog_deployments(state: tauri::State<'_, CatalogState>, project_root: String) -> Result<Vec<ent::DeploymentInfo>, String> {
    let cat = state.get(&project_root)?;
    blocking(move || ent::deployments(&*cat.lock().map_err(err)?).map_err(err)).await
}

#[tauri::command]
pub async fn catalog_set_deployment_notes(state: tauri::State<'_, CatalogState>, project_root: String, id: i64, notes: Option<String>) -> Result<(), String> {
    let cat = state.get(&project_root)?;
    blocking(move || ent::set_deployment_notes(&*cat.lock().map_err(err)?, id, notes.as_deref()).map_err(err)).await
}

#[tauri::command]
pub async fn catalog_tags(state: tauri::State<'_, CatalogState>, project_root: String) -> Result<Vec<ent::TagInfo>, String> {
    let cat = state.get(&project_root)?;
    blocking(move || ent::tags(&*cat.lock().map_err(err)?).map_err(err)).await
}

#[tauri::command]
pub async fn catalog_meta_keys(state: tauri::State<'_, CatalogState>, project_root: String) -> Result<Vec<(String, i64)>, String> {
    let cat = state.get(&project_root)?;
    blocking(move || ent::meta_keys(&*cat.lock().map_err(err)?).map_err(err)).await
}

#[tauri::command]
pub async fn catalog_bulk_edit(state: tauri::State<'_, CatalogState>, project_root: String, selection: Selection, edit: BulkEdit) -> Result<ent::BulkReport, String> {
    let cat = state.get(&project_root)?;
    blocking(move || ent::bulk_edit(&mut *cat.lock().map_err(err)?, &selection, &edit).map_err(err)).await
}

#[tauri::command]
pub async fn catalog_recording_detail(state: tauri::State<'_, CatalogState>, project_root: String, recording_id: i64) -> Result<ent::RecordingDetail, String> {
    let cat = state.get(&project_root)?;
    blocking(move || ent::recording_detail(&*cat.lock().map_err(err)?, recording_id).map_err(err)).await
}

#[tauri::command]
pub async fn catalog_stats(state: tauri::State<'_, CatalogState>, project_root: String, filter: Filter) -> Result<aw_catalog::stats::Stats, String> {
    let cat = state.get(&project_root)?;
    blocking(move || aw_catalog::stats::stats(&*cat.lock().map_err(err)?, &filter, 25).map_err(err)).await
}

// ── Positions, GPS tracks, map ───────────────────────────────────────────

/// Read a GPX file, store it as a track and give the selected recordings in its time span a position.
#[tauri::command]
pub async fn catalog_import_track(
    state: tauri::State<'_, CatalogState>, project_root: String, path: String, name: Option<String>,
    device_id: Option<i64>, selection: Selection, max_gap_s: f64,
) -> Result<serde_json::Value, String> {
    let cat = state.get(&project_root)?;
    blocking(move || {
        let text = std::fs::read_to_string(&path).map_err(err)?;
        let (pts, untimed, invalid) = aw_catalog::geo::parse_gpx(&text).map_err(err)?;
        let name = name.unwrap_or_else(|| Path::new(&path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default());
        let mut c = cat.lock().map_err(err)?;
        let id = aw_catalog::geo::save_track(&mut c, &name, Some(&path), device_id, &pts).map_err(err)?;
        let m = aw_catalog::geo::match_track(&mut c, id, &selection, max_gap_s).map_err(err)?;
        Ok(serde_json::json!({ "trackId": id, "points": pts.len(), "untimed": untimed, "invalid": invalid, "match": m }))
    }).await
}

#[tauri::command]
pub async fn catalog_match_track(
    state: tauri::State<'_, CatalogState>, project_root: String, track_id: i64, selection: Selection, max_gap_s: f64,
) -> Result<aw_catalog::geo::MatchReport, String> {
    let cat = state.get(&project_root)?;
    blocking(move || aw_catalog::geo::match_track(&mut *cat.lock().map_err(err)?, track_id, &selection, max_gap_s).map_err(err)).await
}

#[tauri::command]
pub async fn catalog_tracks(state: tauri::State<'_, CatalogState>, project_root: String) -> Result<Vec<aw_catalog::geo::TrackInfo>, String> {
    let cat = state.get(&project_root)?;
    blocking(move || aw_catalog::geo::tracks(&*cat.lock().map_err(err)?).map_err(err)).await
}

#[tauri::command]
pub async fn catalog_track_line(state: tauri::State<'_, CatalogState>, project_root: String, track_id: i64) -> Result<Vec<[f64; 2]>, String> {
    let cat = state.get(&project_root)?;
    blocking(move || aw_catalog::geo::track_line(&*cat.lock().map_err(err)?, track_id, 2000).map_err(err)).await
}

#[tauri::command]
pub async fn catalog_delete_track(state: tauri::State<'_, CatalogState>, project_root: String, track_id: i64) -> Result<(), String> {
    let cat = state.get(&project_root)?;
    blocking(move || aw_catalog::geo::delete_track(&mut *cat.lock().map_err(err)?, track_id).map_err(err)).await
}

#[tauri::command]
pub async fn catalog_map(state: tauri::State<'_, CatalogState>, project_root: String, filter: Filter, cell_deg: f64) -> Result<aw_catalog::geo::MapData, String> {
    let cat = state.get(&project_root)?;
    blocking(move || aw_catalog::geo::map_data(&*cat.lock().map_err(err)?, &filter, cell_deg).map_err(err)).await
}

// ── Spectrogram thumbnails (library grid) ────────────────────────────────

/// Thumbnails for the given recordings, from the cache or rendered from the files.
#[tauri::command]
pub async fn catalog_thumbs(
    state: tauri::State<'_, CatalogState>, project_root: String, ids: Vec<i64>, spec: aw_catalog::thumb::ThumbSpec,
) -> Result<Vec<aw_catalog::thumb::ThumbResult>, String> {
    let cat = state.get(&project_root)?;
    blocking(move || Ok(aw_catalog::thumb::thumbs(&cat, &ids, spec, &machine_name()))).await
}

#[tauri::command]
pub async fn catalog_thumbs_clear(state: tauri::State<'_, CatalogState>, project_root: String) -> Result<usize, String> {
    let cat = state.get(&project_root)?;
    blocking(move || aw_catalog::thumb::clear(&*cat.lock().map_err(err)?).map_err(err)).await
}

// ── Datasets ─────────────────────────────────────────────────────────────

use aw_catalog::datasets as ds;

#[tauri::command]
pub async fn catalog_datasets(state: tauri::State<'_, CatalogState>, project_root: String) -> Result<Vec<ds::DatasetInfo>, String> {
    let cat = state.get(&project_root)?;
    blocking(move || ds::list(&*cat.lock().map_err(err)?).map_err(err)).await
}

#[tauri::command]
pub async fn catalog_create_dataset(state: tauri::State<'_, CatalogState>, project_root: String, kind: String, dataset: ds::DatasetEdit) -> Result<i64, String> {
    let cat = state.get(&project_root)?;
    blocking(move || ds::create(&*cat.lock().map_err(err)?, &kind, &dataset).map_err(err)).await
}

#[tauri::command]
pub async fn catalog_update_dataset(state: tauri::State<'_, CatalogState>, project_root: String, id: i64, dataset: ds::DatasetEdit) -> Result<(), String> {
    let cat = state.get(&project_root)?;
    blocking(move || ds::update(&*cat.lock().map_err(err)?, id, &dataset).map_err(err)).await
}

#[tauri::command]
pub async fn catalog_delete_dataset(state: tauri::State<'_, CatalogState>, project_root: String, id: i64) -> Result<(), String> {
    let cat = state.get(&project_root)?;
    blocking(move || ds::delete(&*cat.lock().map_err(err)?, id).map_err(err)).await
}

#[tauri::command]
pub async fn catalog_dataset_add(state: tauri::State<'_, CatalogState>, project_root: String, id: i64, selection: Selection, range: Option<[f64; 2]>) -> Result<usize, String> {
    let cat = state.get(&project_root)?;
    blocking(move || ds::add_members(&mut *cat.lock().map_err(err)?, id, &selection, range.map(|r| (r[0], r[1]))).map_err(err)).await
}

#[tauri::command]
pub async fn catalog_dataset_remove(state: tauri::State<'_, CatalogState>, project_root: String, id: i64, selection: Selection) -> Result<usize, String> {
    let cat = state.get(&project_root)?;
    blocking(move || ds::remove_members(&mut *cat.lock().map_err(err)?, id, &selection).map_err(err)).await
}

#[tauri::command]
pub async fn catalog_duplicate_dataset(state: tauri::State<'_, CatalogState>, project_root: String, id: i64, name: String, freeze: bool) -> Result<i64, String> {
    let cat = state.get(&project_root)?;
    blocking(move || ds::duplicate(&mut *cat.lock().map_err(err)?, id, &name, freeze).map_err(err)).await
}

#[tauri::command]
pub async fn catalog_recording_datasets(state: tauri::State<'_, CatalogState>, project_root: String, recording_id: i64) -> Result<Vec<ds::Membership>, String> {
    let cat = state.get(&project_root)?;
    blocking(move || ds::recording_datasets(&*cat.lock().map_err(err)?, recording_id).map_err(err)).await
}

#[tauri::command]
pub async fn catalog_dataset_remove_range(state: tauri::State<'_, CatalogState>, project_root: String, id: i64, recording_id: i64, range: [f64; 2]) -> Result<usize, String> {
    let cat = state.get(&project_root)?;
    blocking(move || ds::remove_range(&*cat.lock().map_err(err)?, id, recording_id, range[0], range[1]).map_err(err)).await
}
