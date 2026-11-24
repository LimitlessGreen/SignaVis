//! Dev tool: the Lite catalog commands over HTTP, for UI tests in a plain browser.
//! POST /<command> with the command's JSON args; same names/arguments as src-tauri-lite/src/catalog.rs.
//!
//! catalog-serve <port>

use aw_catalog::{
    Catalog, import_scanned, import_selection_tables, machine_name, preview::preview, profile_spec::ProfileSpec,
    query::{Cursor, Filter, Sort}, scan::{ScanResult, scan},
};
use aw_catalog::entities as ent;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::Path;

type R = Result<Value, String>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Args {
    project_root: Option<String>,
    source: Option<String>,
    profile: Option<ProfileSpec>,
    #[serde(default)]
    refresh: bool,
    root_name: Option<String>,
    #[serde(default)]
    import_tables: bool,
    #[serde(default)]
    filter: Filter,
    #[serde(default)]
    sort: Sort,
    after: Option<Cursor>,
    limit: Option<usize>,
    recording_id: Option<i64>,
    #[serde(default)]
    full: bool,
    site_id: Option<i64>,
    clock: Option<String>,
    device_id: Option<i64>,
    #[serde(default)]
    periods: Vec<aw_catalog::clock::ClockPeriod>,
    #[serde(default)]
    fields: Value,
    table: Option<String>,
    id: Option<i64>,
    #[serde(default)]
    from: Vec<i64>,
    into: Option<i64>,
    gap_days: Option<f64>,
    notes: Option<String>,
    #[serde(default)]
    selection: aw_catalog::entities::Selection,
    #[serde(default)]
    edit: aw_catalog::entities::BulkEdit,
    path: Option<String>,
    name: Option<String>,
    track_id: Option<i64>,
    max_gap_s: Option<f64>,
    cell_deg: Option<f64>,
    #[serde(default)]
    ids: Vec<i64>,
    spec: Option<aw_catalog::thumb::ThumbSpec>,
    kind: Option<String>,
    #[serde(default)]
    dataset: aw_catalog::datasets::DatasetEdit,
    range: Option<[f64; 2]>,
    #[serde(default)]
    freeze: bool,
    review: Option<String>,
    #[serde(default)]
    only_new: bool,
}

struct State { cats: HashMap<String, Catalog>, scans: HashMap<String, ScanResult> }

impl State {
    fn cat(&mut self, root: &Option<String>) -> Result<&mut Catalog, String> {
        let root = root.clone().ok_or("projectRoot missing")?;
        if !self.cats.contains_key(&root) {
            let c = Catalog::open(&Path::new(&root).join(".signavis/catalog.sqlite")).map_err(|e| e.to_string())?;
            self.cats.insert(root.clone(), c);
        }
        Ok(self.cats.get_mut(&root).unwrap())
    }
    fn scan(&mut self, a: &Args, refresh: bool) -> Result<&ScanResult, String> {
        let src = a.source.clone().ok_or("source missing")?;
        // Same rule as Lite: options validated first, cache per (folder, options).
        let opts = a.profile.as_ref().map(|p| p.scan_options()).transpose().map_err(|e| e.to_string())?.unwrap_or_default();
        let key = format!("{src}\n{}", a.profile.as_ref().map(|p| p.derived_dirs.join("\n")).unwrap_or_default());
        if refresh || !self.scans.contains_key(&key) {
            self.scans.insert(key.clone(), scan(Path::new(&src), &opts));
        }
        Ok(&self.scans[&key])
    }
}

