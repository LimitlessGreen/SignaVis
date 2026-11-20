//! Phase-0 measurement: scan a folder, import with path templates, import selection tables,
//! add synthetic labels, time typical queries, report sizes.
//!
//! catalog-bench <root> <catalog.sqlite> --pattern T [--pattern T2 …]
//!     [--map field=site|device|start|date|time|ignore|meta:key[,format with {}]] [--utc-offset MIN]
//!     [--synthetic-labels N]

use aw_catalog::{*, pattern::PatternSet, scan};
use rusqlite::params;
use std::path::PathBuf;
use std::time::Instant;

fn timed<T>(what: &str, f: impl FnOnce() -> T) -> T {
    let t = Instant::now();
    let r = f();
    println!("{:>9.1} ms  {what}", t.elapsed().as_secs_f64() * 1e3);
    r
}

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let root = PathBuf::from(args.next().ok_or("root missing")?);
    let db = PathBuf::from(args.next().ok_or("catalog path missing")?);
    let (mut templates, mut mappings, mut n_labels, mut offset) = (Vec::new(), Vec::new(), 100_000usize, 0i32);
    while let Some(a) = args.next() {
        let v = args.next().ok_or_else(|| format!("{a} needs a value"))?;
        match a.as_str() {
            "--pattern" => templates.push(v),
            "--synthetic-labels" => n_labels = v.parse()?,
            "--utc-offset" => offset = v.parse()?,
            "--map" => {
                let (field, rest) = v.split_once('=').ok_or("--map field=role")?;
                let (role, format) = match rest.split_once(',') { Some((r, f)) => (r, Some(f)), None => (rest, None) };
                let role = match role {
                    "site" => FieldRole::Site, "device" => FieldRole::Device, "start" => FieldRole::Start,
                    "date" => FieldRole::StartDate, "time" => FieldRole::StartTime, "ignore" => FieldRole::Ignore,
                    r if r.starts_with("meta:") => FieldRole::Meta(r[5..].to_string()),
                    r => return Err(format!("unknown role {r}").into()),
                };
                let mut m = FieldMapping::new(field, role);
                if let Some(f) = format { m = m.with_format(f); }
                mappings.push(m);
            }
            _ => return Err(format!("unknown option {a}").into()),
        }
    }
    if templates.is_empty() { return Err("at least one --pattern".into()); }
    let refs: Vec<&str> = templates.iter().map(|s| s.as_str()).collect();
    let opts = ImportProfile { name: "bench".into(), patterns: PatternSet::parse(&refs)?, mappings, utc_offset_min: offset, tz: None };
    let _ = std::fs::remove_file(&db);

    let res = timed("scan (cold or warm cache, see note)", || scan::scan(&root, &scan::ScanOptions::default()));
    println!("           audio {}, selection tables {}, skipped dirs {}, errors {}",
        res.audio.len(), res.selection_tables.len(), res.skipped_dirs.len(), res.errors.len());
    for d in res.skipped_dirs.iter().take(8) { println!("           skip {d}"); }

    let pv = timed("preview (100 samples)", || aw_catalog::preview::preview(&res, &opts, 100));
    println!("           per pattern {:?}, unmatched {} in {} folders", pv.per_pattern, pv.unmatched, pv.unmatched_groups.len());
    for g in &pv.groups { println!("           {:?} / {:?}: {} files, {} … {}", g.site, g.device, g.files, g.first.as_deref().unwrap_or("-"), g.last.as_deref().unwrap_or("-")); }
    for i in &pv.issues { println!("           issue {} × {} e.g. {:?}", i.kind, i.count, i.examples.first()); }
    let mut cat = Catalog::open(&db)?;
    let root_id = cat.add_root("aufnahmen", "referenced", "bench", &root.to_string_lossy())?;
    let rep = timed("import audio (one transaction)", || import_scanned(&mut cat, root_id, &res.audio, &opts))?;
    println!("           inserted {}, per pattern {:?}, unmatched {}, no start {}", rep.inserted, rep.per_pattern, rep.unmatched.len(), rep.no_start);
    for u in rep.unmatched.iter().take(5) { println!("           unmatched {u}"); }
    let rep2 = timed("re-import (all known)", || import_scanned(&mut cat, root_id, &res.audio, &opts))?;
    println!("           already known {}", rep2.already_known);

    let tr = timed("import selection tables", || import_selection_tables(&mut cat, &root, root_id, &res.selection_tables, "BirdNET (imported)"))?;
    println!("           tables {}, detections {}, unmatched {}", tr.tables, tr.detections, tr.unmatched_tables.len());

    timed(&format!("insert {n_labels} synthetic labels"), || -> Result<()> {
        let tx = cat.conn.transaction()?;
        tx.execute("INSERT INTO label_set(uid, name, created_at, updated_at) VALUES (?1, 'bench', 0, 0)", [new_uid()])?;
        let set = tx.last_insert_rowid();
        let n_rec: i64 = tx.query_row("SELECT MAX(id) FROM recording", [], |r| r.get(0))?;
        {
            let mut ins = tx.prepare("INSERT INTO label(uid, label_set_id, recording_id, t0, t1, class, polarity, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0)")?;
            let classes = ["eurpyo1", "tawowl1", "boreowl", "noise"];
            let pol = ["present", "present", "absent", "unsure"];
            for i in 0..n_labels {
                let rec = (i as i64 * 7919) % n_rec + 1;
                let t0 = (i % 12) as f64 * 5.0;
                ins.execute(params![new_uid(), set, rec, t0, t0 + 5.0, classes[i % 4], pol[(i / 4) % 4]])?;
            }
        }
        tx.commit()?;
        Ok(())
    })?;
    cat.conn.execute_batch("ANALYZE")?;

    println!("\nqueries:");
    let q = |label: &str, sql: &str| -> Result<()> {
        let t = Instant::now();
        let mut st = cat.conn.prepare(sql)?;
        let n = st.query_map([], |_| Ok(()))?.count();
        println!("{:>9.2} ms  {label} → {n} rows", t.elapsed().as_secs_f64() * 1e3);
        Ok(())
    };
    q("stats per site × week (files, hours)",
      "SELECT s.name, r.start_ms / 604800000, COUNT(*), SUM(a.size) FROM recording r JOIN site s ON s.id = r.site_id
       JOIN asset a ON a.id = r.asset_id GROUP BY 1, 2")?;
    q("calendar heatmap day × hour, all",
      "SELECT start_ms / 86400000, (start_ms / 3600000) % 24, COUNT(*) FROM recording GROUP BY 1, 2")?;
    q("filter: site 2, night (UTC 17–05), March",
      "SELECT r.id FROM recording r JOIN site s ON s.id = r.site_id WHERE s.id = 1
       AND r.start_ms BETWEEN 1677628800000 AND 1680307200000 AND ((r.start_ms / 3600000) % 24 >= 17 OR (r.start_ms / 3600000) % 24 < 5)")?;
    q("detections class X score ≥ 0.5 with path",
      "SELECT a.rel_path, d.t0, d.score FROM detection d JOIN recording r ON r.id = d.recording_id
       JOIN asset a ON a.id = r.asset_id WHERE d.run_id = 1 AND d.class = 'eurpyo1' AND d.score >= 0.5 ORDER BY d.score DESC")?;
    q("top classes of run (count)",
      "SELECT class, COUNT(*) FROM detection WHERE run_id = 1 GROUP BY class ORDER BY 2 DESC")?;
    q("recordings with detection ≥ 0.8 but no present label",
      "SELECT DISTINCT d.recording_id FROM detection d WHERE d.score >= 0.8 AND NOT EXISTS
       (SELECT 1 FROM label l WHERE l.recording_id = d.recording_id AND l.polarity = 'present')")?;
    q("labels of one recording", "SELECT * FROM label WHERE recording_id = 4242")?;
    q("table page (sorted by time, offset 50000, 200 rows)",
      "SELECT r.id, a.rel_path, r.start_ms FROM recording r JOIN asset a ON a.id = r.asset_id ORDER BY r.start_ms LIMIT 200 OFFSET 50000")?;

    let night = aw_catalog::query::Filter { hour_from: Some(18), hour_to: Some(7), ..Default::default() };
    let fc = timed("facets, local night 18–07", || aw_catalog::query::facets(&cat, &night))?;
    println!("           total {}, sites {:?}", fc.total, fc.sites.iter().map(|s| (&s.name, s.count)).collect::<Vec<_>>());
    let mut cur = None;
    let mut pages = 0;
    timed("keyset paging through night, 500 per page", || -> Result<()> {
        loop {
            let pg = aw_catalog::query::list(&cat, &night, aw_catalog::query::Sort::Start, cur.as_ref(), 500)?;
            pages += 1;
            match pg.next { Some(c) => cur = Some(c), None => break Ok(()) }
        }
    })?;
    println!("           {pages} pages");
    let t = Instant::now();
    cat.conn.execute("UPDATE label SET class = 'tawowl1', updated_at = 1 WHERE id = 12345", [])?;
    println!("{:>9.2} ms  single label update (autocommit, WAL)", t.elapsed().as_secs_f64() * 1e3);

    drop(cat);
    let size = std::fs::metadata(&db)?.len();
    println!("\ncatalog size {:.1} MB ({})", size as f64 / 1e6, db.display());
    Ok(())
}
