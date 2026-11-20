//! Phase-0 measurement: scan a folder, import with path templates, import selection tables,
//! add synthetic labels, time typical queries, report sizes.
//!
//! catalog-bench <root> <catalog.sqlite> [--synthetic-labels N] [pattern ...]

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
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut n_labels = 100_000usize;
    if let Some(i) = args.iter().position(|a| a == "--synthetic-labels") {
        n_labels = args[i + 1].parse()?;
        args.drain(i..=i + 1);
    }
    let root = PathBuf::from(&args[0]);
    let db = PathBuf::from(&args[1]);
    let templates: Vec<&str> = if args.len() > 2 { args[2..].iter().map(|s| s.as_str()).collect() } else {
        vec![
            "Rekorder_{recorder}_Standort_{site}/Woche_{week:int}*/SK{recorder}_{start:%Y_%m_%d_%H_%M_%S}.wav",
            "Rekorder_{*}_Standort_{*}/Rekorder_{recorder}_Standort_{site}/Woche_{week:int}*/SK{recorder}_{start:%Y_%m_%d_%H_%M_%S}.wav",
        ]
    };
    let _ = std::fs::remove_file(&db);

    let res = timed("scan (cold or warm cache, see note)", || scan::scan(&root, &scan::ScanOptions::default()));
    println!("           audio {}, selection tables {}, skipped dirs {}, errors {}",
        res.audio.len(), res.selection_tables.len(), res.skipped_dirs.len(), res.errors.len());
    for d in res.skipped_dirs.iter().take(8) { println!("           skip {d}"); }

    let mut cat = Catalog::open(&db)?;
    let root_id = cat.add_root("aufnahmen", "referenced", "bench", &root.to_string_lossy())?;
    let opts = ImportOptions {
        patterns: PatternSet::parse(&templates)?,
        site_field: Some(("site".into(), "Standort ".into())),
        device_field: Some(("recorder".into(), "Rekorder ".into())),
        utc_offset_min: 60,
        tz: Some("Europe/Berlin".into()),
    };
    let rep = timed("import audio (one transaction)", || import_scanned(&mut cat, root_id, &res.audio, &opts))?;
    println!("           inserted {}, per pattern {:?}, unmatched {}", rep.inserted, rep.per_pattern, rep.unmatched.len());
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
      "SELECT s.name, m.value, COUNT(*), SUM(a.size) FROM recording r JOIN site s ON s.id = r.site_id
       JOIN meta m ON m.recording_id = r.id AND m.key = 'week' JOIN asset a ON a.id = r.asset_id GROUP BY 1, 2")?;
    q("calendar heatmap day × hour, all",
      "SELECT start_ms / 86400000, (start_ms / 3600000) % 24, COUNT(*) FROM recording GROUP BY 1, 2")?;
    q("filter: site 2, night (UTC 17–05), March",
      "SELECT r.id FROM recording r JOIN site s ON s.id = r.site_id WHERE s.name = 'Standort 2'
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

    let t = Instant::now();
    cat.conn.execute("UPDATE label SET class = 'tawowl1', updated_at = 1 WHERE id = 12345", [])?;
    println!("{:>9.2} ms  single label update (autocommit, WAL)", t.elapsed().as_secs_f64() * 1e3);

    drop(cat);
    let size = std::fs::metadata(&db)?.len();
    println!("\ncatalog size {:.1} MB ({})", size as f64 / 1e6, db.display());
    Ok(())
}