fn handle(st: &mut State, cmd: &str, a: Args) -> R {
    use aw_catalog::datasets as ds;
    let e = |x: Box<dyn std::error::Error + Send + Sync>| x.to_string();
    let j = |v: Result<Value, serde_json::Error>| v.map_err(|x| x.to_string());
    match cmd {
        "catalog_preview" => {
            let p = a.profile.clone().ok_or("profile missing")?.build().map_err(|x| x.to_string())?;
            let s = st.scan(&a, a.refresh)?;
            j(serde_json::to_value(preview(s, &p, 200)))
        }
        "catalog_sites" => j(serde_json::to_value(aw_catalog::sites(st.cat(&a.project_root)?).map_err(e)?)),
        "catalog_set_site_clock" => {
            let c = aw_catalog::clock::Clock::parse(a.clock.as_deref().unwrap_or("")).ok_or("unknown clock")?;
            let cat = st.cat(&a.project_root)?;
            j(serde_json::to_value(aw_catalog::clock::set_site_clock(cat, a.site_id.ok_or("siteId missing")?, c).map_err(e)?))
        }
        "catalog_clock_shifts" => j(serde_json::to_value(aw_catalog::clock::detect_clock_shifts(st.cat(&a.project_root)?).map_err(e)?)),
        "catalog_device_clocks" => j(serde_json::to_value(aw_catalog::clock::device_clocks(st.cat(&a.project_root)?, a.device_id.ok_or("deviceId missing")?).map_err(e)?)),
        "catalog_set_device_clocks" => {
            let cat = st.cat(&a.project_root)?;
            j(serde_json::to_value(aw_catalog::clock::set_device_clocks(cat, a.device_id.ok_or("deviceId missing")?, &a.periods).map_err(e)?))
        }
        "catalog_devices" => j(serde_json::to_value(aw_catalog::devices(st.cat(&a.project_root)?).map_err(e)?)),
        "catalog_suggest" => {
            let s = st.scan(&a, a.refresh)?;
            j(serde_json::to_value(aw_catalog::suggest::suggest_for_scan(s, 6)))
        }
        "catalog_import" => {
            let spec = a.profile.clone().ok_or("profile missing")?;
            let p = spec.build().map_err(|x| x.to_string())?;
            let s = st.scan(&a, false)?.clone();
            let src = a.source.clone().unwrap();
            let cat = st.cat(&a.project_root)?;
            cat.save_profile(&spec).map_err(e)?;
            // Default name: the folder's own name (add_root refuses a name that points elsewhere).
            let fallback = Path::new(&src).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "source".into());
            let root_id = cat.add_root(a.root_name.as_deref().unwrap_or(&fallback), "referenced", &machine_name(), &src).map_err(e)?;
            let rec = aw_catalog::hash::reconcile(cat, root_id, Path::new(&src), &s.audio, Some(&p)).map_err(e)?;
            let r = import_scanned(cat, root_id, &rec.new_files, &p).map_err(e)?;
            let (mut tables, mut detections) = (0, 0);
            if a.import_tables && !s.selection_tables.is_empty() {
                let t = import_selection_tables(cat, Path::new(&src), root_id, &s.selection_tables, "BirdNET (imported)").map_err(e)?;
                (tables, detections) = (t.tables, t.detections);
            }
            Ok(json!({ "rootId": root_id, "inserted": r.inserted, "alreadyKnown": r.already_known + rec.unchanged,
                "moved": rec.moved.len(), "movedExamples": rec.moved, "missing": rec.missing.len(), "changed": rec.changed.len(),
                "unmatched": r.unmatched.len(), "noStart": r.no_start, "tables": tables, "detections": detections }))
        }
        "catalog_profiles" => j(serde_json::to_value(st.cat(&a.project_root)?.profiles().map_err(e)?)),
        "catalog_roots" => j(serde_json::to_value(aw_catalog::roots(st.cat(&a.project_root)?, &machine_name()).map_err(e)?)),
        "catalog_exists" => Ok(json!(true)),   // the test server always serves a catalog
        "catalog_facets" => j(serde_json::to_value(aw_catalog::query::facets(st.cat(&a.project_root)?, &a.filter).map_err(e)?)),
        "catalog_heatmap" => j(serde_json::to_value(aw_catalog::query::heatmap(st.cat(&a.project_root)?, &a.filter).map_err(e)?)),
        "catalog_list" => j(serde_json::to_value(aw_catalog::query::list(
            st.cat(&a.project_root)?, &a.filter, a.sort, a.after.as_ref(), a.limit.unwrap_or(200).clamp(1, 2000)).map_err(e)?)),
        "catalog_recording_path" => {
            let p = aw_catalog::recording_path(st.cat(&a.project_root)?, a.recording_id.ok_or("recordingId missing")?, &machine_name()).map_err(e)?;
            Ok(json!(p.map(|p| p.to_string_lossy().into_owned())))
        }
        // Synchronous here (dev tool); Lite runs it as a background job with progress events.
        "catalog_hash_start" => {
            let cat = st.cat(&a.project_root)?;
            for r in aw_catalog::roots(cat, &machine_name()).map_err(e)? {
                if let Some(base) = r.path {
                    let todo = aw_catalog::header::header_todo(cat, r.id).map_err(e)?;
                    let (infos, _) = aw_catalog::header::read_batch(Path::new(&base), &todo, &std::sync::atomic::AtomicBool::new(false));
                    aw_catalog::header::store_infos(cat, &infos).map_err(e)?;
                    let kinds = if a.full { vec![aw_catalog::hash::HashKind::Quick, aw_catalog::hash::HashKind::Full] } else { vec![aw_catalog::hash::HashKind::Quick] };
                    for k in kinds {
                        aw_catalog::hash::hash_missing(cat, r.id, Path::new(&base), k, &std::sync::atomic::AtomicBool::new(false), &mut |_, _| {}).map_err(e)?;
                    }
                }
            }
            Ok(Value::Null)
        }
        "catalog_hash_cancel" => Ok(Value::Null),
        "catalog_integrity" => {
            let cat = st.cat(&a.project_root)?;
            let n = |sql: &str| aw_catalog::count(cat, sql).map_err(e);
            let (groups, dups) = aw_catalog::hash::duplicates(cat, 50).map_err(e)?;
            Ok(json!({
                "hashed": n("SELECT COUNT(*) FROM asset WHERE quick_hash IS NOT NULL")?,
                "noHeader": n(aw_catalog::header::PENDING_HEADERS_SQL)?,
                "fullHashed": n("SELECT COUNT(*) FROM asset WHERE full_hash IS NOT NULL")?,
                "fullUnhashed": n("SELECT COUNT(*) FROM asset WHERE full_hash IS NULL AND status != 'missing'")?,
                "bytesWithoutChecksum": n("SELECT COALESCE(SUM(size), 0) FROM asset WHERE full_hash IS NULL AND status != 'missing'")?,
                "unhashed": n("SELECT COUNT(*) FROM asset WHERE quick_hash IS NULL AND status != 'missing'")?,
                "missing": n("SELECT COUNT(*) FROM asset WHERE status = 'missing'")?,
                "changed": n("SELECT COUNT(*) FROM asset WHERE status = 'changed'")?,
                "duplicateGroups": groups, "duplicates": dups, "hashing": false,
            }))
        }
        "catalog_site_fields" => j(serde_json::to_value(ent::site_fields(st.cat(&a.project_root)?, a.site_id.ok_or("siteId missing")?).map_err(e)?)),
        "catalog_save_site" => {
            let f: ent::SiteFields = serde_json::from_value(a.fields.clone()).map_err(|x| x.to_string())?;
            Ok(json!(ent::save_site(st.cat(&a.project_root)?, a.site_id, &f).map_err(e)?))
        }
        "catalog_device_fields" => j(serde_json::to_value(ent::device_fields(st.cat(&a.project_root)?, a.device_id.ok_or("deviceId missing")?).map_err(e)?)),
        "catalog_save_device" => {
            let f: ent::DeviceFields = serde_json::from_value(a.fields.clone()).map_err(|x| x.to_string())?;
            Ok(json!(ent::save_device(st.cat(&a.project_root)?, a.device_id, &f).map_err(e)?))
        }
        "catalog_delete_entity" => {
            ent::delete_entity(st.cat(&a.project_root)?, a.table.as_deref().unwrap_or(""), a.id.ok_or("id missing")?).map_err(e)?;
            Ok(Value::Null)
        }
        "catalog_merge" => Ok(json!(ent::merge(st.cat(&a.project_root)?, a.table.as_deref().unwrap_or(""), &a.from, a.into.ok_or("into missing")?).map_err(e)?)),
        "catalog_derive_deployments" => j(serde_json::to_value(ent::derive_deployments(st.cat(&a.project_root)?, a.gap_days.unwrap_or(3.0)).map_err(e)?)),
        "catalog_deployments" => j(serde_json::to_value(ent::deployments(st.cat(&a.project_root)?).map_err(e)?)),
        "catalog_set_deployment_notes" => {
            ent::set_deployment_notes(st.cat(&a.project_root)?, a.id.ok_or("id missing")?, a.notes.as_deref()).map_err(e)?;
            Ok(Value::Null)
        }
        "catalog_tags" => j(serde_json::to_value(ent::tags(st.cat(&a.project_root)?).map_err(e)?)),
        "catalog_meta_keys" => j(serde_json::to_value(ent::meta_keys(st.cat(&a.project_root)?).map_err(e)?)),
        "catalog_bulk_edit" => j(serde_json::to_value(ent::bulk_edit(st.cat(&a.project_root)?, &a.selection, &a.edit).map_err(e)?)),
        "catalog_set_review" => j(serde_json::to_value(aw_catalog::review::set_review(st.cat(&a.project_root)?, &a.ids, a.review.as_deref(), a.only_new).map_err(e)?)),
        "catalog_recording_detail" => j(serde_json::to_value(ent::recording_detail(st.cat(&a.project_root)?, a.recording_id.ok_or("recordingId missing")?).map_err(e)?)),
        "catalog_thumbs" => {
            st.cat(&a.project_root)?;
            let root = a.project_root.clone().unwrap();
            let m = std::sync::Mutex::new(st.cats.remove(&root).unwrap());
            let spec = a.spec.ok_or("spec missing")?;
            let out = aw_catalog::thumb::thumbs(&m, &a.ids, spec, &machine_name());
            st.cats.insert(root, m.into_inner().map_err(|x| x.to_string())?);
            j(serde_json::to_value(out))
        }
        "catalog_thumbs_clear" => j(serde_json::to_value(aw_catalog::thumb::clear(st.cat(&a.project_root)?).map_err(e)?)),
        "catalog_stats" => j(serde_json::to_value(aw_catalog::stats::stats(st.cat(&a.project_root)?, &a.filter, 25).map_err(e)?)),
        "catalog_import_track" => {
            let path = a.path.clone().ok_or("path missing")?;
            let text = std::fs::read_to_string(&path).map_err(|x| x.to_string())?;
            let (pts, untimed, invalid) = aw_catalog::geo::parse_gpx(&text).map_err(e)?;
            let name = a.name.clone().unwrap_or_else(|| Path::new(&path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default());
            let cat = st.cat(&a.project_root)?;
            let id = aw_catalog::geo::save_track(cat, &name, Some(&path), a.device_id, &pts).map_err(e)?;
            let m = aw_catalog::geo::match_track(cat, id, &a.selection, a.max_gap_s.unwrap_or(120.0)).map_err(e)?;
            Ok(json!({ "trackId": id, "points": pts.len(), "untimed": untimed, "invalid": invalid, "match": m }))
        }
        "catalog_match_track" => j(serde_json::to_value(aw_catalog::geo::match_track(st.cat(&a.project_root)?, a.track_id.ok_or("trackId missing")?, &a.selection, a.max_gap_s.unwrap_or(120.0)).map_err(e)?)),
        "catalog_tracks" => j(serde_json::to_value(aw_catalog::geo::tracks(st.cat(&a.project_root)?).map_err(e)?)),
        "catalog_track_line" => j(serde_json::to_value(aw_catalog::geo::track_line(st.cat(&a.project_root)?, a.track_id.ok_or("trackId missing")?, 2000).map_err(e)?)),
        "catalog_delete_track" => { aw_catalog::geo::delete_track(st.cat(&a.project_root)?, a.track_id.ok_or("trackId missing")?).map_err(e)?; Ok(Value::Null) }
        "catalog_map" => j(serde_json::to_value(aw_catalog::geo::map_data(st.cat(&a.project_root)?, &a.filter, a.cell_deg.unwrap_or(0.001)).map_err(e)?)),
        "catalog_datasets" => j(serde_json::to_value(ds::list(st.cat(&a.project_root)?).map_err(e)?)),
        "catalog_create_dataset" => Ok(json!(ds::create(st.cat(&a.project_root)?, a.kind.as_deref().unwrap_or("static"), &a.dataset).map_err(e)?)),
        "catalog_update_dataset" => { ds::update(st.cat(&a.project_root)?, a.id.ok_or("id missing")?, &a.dataset).map_err(e)?; Ok(Value::Null) }
        "catalog_delete_dataset" => { ds::delete(st.cat(&a.project_root)?, a.id.ok_or("id missing")?).map_err(e)?; Ok(Value::Null) }
        "catalog_dataset_add" => Ok(json!(ds::add_members(st.cat(&a.project_root)?, a.id.ok_or("id missing")?, &a.selection, a.range.map(|r| (r[0], r[1]))).map_err(e)?)),
        "catalog_dataset_remove" => Ok(json!(ds::remove_members(st.cat(&a.project_root)?, a.id.ok_or("id missing")?, &a.selection).map_err(e)?)),
        "catalog_duplicate_dataset" => Ok(json!(ds::duplicate(st.cat(&a.project_root)?, a.id.ok_or("id missing")?, a.name.as_deref().unwrap_or(""), a.freeze).map_err(e)?)),
        "catalog_dataset_remove_range" => {
            let r = a.range.ok_or("range missing")?;
            Ok(json!(ds::remove_range(st.cat(&a.project_root)?, a.id.ok_or("id missing")?, a.recording_id.ok_or("recordingId missing")?, r[0], r[1]).map_err(e)?))
        }
        "catalog_recording_datasets" => j(serde_json::to_value(ds::recording_datasets(st.cat(&a.project_root)?, a.recording_id.ok_or("recordingId missing")?).map_err(e)?)),
        _ => Err(format!("unknown command {cmd}")),
    }
}

