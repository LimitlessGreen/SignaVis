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
    /// Last scan per source folder (preview → import without scanning twice).
    scans: Mutex<HashMap<String, Arc<ScanResult>>>,
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

    fn scan(&self, source: &str, spec: &ProfileSpec, refresh: bool) -> Result<Arc<ScanResult>, String> {
        if !refresh {
            if let Some(s) = self.scans.lock().map_err(err)?.get(source) { return Ok(s.clone()); }
        }
        let dir = PathBuf::from(source);
        if !dir.is_dir() { return Err(format!("not a folder: {source}")); }
        let s = Arc::new(scan(&dir, &spec.scan_options().map_err(err)?));
        self.scans.lock().map_err(err)?.insert(source.to_string(), s.clone());
        Ok(s)
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
    let scanned = state.scan(&source, &profile, refresh)?;
    blocking(move || Ok(preview(&scanned, &built, 200))).await
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
    let scanned = state.scan(&source, &profile, false)?;
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HashProgress { project_root: String, kind: HashKind, done: usize, total: usize, finished: bool, failed: usize }

/// Background job over all roots located on this machine: quick hashes (fingerprints), and with
/// `full` afterwards SHA-256 checksums of the whole files. Progress as HASH_EVENT; resumable
/// (commits in batches); one job at a time.
#[tauri::command]
pub async fn catalog_hash_start(app: tauri::AppHandle, state: tauri::State<'_, CatalogState>, project_root: String, full: bool) -> Result<(), String> {
    if state.hash_running.swap(true, Ordering::SeqCst) { return Err("hashing is already running".into()); }
    state.hash_cancel.store(false, Ordering::SeqCst);
    let (cat, cancel, running) = (state.get(&project_root)?, state.hash_cancel.clone(), state.hash_running.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| -> Result<(), String> {
            let roots = aw_catalog::roots(&*cat.lock().map_err(err)?, &machine_name()).map_err(err)?;
            let mut failed = 0;
            let kinds: &[HashKind] = if full { &[HashKind::Quick, HashKind::Full] } else { &[HashKind::Quick] };
            'all: for &kind in kinds {
                for r in &roots {
                    let Some(base) = r.path.clone() else { continue };
                    let todo = aw_catalog::hash::hash_todo(&*cat.lock().map_err(err)?, r.id, kind).map_err(err)?;
                    let batch = if kind == HashKind::Full { 20 } else { aw_catalog::hash::HASH_BATCH };
                    // Read the files without holding the catalog; lock only to store each batch.
                    for (i, chunk) in todo.chunks(batch).enumerate() {
                        let mut rep = aw_catalog::hash::HashReport::default();
                        let done = aw_catalog::hash::hash_batch(Path::new(&base), kind, chunk, &cancel, &mut rep);
                        aw_catalog::hash::store_hashes(&mut *cat.lock().map_err(err)?, kind, &done).map_err(err)?;
                        failed += rep.failed.len();
                        let _ = app.emit(HASH_EVENT, HashProgress {
                            project_root: project_root.clone(), kind, done: i * batch + chunk.len(), total: todo.len(), finished: false, failed,
                        });
                        if rep.cancelled { break 'all; }
                    }
                }
            }
            let _ = app.emit(HASH_EVENT, HashProgress { project_root: project_root.clone(), kind: HashKind::Quick, done: 0, total: 0, finished: true, failed });
            Ok(())
        })();
        running.store(false, Ordering::SeqCst);
        if let Err(e) = result { eprintln!("[catalog] hashing failed: {e}"); }
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
            full_hashed: n("SELECT COUNT(*) FROM asset WHERE full_hash IS NOT NULL")?,
            full_unhashed: n("SELECT COUNT(*) FROM asset WHERE full_hash IS NULL AND status != 'missing'")?,
            bytes_without_checksum: n("SELECT COALESCE(SUM(size), 0) FROM asset WHERE full_hash IS NULL AND status != 'missing'")?,
            missing: n("SELECT COUNT(*) FROM asset WHERE status = 'missing'")?,
            changed: n("SELECT COUNT(*) FROM asset WHERE status = 'changed'")?,
            duplicate_groups: groups, duplicates: dups, hashing,
        })
    }).await
}
