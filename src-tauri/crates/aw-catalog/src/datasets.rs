//! Datasets: named selections of library recordings. Static datasets list their members (whole
//! recordings or time ranges of them); dynamic ones store a library filter and follow the catalog.
//! A recording can be in any number of datasets without being copied.

use crate::entities::{Selection, selected_ids};
use crate::query::{self, Filter};
use crate::{Catalog, Result, new_uid, now_ms};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetInfo {
    pub id: i64,
    pub uid: String,
    pub name: String,
    pub description: Option<String>,
    /// static / filter
    pub kind: String,
    pub filter: Option<Filter>,
    pub color: Option<String>,
    /// Recordings in the dataset (for dynamic ones: matching now).
    pub recordings: i64,
    /// Static members that are a time range, not the whole recording.
    pub ranges: i64,
    pub seconds: Option<f64>,
    pub created_at: i64,
    pub updated_at: i64,
    /// Set when the saved filter cannot be evaluated (e.g. refers to a deleted dataset).
    pub error: Option<String>,
}

/// New dataset or changes to one (`None` = keep).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DatasetEdit {
    pub name: Option<String>,
    pub description: Option<String>,
    pub color: Option<String>,
    /// Only for dynamic datasets.
    pub filter: Option<Filter>,
}

fn clean(s: &Option<String>) -> Option<String> { s.as_deref().map(str::trim).filter(|x| !x.is_empty()).map(String::from) }

fn check_name(cat: &Catalog, name: &str, except: Option<i64>) -> Result<String> {
    let n = name.trim();
    if n.is_empty() { return Err("dataset name must not be empty".into()); }
    let clash: Option<i64> = cat.conn.query_row(
        "SELECT id FROM dataset WHERE name = ?1 COLLATE NOCASE AND id IS NOT ?2", params![n, except], |r| r.get(0)).optional()?;
    if clash.is_some() { return Err(format!("a dataset named \"{n}\" exists already").into()); }
    Ok(n.to_string())
}

/// A filter that only narrows to the dataset itself would be a loop; nested datasets are fine.
fn check_filter(cat: &Catalog, f: &Filter, own: Option<i64>) -> Result<String> {
    if own.is_some() && f.dataset_id == own { return Err("a dataset's filter cannot refer to the dataset itself".into()); }
    let json = serde_json::to_string(f)?;
    if let Some(id) = own {
        // Evaluate once with the new filter in place to catch indirect cycles before saving.
        let tx = cat.conn.unchecked_transaction()?;
        tx.execute("UPDATE dataset SET filter_json = ?1 WHERE id = ?2", params![json, id])?;
        let r = query::ids(cat, &Filter { dataset_id: Some(id), ..Default::default() });
        tx.rollback()?;
        r?;
    } else {
        query::ids(cat, f)?;
    }
    Ok(json)
}

