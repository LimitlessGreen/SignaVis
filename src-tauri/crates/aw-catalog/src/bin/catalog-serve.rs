//! Dev tool: the Lite catalog commands over HTTP, for UI tests in a plain browser.
//! POST /<command> with the command's JSON args; same names/arguments as src-tauri-lite/src/catalog.rs.
//!
//! catalog-serve <port>

use aw_catalog::{
    Catalog, import_scanned, import_selection_tables, machine_name, preview::preview, profile_spec::ProfileSpec,
    query::{Cursor, Filter, Sort}, scan::{ScanResult, scan},
};
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
        if refresh || !self.scans.contains_key(&src) {
            let opts = a.profile.as_ref().map(|p| p.scan_options()).transpose().map_err(|e| e.to_string())?.unwrap_or_default();
            self.scans.insert(src.clone(), scan(Path::new(&src), &opts));
        }
        Ok(&self.scans[&src])
    }
}

fn handle(st: &mut State, cmd: &str, a: Args) -> R {
    let e = |x: Box<dyn std::error::Error + Send + Sync>| x.to_string();
    let j = |v: Result<Value, serde_json::Error>| v.map_err(|x| x.to_string());
    match cmd {
        "catalog_preview" => {
            let p = a.profile.clone().ok_or("profile missing")?.build().map_err(|x| x.to_string())?;
            let s = st.scan(&a, a.refresh)?;
            j(serde_json::to_value(preview(s, &p, 200)))
        }
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
            let root_id = cat.add_root(a.root_name.as_deref().unwrap_or("source"), "referenced", &machine_name(), &src).map_err(e)?;
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
                "fullHashed": n("SELECT COUNT(*) FROM asset WHERE full_hash IS NOT NULL")?,
                "fullUnhashed": n("SELECT COUNT(*) FROM asset WHERE full_hash IS NULL AND status != 'missing'")?,
                "bytesWithoutChecksum": n("SELECT COALESCE(SUM(size), 0) FROM asset WHERE full_hash IS NULL AND status != 'missing'")?,
                "unhashed": n("SELECT COUNT(*) FROM asset WHERE quick_hash IS NULL AND status != 'missing'")?,
                "missing": n("SELECT COUNT(*) FROM asset WHERE status = 'missing'")?,
                "changed": n("SELECT COUNT(*) FROM asset WHERE status = 'changed'")?,
                "duplicateGroups": groups, "duplicates": dups, "hashing": false,
            }))
        }
        _ => Err(format!("unknown command {cmd}")),
    }
}

fn main() {
    let port: u16 = std::env::args().nth(1).and_then(|p| p.parse().ok()).unwrap_or(5199);
    let listener = TcpListener::bind(("127.0.0.1", port)).expect("bind");
    eprintln!("catalog-serve on http://127.0.0.1:{port}");
    let mut st = State { cats: HashMap::new(), scans: HashMap::new() };
    for stream in listener.incoming().flatten() {
        let mut stream = stream;
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() { continue; }
        let mut parts = line.split_whitespace();
        let (method, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or("/").to_string());
        let mut len = 0;
        loop {
            let mut h = String::new();
            if reader.read_line(&mut h).is_err() || h == "\r\n" || h.is_empty() { break; }
            if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") { len = v.trim().parse().unwrap_or(0); }
        }
        let mut body = vec![0; len];
        let _ = reader.read_exact(&mut body);
        let (status, out) = if method == "OPTIONS" { ("204 No Content", String::new()) } else {
            let res = serde_json::from_slice::<Args>(&body).map_err(|x| x.to_string())
                .and_then(|a| handle(&mut st, path.trim_start_matches('/'), a));
            match res {
                Ok(v) => ("200 OK", v.to_string()),
                Err(m) => ("500 Error", json!(m).to_string()),
            }
        };
        let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}", out.len());
    }
}