/// Largest request body accepted (the biggest real one, an import profile, is a few kB).
const MAX_BODY: usize = 16 << 20;

fn main() {
    let port: u16 = std::env::args().nth(1).and_then(|p| p.parse().ok()).unwrap_or(5199);
    // Only the test page may call: a token per run (env CATALOG_SERVE_TOKEN or random, printed), sent
    // as header x-catalog-token; CORS only for the harness origin (env CATALOG_SERVE_ORIGIN).
    let token = std::env::var("CATALOG_SERVE_TOKEN").unwrap_or_else(|_| aw_catalog::new_uid());
    let origin = std::env::var("CATALOG_SERVE_ORIGIN").unwrap_or_else(|_| "http://127.0.0.1:5187".into());
    let listener = TcpListener::bind(("127.0.0.1", port)).expect("bind");
    eprintln!("catalog-serve on http://127.0.0.1:{port} for {origin}, token {token}");
    let mut st = State { cats: HashMap::new(), scans: HashMap::new() };
    for stream in listener.incoming().flatten() {
        let mut stream = stream;
        // A client that stops halfway does not block the next one.
        let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() { continue; }
        let mut parts = line.split_whitespace();
        let (method, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or("/").to_string());
        let (mut len, mut sent_token) = (0usize, String::new());
        let mut bad_len = false;
        loop {
            let mut h = String::new();
            if reader.read_line(&mut h).is_err() || h == "\r\n" || h.is_empty() { break; }
            let lower = h.to_ascii_lowercase();
            if let Some(v) = lower.strip_prefix("content-length:") {
                match v.trim().parse::<usize>() { Ok(n) if n <= MAX_BODY => len = n, _ => bad_len = true }
            }
            if lower.starts_with("x-catalog-token:") { sent_token = h["x-catalog-token:".len()..].trim().to_string(); }
        }
        let mut body = vec![0; if bad_len { 0 } else { len }];
        let complete = !bad_len && reader.read_exact(&mut body).is_ok();
        let (status, out) = if method == "OPTIONS" { ("204 No Content", String::new()) }
        else if !complete { ("400 Bad Request", json!("incomplete or too large request").to_string()) }
        else if sent_token != token { ("403 Forbidden", json!("missing or wrong x-catalog-token").to_string()) }
        else {
            let res = serde_json::from_slice::<Args>(&body).map_err(|x| x.to_string())
                .and_then(|a| handle(&mut st, path.trim_start_matches('/'), a));
            match res {
                Ok(v) => ("200 OK", v.to_string()),
                Err(m) => ("500 Error", json!(m).to_string()),
            }
        };
        let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: {origin}\r\nAccess-Control-Allow-Headers: content-type, x-catalog-token\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}", out.len());
    }
}