pub fn create(cat: &Catalog, kind: &str, e: &DatasetEdit) -> Result<i64> {
    if kind != "static" && kind != "filter" { return Err(format!("unknown dataset kind {kind}").into()); }
    let name = check_name(cat, e.name.as_deref().unwrap_or(""), None)?;
    let filter_json = match (kind, &e.filter) {
        ("filter", Some(f)) => Some(check_filter(cat, f, None)?),
        ("filter", None) => return Err("a dynamic dataset needs a filter".into()),
        _ => None,
    };
    let now = now_ms();
    cat.conn.execute(
        "INSERT INTO dataset(uid, name, description, kind, filter_json, color, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![new_uid(), name, clean(&e.description), kind, filter_json, clean(&e.color), now])?;
    Ok(cat.conn.last_insert_rowid())
}

fn kind_of(cat: &Catalog, id: i64) -> Result<String> {
    cat.conn.query_row("SELECT kind FROM dataset WHERE id = ?1", [id], |r| r.get(0)).optional()?
        .ok_or_else(|| format!("unknown dataset {id}").into())
}

pub fn update(cat: &Catalog, id: i64, e: &DatasetEdit) -> Result<()> {
    let kind = kind_of(cat, id)?;
    if let Some(n) = &e.name {
        let n = check_name(cat, n, Some(id))?;
        cat.conn.execute("UPDATE dataset SET name = ?1 WHERE id = ?2", params![n, id])?;
    }
    if e.description.is_some() { cat.conn.execute("UPDATE dataset SET description = ?1 WHERE id = ?2", params![clean(&e.description), id])?; }
    if e.color.is_some() { cat.conn.execute("UPDATE dataset SET color = ?1 WHERE id = ?2", params![clean(&e.color), id])?; }
    if let Some(f) = &e.filter {
        if kind != "filter" { return Err("only dynamic datasets have a filter".into()); }
        let json = check_filter(cat, f, Some(id))?;
        cat.conn.execute("UPDATE dataset SET filter_json = ?1 WHERE id = ?2", params![json, id])?;
    }
    cat.conn.execute("UPDATE dataset SET updated_at = ?1 WHERE id = ?2", params![now_ms(), id])?;
    Ok(())
}

/// Deleting a dataset never touches recordings. Dynamic datasets that refer to it report an error
/// until their filter is changed.
pub fn delete(cat: &Catalog, id: i64) -> Result<()> {
    kind_of(cat, id)?;
    cat.conn.execute("DELETE FROM dataset WHERE id = ?1", [id])?;
    Ok(())
}

pub fn list(cat: &Catalog) -> Result<Vec<DatasetInfo>> {
    let mut st = cat.conn.prepare(
        "SELECT id, uid, name, description, kind, filter_json, color, created_at, updated_at,
                (SELECT COUNT(*) FROM dataset_member m WHERE m.dataset_id = d.id AND m.t0 IS NOT NULL)
         FROM dataset d")?;
    let rows = st.query_map([], |r| Ok((
        r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<String>>(3)?,
        r.get::<_, String>(4)?, r.get::<_, Option<String>>(5)?, r.get::<_, Option<String>>(6)?,
        r.get::<_, i64>(7)?, r.get::<_, i64>(8)?, r.get::<_, i64>(9)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut out = Vec::new();
    for (id, uid, name, description, kind, fj, color, created_at, updated_at, ranges) in rows {
        let filter = fj.as_deref().map(serde_json::from_str::<Filter>).transpose()?;
        let (recordings, seconds, error) = match query::facets(cat, &Filter { dataset_id: Some(id), ..Default::default() }) {
            Ok(f) => (f.total, f.seconds, None),
            Err(e) => (0, None, Some(e.to_string())),
        };
        out.push(DatasetInfo { id, uid, name, description, kind, filter, color, recordings, ranges, seconds, created_at, updated_at, error });
    }
    out.sort_by(|a, b| query::natural_cmp(&a.name, &b.name));
    Ok(out)
}

/// Add recordings to a static dataset, whole or as the range `t0..t1` seconds. Whole recordings
/// already in it and identical ranges are skipped. Returns how many members were added.
pub fn add_members(cat: &mut Catalog, id: i64, sel: &Selection, range: Option<(f64, f64)>) -> Result<usize> {
    if kind_of(cat, id)? != "static" { return Err("members can only be added to a static dataset".into()); }
    if let Some((a, b)) = range && !(a >= 0.0 && b > a) { return Err("time range must have 0 ≤ start < end".into()); }
    let ids = selected_ids(cat, sel)?;
    let tx = cat.conn.transaction()?;
    let mut added = 0;
    {
        let mut whole = tx.prepare("SELECT 1 FROM dataset_member WHERE dataset_id = ?1 AND recording_id = ?2 AND t0 IS NULL")?;
        let mut same = tx.prepare("SELECT 1 FROM dataset_member WHERE dataset_id = ?1 AND recording_id = ?2 AND t0 = ?3 AND t1 = ?4")?;
        let mut ins = tx.prepare("INSERT INTO dataset_member(dataset_id, recording_id, t0, t1) VALUES (?1, ?2, ?3, ?4)")?;
        let mut drop_ranges = tx.prepare("DELETE FROM dataset_member WHERE dataset_id = ?1 AND recording_id = ?2 AND t0 IS NOT NULL")?;
        for rid in ids {
            if whole.exists(params![id, rid])? { continue; }
            match range {
                Some((a, b)) => {
                    if same.exists(params![id, rid, a, b])? { continue; }
                    ins.execute(params![id, rid, a, b])?;
                }
                None => {
                    // The whole recording covers its ranges.
                    drop_ranges.execute(params![id, rid])?;
                    ins.execute(params![id, rid, None::<f64>, None::<f64>])?;
                }
            }
            added += 1;
        }
    }
    tx.execute("UPDATE dataset SET updated_at = ?1 WHERE id = ?2", params![now_ms(), id])?;
    tx.commit()?;
    Ok(added)
}

/// Remove recordings (with all their ranges) from a static dataset. Returns removed recordings.
pub fn remove_members(cat: &mut Catalog, id: i64, sel: &Selection) -> Result<usize> {
    if kind_of(cat, id)? != "static" { return Err("members can only be removed from a static dataset".into()); }
    let ids = selected_ids(cat, sel)?;
    let tx = cat.conn.transaction()?;
    let mut removed = 0;
    {
        let mut del = tx.prepare("DELETE FROM dataset_member WHERE dataset_id = ?1 AND recording_id = ?2")?;
        for rid in ids { if del.execute(params![id, rid])? > 0 { removed += 1; } }
    }
    tx.execute("UPDATE dataset SET updated_at = ?1 WHERE id = ?2", params![now_ms(), id])?;
    tx.commit()?;
    Ok(removed)
}

/// Copy a dataset under a new name. `freeze` turns a dynamic one into a static list of what it
/// matches now (a fixed snapshot, e.g. for a thesis).
pub fn duplicate(cat: &mut Catalog, id: i64, name: &str, freeze: bool) -> Result<i64> {
    let (kind, desc, fj, color): (String, Option<String>, Option<String>, Option<String>) = cat.conn.query_row(
        "SELECT kind, description, filter_json, color FROM dataset WHERE id = ?1", [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).optional()?.ok_or_else(|| format!("unknown dataset {id}"))?;
    let to_static = kind == "static" || freeze;
    let e = DatasetEdit {
        name: Some(name.into()), description: desc, color,
        filter: if to_static { None } else { fj.as_deref().map(serde_json::from_str).transpose()? },
    };
    let new_id = create(cat, if to_static { "static" } else { "filter" }, &e)?;
    if kind == "static" {
        cat.conn.execute("INSERT INTO dataset_member(dataset_id, recording_id, t0, t1)
            SELECT ?1, recording_id, t0, t1 FROM dataset_member WHERE dataset_id = ?2", params![new_id, id])?;
    } else if freeze {
        add_members(cat, new_id, &Selection { ids: None, filter: Some(Filter { dataset_id: Some(id), ..Default::default() }) }, None)?;
    }
    Ok(new_id)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Membership {
    pub dataset_id: i64,
    pub name: String,
    pub kind: String,
    pub color: Option<String>,
    /// Ranges in seconds; empty = whole recording.
    pub ranges: Vec<(f64, f64)>,
}

/// Datasets a recording belongs to (static as member, dynamic by matching the filter).
pub fn recording_datasets(cat: &Catalog, recording_id: i64) -> Result<Vec<Membership>> {
    let mut out = Vec::new();
    for d in list(cat)? {
        if d.error.is_some() { continue; }
        if d.kind == "static" {
            let mut st = cat.conn.prepare("SELECT t0, t1 FROM dataset_member WHERE dataset_id = ?1 AND recording_id = ?2 ORDER BY t0")?;
            let m: Vec<(Option<f64>, Option<f64>)> = st.query_map(params![d.id, recording_id], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<std::result::Result<_, _>>()?;
            if m.is_empty() { continue; }
            let ranges = if m.iter().any(|x| x.0.is_none()) { vec![] } else { m.iter().map(|x| (x.0.unwrap_or(0.0), x.1.unwrap_or(0.0))).collect() };
            out.push(Membership { dataset_id: d.id, name: d.name, kind: d.kind, color: d.color, ranges });
        } else {
            let f = Filter { dataset_id: Some(d.id), ..Default::default() };
            let (w, mut p) = query::where_clause(cat, &f, query::Skip::None)?;
            p.push(Box::new(recording_id));
            let hit = cat.conn.prepare(&format!("SELECT 1 {} WHERE {w} AND r.id = ?{}", query::FROM, p.len()))?
                .exists(rusqlite::params_from_iter(p.iter()))?;
            if hit { out.push(Membership { dataset_id: d.id, name: d.name, kind: d.kind, color: d.color, ranges: vec![] }); }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::query::{facets, ids};
    use crate::sun::{SunEvent, SunRef, SunWindow};
    use crate::{import_scanned, profile_spec::{MappingSpec, ProfileSpec}, scan::ScannedFile};

    /// Two sites × 24 hourly files on 2023-03-20, UTC clock.
    fn fixture() -> Catalog {
        let mut cat = Catalog::open_in_memory().unwrap();
        let root = cat.add_root("r", "referenced", "m", "/x").unwrap();
        let mut files = Vec::new();
        for site in [1, 2] {
            for h in 0..24 { files.push(ScannedFile { rel_path: format!("S{site}/R{site}_20230320_{h:02}0000.wav"), size: 100, mtime_ms: 0 }); }
        }
        let spec = ProfileSpec {
            name: "t".into(), patterns: vec!["S{s}/R{d}_{t:%Y%m%d_%H%M%S}.wav".into()],
            mappings: vec![
                MappingSpec { field: "s".into(), role: "site".into(), format: Some("Site {}".into()), ..Default::default() },
                MappingSpec { field: "d".into(), role: "device".into(), ..Default::default() },
                MappingSpec { field: "t".into(), role: "start".into(), ..Default::default() },
            ],
            ..Default::default()
        };
        import_scanned(&mut cat, root, &files, &spec.build().unwrap()).unwrap();
        cat
    }
    fn named(n: &str) -> DatasetEdit { DatasetEdit { name: Some(n.into()), ..Default::default() } }
    fn site_ids(cat: &Catalog) -> Vec<i64> { facets(cat, &Filter::default()).unwrap().sites.iter().map(|s| s.id).collect() }

    #[test]
    fn static_members_whole_and_ranges() {
        let mut cat = fixture();
        let d = create(&cat, "static", &named("Training")).unwrap();
        let all = ids(&cat, &Filter::default()).unwrap();
        let sel = |v: &[i64]| Selection { ids: Some(v.to_vec()), filter: None };
        assert_eq!(add_members(&mut cat, d, &sel(&all[0..3]), None).unwrap(), 3);
        assert_eq!(add_members(&mut cat, d, &sel(&all[0..4]), None).unwrap(), 1, "already there are skipped");
        assert_eq!(add_members(&mut cat, d, &sel(&all[10..11]), Some((5.0, 8.0))).unwrap(), 1);
        assert_eq!(add_members(&mut cat, d, &sel(&all[10..11]), Some((5.0, 8.0))).unwrap(), 0, "same range twice");
        assert_eq!(add_members(&mut cat, d, &sel(&all[10..11]), Some((20.0, 30.0))).unwrap(), 1);
        assert!(add_members(&mut cat, d, &sel(&all[10..11]), Some((3.0, 3.0))).is_err());
        let info = &list(&cat).unwrap()[0];
        assert_eq!((info.recordings, info.ranges), (5, 2), "a recording with two ranges counts once");
        let m = recording_datasets(&cat, all[10]).unwrap();
        assert_eq!(m[0].ranges, vec![(5.0, 8.0), (20.0, 30.0)]);
        // Adding the whole recording replaces its ranges.
        add_members(&mut cat, d, &sel(&all[10..11]), None).unwrap();
        assert_eq!(list(&cat).unwrap()[0].ranges, 0);
        assert_eq!(remove_members(&mut cat, d, &sel(&all[0..2])).unwrap(), 2);
        assert_eq!(facets(&cat, &Filter { dataset_id: Some(d), ..Default::default() }).unwrap().total, 3);
        // Dataset filter combines with others.
        let s = site_ids(&cat);
        assert_eq!(facets(&cat, &Filter { dataset_id: Some(d), site_ids: vec![s[1]], ..Default::default() }).unwrap().total, 0);
    }

    #[test]
    fn dynamic_dataset_follows_filter_and_nests() {
        let mut cat = fixture();
        let s = site_ids(&cat);
        let night = DatasetEdit { filter: Some(Filter { hour_from: Some(20), hour_to: Some(4), ..Default::default() }), ..named("Night") };
        let n = create(&cat, "filter", &night).unwrap();
        let site1_night = DatasetEdit { filter: Some(Filter { dataset_id: Some(n), site_ids: vec![s[0]], ..Default::default() }), ..named("Site 1 night") };
        let sn = create(&cat, "filter", &site1_night).unwrap();
        let by_name = |cat: &Catalog, name: &str| list(cat).unwrap().into_iter().find(|d| d.name == name).unwrap();
        assert_eq!(by_name(&cat, "Night").recordings, 16);
        assert_eq!(by_name(&cat, "Site 1 night").recordings, 8);
        // Editing the inner dataset changes the outer one.
        update(&cat, n, &DatasetEdit { filter: Some(Filter { hour_from: Some(22), hour_to: Some(2), ..Default::default() }), ..Default::default() }).unwrap();
        assert_eq!(by_name(&cat, "Site 1 night").recordings, 4);
        // Cycles are refused when saving.
        assert!(update(&cat, n, &DatasetEdit { filter: Some(Filter { dataset_id: Some(sn), ..Default::default() }), ..Default::default() }).is_err());
        assert!(update(&cat, n, &DatasetEdit { filter: Some(Filter { dataset_id: Some(n), ..Default::default() }), ..Default::default() }).is_err());
        assert_eq!(by_name(&cat, "Night").recordings, 8, "refused edit left the filter as it was");
        // Freezing keeps what it matches now, later changes don't follow.
        let frozen = duplicate(&mut cat, sn, "Snapshot", true).unwrap();
        update(&cat, n, &DatasetEdit { filter: Some(Filter::default()), ..Default::default() }).unwrap();
        assert_eq!(by_name(&cat, "Site 1 night").recordings, 24);
        assert_eq!(by_name(&cat, "Snapshot").recordings, 4);
        assert_eq!(by_name(&cat, "Snapshot").kind, "static");
        let _ = frozen;
        // Deleting the inner dataset: the outer reports an error instead of failing the list.
        delete(&cat, n).unwrap();
        assert!(by_name(&cat, "Site 1 night").error.is_some());
        // Members can't be added to a dynamic one, names are unique (case-insensitive).
        assert!(add_members(&mut cat, sn, &Selection::default(), None).is_err());
        assert!(create(&cat, "static", &named("snapshot")).is_err());
        assert!(create(&cat, "filter", &named("No filter")).is_err());
    }

    #[test]
    fn sun_window_filter_uses_site_position() {
        let cat = fixture();
        let s = site_ids(&cat);
        // Berlin: on 2023-03-20 sunset 17:18 UTC, sunrise 05:10 UTC. Site 2 has no position.
        cat.conn.execute("UPDATE site SET lat = 52.52, lon = 13.405 WHERE id = ?1", [s[0]]).unwrap();
        let w = SunWindow { from: SunRef { event: SunEvent::Sunset, offset_min: -60 }, to: SunRef { event: SunEvent::Sunrise, offset_min: 0 } };
        let f = Filter { sun: Some(w), ..Default::default() };
        // Starts 00..05 (sunrise 05:10 → 05:00 is in) and 17..23 (16:18 onwards) → 6 + 7.
        assert_eq!(facets(&cat, &f).unwrap().total, 13);
        let d = create(&cat, "filter", &DatasetEdit { filter: Some(f), ..named("Owl night") }).unwrap();
        assert_eq!(list(&cat).unwrap().iter().find(|x| x.id == d).unwrap().recordings, 13);
        // Serialised form the UI sends.
        let js: Filter = serde_json::from_str(r#"{"sun":{"from":{"event":"sunset","offsetMin":-60},"to":{"event":"sunrise"}}}"#).unwrap();
        assert_eq!(js.sun, Some(w));
    }
}
