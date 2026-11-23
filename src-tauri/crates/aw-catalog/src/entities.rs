//! Metadata entities (Phase 2): edit sites and recorders, merge duplicates, derive deployments,
//! bulk-edit a selection of recordings (site, recorder, tags, metadata).

use crate::{Catalog, Result, clock, new_uid, query};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SiteFields {
    pub name: String,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub elevation: Option<f64>,
    pub habitat: Option<String>,
    pub notes: Option<String>,
    /// Photo file (absolute path or relative to the project).
    pub photo: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DeviceFields {
    pub name: String,
    pub model: Option<String>,
    pub serial: Option<String>,
    pub notes: Option<String>,
}

fn clean(s: &Option<String>) -> Option<String> { s.as_deref().map(str::trim).filter(|x| !x.is_empty()).map(String::from) }

fn check_name(name: &str) -> Result<String> {
    let n = name.trim();
    if n.is_empty() { return Err("name must not be empty".into()); }
    Ok(n.to_string())
}

fn check_coords(f: &SiteFields) -> Result<()> {
    if f.lat.is_some() != f.lon.is_some() { return Err("latitude and longitude go together".into()); }
    if f.lat.is_some_and(|v| !(-90.0..=90.0).contains(&v)) { return Err("latitude out of range".into()); }
    if f.lon.is_some_and(|v| !(-180.0..=180.0).contains(&v)) { return Err("longitude out of range".into()); }
    Ok(())
}

fn name_taken(cat: &Catalog, table: &str, name: &str, id: Option<i64>) -> Result<bool> {
    Ok(cat.conn.query_row(&format!("SELECT COUNT(*) > 0 FROM {table} WHERE name = ?1 AND id IS NOT ?2"),
        params![name, id], |r| r.get(0))?)
}

pub fn site_fields(cat: &Catalog, id: i64) -> Result<SiteFields> {
    Ok(cat.conn.query_row("SELECT name, lat, lon, elevation, habitat, notes, photo FROM site WHERE id = ?1", [id], |r| Ok(SiteFields {
        name: r.get(0)?, lat: r.get(1)?, lon: r.get(2)?, elevation: r.get(3)?, habitat: r.get(4)?, notes: r.get(5)?, photo: r.get(6)?,
    }))?)
}

pub fn device_fields(cat: &Catalog, id: i64) -> Result<DeviceFields> {
    Ok(cat.conn.query_row("SELECT name, model, serial, notes FROM device WHERE id = ?1", [id], |r| Ok(DeviceFields {
        name: r.get(0)?, model: r.get(1)?, serial: r.get(2)?, notes: r.get(3)?,
    }))?)
}

/// Create (`id` None) or update a site. Returns its id.
pub fn save_site(cat: &Catalog, id: Option<i64>, f: &SiteFields) -> Result<i64> {
    let name = check_name(&f.name)?;
    check_coords(f)?;
    if name_taken(cat, "site", &name, id)? { return Err(format!("a site named \"{name}\" exists already").into()); }
    match id {
        Some(id) => {
            let n = cat.conn.execute(
                "UPDATE site SET name = ?1, lat = ?2, lon = ?3, elevation = ?4, habitat = ?5, notes = ?6, photo = ?7 WHERE id = ?8",
                params![name, f.lat, f.lon, f.elevation, clean(&f.habitat), clean(&f.notes), clean(&f.photo), id])?;
            if n == 0 { return Err("unknown site".into()); }
            Ok(id)
        }
        None => {
            cat.conn.execute("INSERT INTO site(uid, name, lat, lon, elevation, habitat, notes, photo) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![new_uid(), name, f.lat, f.lon, f.elevation, clean(&f.habitat), clean(&f.notes), clean(&f.photo)])?;
            Ok(cat.conn.last_insert_rowid())
        }
    }
}

pub fn save_device(cat: &Catalog, id: Option<i64>, f: &DeviceFields) -> Result<i64> {
    let name = check_name(&f.name)?;
    if name_taken(cat, "device", &name, id)? { return Err(format!("a recorder named \"{name}\" exists already").into()); }
    match id {
        Some(id) => {
            let n = cat.conn.execute("UPDATE device SET name = ?1, model = ?2, serial = ?3, notes = ?4 WHERE id = ?5",
                params![name, clean(&f.model), clean(&f.serial), clean(&f.notes), id])?;
            if n == 0 { return Err("unknown recorder".into()); }
            Ok(id)
        }
        None => {
            cat.conn.execute("INSERT INTO device(uid, name, model, serial, notes) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![new_uid(), name, clean(&f.model), clean(&f.serial), clean(&f.notes)])?;
            Ok(cat.conn.last_insert_rowid())
        }
    }
}

/// Delete a site or recorder that no recording uses any more.
pub fn delete_entity(cat: &mut Catalog, table: &str, id: i64) -> Result<()> {
    let col = entity_col(table)?;
    let used: i64 = cat.conn.query_row(&format!("SELECT COUNT(*) FROM recording WHERE {col} = ?1"), [id], |r| r.get(0))?;
    if used > 0 { return Err(format!("still used by {used} recordings").into()); }
    let tx = cat.conn.transaction()?;
    tx.execute(&format!("DELETE FROM deployment WHERE {col} = ?1"), [id])?;
    tx.execute(&format!("DELETE FROM {table} WHERE id = ?1"), [id])?;
    tx.commit()?;
    Ok(())
}

fn entity_col(table: &str) -> Result<&'static str> {
    match table { "site" => Ok("site_id"), "device" => Ok("device_id"), _ => Err("unknown entity".into()) }
}

/// Merge sites or recorders into `into` (e.g. "34" and "34_21" are the same recorder).
/// Empty fields of the target are filled from the merged rows. Recordings that move to another
/// recorder get their UTC start recomputed from that recorder's clock periods.
pub fn merge(cat: &mut Catalog, table: &str, from: &[i64], into: i64) -> Result<usize> {
    let col = entity_col(table)?;
    let from: Vec<i64> = from.iter().copied().filter(|&f| f != into).collect();
    if from.is_empty() { return Ok(0); }
    let tx = cat.conn.transaction()?;
    let exists: bool = tx.query_row(&format!("SELECT COUNT(*) > 0 FROM {table} WHERE id = ?1"), [into], |r| r.get(0))?;
    if !exists { return Err("unknown merge target".into()); }
    let fill = match table {
        "site" => ["lat", "lon", "elevation", "habitat", "notes", "photo", "tz"].as_slice(),
        _ => ["model", "serial", "notes"].as_slice(),
    };
    let mut moved = 0;
    for f in &from {
        for c in fill {
            // Coordinates come as a pair: only take both when the target has none.
            if *c == "lon" { continue; }
            if *c == "lat" {
                tx.execute(&format!("UPDATE {table} SET lat = (SELECT lat FROM {table} WHERE id = ?2), lon = (SELECT lon FROM {table} WHERE id = ?2)
                    WHERE id = ?1 AND lat IS NULL"), params![into, f])?;
                continue;
            }
            tx.execute(&format!("UPDATE {table} SET {c} = (SELECT {c} FROM {table} WHERE id = ?2) WHERE id = ?1 AND {c} IS NULL"), params![into, f])?;
        }
        moved += tx.execute(&format!("UPDATE recording SET {col} = ?1 WHERE {col} = ?2"), params![into, f])?;
        tx.execute(&format!("UPDATE deployment SET {col} = ?1 WHERE {col} = ?2"), params![into, f])?;
        if table == "device" {
            // Keep the target's clock; periods of the merged recorder that the target lacks are kept.
            tx.execute("UPDATE OR IGNORE clock_period SET device_id = ?1 WHERE device_id = ?2
                AND NOT EXISTS (SELECT 1 FROM clock_period WHERE device_id = ?1)", params![into, f])?;
            tx.execute("DELETE FROM clock_period WHERE device_id = ?1", [f])?;
        }
        tx.execute(&format!("DELETE FROM {table} WHERE id = ?1"), [f])?;
    }
    // Recomputed in the same transaction: if this fails, the merge did not happen either.
    if table == "device" {
        let periods = clock::device_clocks_in(&tx, into)?;
        if !periods.is_empty() { clock::set_device_clocks_in(&tx, into, &periods)?; }
    }
    tx.commit()?;
    Ok(moved)
}

// ── Deployments ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentInfo {
    pub id: i64,
    pub site_id: Option<i64>,
    pub site: Option<String>,
    pub device_id: Option<i64>,
    pub device: Option<String>,
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    pub recordings: i64,
    pub notes: Option<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeriveReport { pub deployments: usize, pub recordings: usize, pub kept_notes: usize }

/// Deployments from the recordings: one per recorder × site × uninterrupted stretch. A pause longer
/// than `gap_days` (rotation, battery change with removal) starts a new deployment. Replaces all
/// deployments; notes carry over to a new deployment of the same recorder and site that overlaps.
pub fn derive_deployments(cat: &mut Catalog, gap_days: f64) -> Result<DeriveReport> {
    let gap_ms = (gap_days * 86_400_000.0) as i64;
    let tx = cat.conn.transaction()?;
    let old: Vec<(Option<i64>, Option<i64>, i64, i64, String)> = {
        let mut st = tx.prepare("SELECT site_id, device_id, COALESCE(start_ms, 0), COALESCE(end_ms, 0), notes FROM deployment WHERE notes IS NOT NULL AND notes != ''")?;
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?.collect::<std::result::Result<_, _>>()?
    };
    let recs: Vec<(i64, Option<i64>, Option<i64>, i64, i64)> = {
        let mut st = tx.prepare(
            "SELECT id, device_id, site_id, start_ms, start_ms + CAST(COALESCE(duration_s, 0) * 1000 AS INTEGER)
             FROM recording WHERE start_ms IS NOT NULL AND (device_id IS NOT NULL OR site_id IS NOT NULL)
             ORDER BY device_id IS NULL, device_id, site_id IS NULL, site_id, start_ms")?;
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?.collect::<std::result::Result<_, _>>()?
    };
    tx.execute("UPDATE recording SET deployment_id = NULL", [])?;
    tx.execute("DELETE FROM deployment", [])?;
    let mut rep = DeriveReport::default();
    {
        let mut ins = tx.prepare("INSERT INTO deployment(uid, site_id, device_id, start_ms, end_ms, notes) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")?;
        let mut set = tx.prepare("UPDATE recording SET deployment_id = ?1 WHERE id = ?2")?;
        let mut i = 0;
        while i < recs.len() {
            let (_, dev, site, s0, _) = recs[i];
            let mut j = i;
            let mut end = recs[i].4.max(s0);
            while j + 1 < recs.len() && recs[j + 1].1 == dev && recs[j + 1].2 == site && recs[j + 1].3 - end <= gap_ms {
                j += 1;
                end = end.max(recs[j].4).max(recs[j].3);
            }
            let notes = old.iter().filter(|o| o.0 == site && o.1 == dev && o.2 <= end && o.3 >= s0)
                .map(|o| o.4.clone()).collect::<Vec<_>>();
            if !notes.is_empty() { rep.kept_notes += 1; }
            let notes = (!notes.is_empty()).then(|| notes.join("\n"));
            ins.execute(params![new_uid(), site, dev, s0, end, notes])?;
            let dep = tx.last_insert_rowid();
            for r in &recs[i..=j] { set.execute(params![dep, r.0])?; }
            rep.deployments += 1;
            rep.recordings += j - i + 1;
            i = j + 1;
        }
    }
    tx.commit()?;
    Ok(rep)
}

pub fn deployments(cat: &Catalog) -> Result<Vec<DeploymentInfo>> {
    let mut st = cat.conn.prepare(
        "SELECT d.id, d.site_id, s.name, d.device_id, v.name, d.start_ms, d.end_ms,
                (SELECT COUNT(*) FROM recording r WHERE r.deployment_id = d.id), d.notes
         FROM deployment d LEFT JOIN site s ON s.id = d.site_id LEFT JOIN device v ON v.id = d.device_id")?;
    let mut v: Vec<DeploymentInfo> = st.query_map([], |r| Ok(DeploymentInfo {
        id: r.get(0)?, site_id: r.get(1)?, site: r.get(2)?, device_id: r.get(3)?, device: r.get(4)?,
        start_ms: r.get(5)?, end_ms: r.get(6)?, recordings: r.get(7)?, notes: r.get(8)?,
    }))?.collect::<std::result::Result<_, _>>()?;
    v.sort_by(|a, b| query::natural_cmp(a.device.as_deref().unwrap_or(""), b.device.as_deref().unwrap_or(""))
        .then(a.start_ms.cmp(&b.start_ms)));
    Ok(v)
}

pub fn set_deployment_notes(cat: &Catalog, id: i64, notes: Option<&str>) -> Result<()> {
    let notes = notes.map(str::trim).filter(|s| !s.is_empty());
    if cat.conn.execute("UPDATE deployment SET notes = ?2 WHERE id = ?1", params![id, notes])? == 0 {
        return Err("unknown deployment".into());
    }
    Ok(())
}

// ── Tags ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo { pub id: i64, pub name: String, pub recordings: i64 }

pub fn tags(cat: &Catalog) -> Result<Vec<TagInfo>> {
    let mut st = cat.conn.prepare(
        "SELECT t.id, t.name, (SELECT COUNT(*) FROM recording_tag x WHERE x.tag_id = t.id) FROM tag t")?;
    let mut v: Vec<TagInfo> = st.query_map([], |r| Ok(TagInfo { id: r.get(0)?, name: r.get(1)?, recordings: r.get(2)? }))?
        .collect::<std::result::Result<_, _>>()?;
    v.sort_by(|a, b| query::natural_cmp(&a.name, &b.name));
    Ok(v)
}

fn tag_id(tx: &rusqlite::Transaction, name: &str) -> Result<i64> {
    tx.execute("INSERT OR IGNORE INTO tag(name) VALUES (?1)", [name])?;
    Ok(tx.query_row("SELECT id FROM tag WHERE name = ?1", [name], |r| r.get(0))?)
}

// ── Bulk edit ────────────────────────────────────────────────────────────

/// Which recordings: explicit ids, or everything the library filter matches.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Selection {
    pub ids: Option<Vec<i64>>,
    pub filter: Option<query::Filter>,
}

/// Changes for all selected recordings. `None` = leave as is.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BulkEdit {
    /// Some(Some(id)) = set, Some(None) = clear (JSON: absent = keep, null = clear).
    #[serde(deserialize_with = "present")]
    pub site_id: Option<Option<i64>>,
    #[serde(deserialize_with = "present")]
    pub device_id: Option<Option<i64>>,
    pub add_tags: Vec<String>,
    pub remove_tags: Vec<String>,
    /// Metadata to set (value None = remove the key).
    pub meta: Vec<(String, Option<String>)>,
    /// Own position [lat, lon] set by hand; null clears it (absent = keep).
    #[serde(deserialize_with = "present_pos")]
    pub position: Option<Option<[f64; 2]>>,
}

fn present_pos<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Option<Option<[f64; 2]>>, D::Error> {
    Ok(Some(Option::deserialize(d)?))
}

/// A field that is present (even as null) becomes Some(..).
fn present<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Option<Option<i64>>, D::Error> {
    Ok(Some(Option::deserialize(d)?))
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkReport {
    pub recordings: usize,
    pub site_changed: usize,
    pub device_changed: usize,
    pub tags_added: usize,
    pub tags_removed: usize,
    pub meta_set: usize,
    pub positioned: usize,
    /// UTC starts recomputed because recordings moved to a recorder with its own clock.
    pub reclocked: usize,
}

pub fn selected_ids(cat: &Catalog, sel: &Selection) -> Result<Vec<i64>> {
    if let Some(ids) = &sel.ids { return Ok(ids.clone()); }
    let f = sel.filter.clone().unwrap_or_default();
    query::ids(cat, &f)
}

pub fn bulk_edit(cat: &mut Catalog, sel: &Selection, e: &BulkEdit) -> Result<BulkReport> {
    let ids = selected_ids(cat, sel)?;
    let mut rep = BulkReport { recordings: ids.len(), ..Default::default() };
    let mut devices_touched: Vec<i64> = Vec::new();
    // Everything is checked before anything is written; all changes commit together.
    if e.meta.iter().any(|(k, _)| k.trim().is_empty()) { return Err("metadata key must not be empty".into()); }
    if let Some(Some([lat, lon])) = e.position {
        if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) { return Err("coordinates out of range".into()); }
    }
    let tx = cat.conn.transaction()?;
    if let Some(Some(s)) = e.site_id {
        if tx.query_row("SELECT id FROM site WHERE id = ?1", [s], |r| r.get::<_, i64>(0)).optional()?.is_none() { return Err("unknown site".into()); }
    }
    if let Some(Some(d)) = e.device_id {
        if tx.query_row("SELECT id FROM device WHERE id = ?1", [d], |r| r.get::<_, i64>(0)).optional()?.is_none() { return Err("unknown recorder".into()); }
    }
    let add: Vec<i64> = e.add_tags.iter().map(|t| t.trim()).filter(|t| !t.is_empty()).map(|t| tag_id(&tx, t)).collect::<Result<_>>()?;
    let remove: Vec<i64> = {
        let mut v = Vec::new();
        for t in &e.remove_tags {
            if let Some(id) = tx.query_row("SELECT id FROM tag WHERE name = ?1", [t.trim()], |r| r.get(0)).optional()? { v.push(id); }
        }
        v
    };
    {
        // Another site or recorder: the old deployment no longer describes the recording.
        let mut site = tx.prepare("UPDATE recording SET site_id = ?2, deployment_id = NULL WHERE id = ?1 AND site_id IS NOT ?2")?;
        let mut dev = tx.prepare("UPDATE recording SET device_id = ?2, deployment_id = NULL WHERE id = ?1 AND device_id IS NOT ?2")?;
        let mut add_t = tx.prepare("INSERT OR IGNORE INTO recording_tag(recording_id, tag_id) VALUES (?1, ?2)")?;
        let mut rm_t = tx.prepare("DELETE FROM recording_tag WHERE recording_id = ?1 AND tag_id = ?2")?;
        let mut set_m = tx.prepare("INSERT OR REPLACE INTO meta(recording_id, key, value, origin) VALUES (?1, ?2, ?3, 'manual')")?;
        let mut del_m = tx.prepare("DELETE FROM meta WHERE recording_id = ?1 AND key = ?2")?;
        for &id in &ids {
            if let Some(s) = e.site_id { rep.site_changed += site.execute(params![id, s])?; }
            if let Some(d) = e.device_id {
                if dev.execute(params![id, d])? > 0 {
                    rep.device_changed += 1;
                    if let Some(d) = d { if !devices_touched.contains(&d) { devices_touched.push(d); } }
                }
            }
            for t in &add { rep.tags_added += add_t.execute(params![id, t])?; }
            for t in &remove { rep.tags_removed += rm_t.execute(params![id, t])?; }
            for (k, v) in &e.meta {
                rep.meta_set += match v {
                    Some(v) => set_m.execute(params![id, k.trim(), v])?,
                    None => del_m.execute(params![id, k.trim()])?,
                };
            }
        }
    }
    tx.execute("DELETE FROM tag WHERE NOT EXISTS (SELECT 1 FROM recording_tag x WHERE x.tag_id = tag.id)", [])?;
    if let Some(pos) = e.position {
        rep.positioned = crate::geo::set_positions_in(&tx, &ids, pos.map(|p| (p[0], p[1])))?;
    }
    for d in devices_touched {
        let periods = clock::device_clocks_in(&tx, d)?;
        if !periods.is_empty() { rep.reclocked += clock::set_device_clocks_in(&tx, d, &periods)?.updated; }
    }
    tx.commit()?;
    Ok(rep)
}

/// Metadata of one recording, plus tags (for the detail panel).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingDetail {
    pub id: i64,
    pub path: Option<String>,
    pub site_id: Option<i64>,
    pub device_id: Option<i64>,
    pub deployment_id: Option<i64>,
    pub sample_rate: Option<i64>,
    pub channels: Option<i64>,
    pub tz: Option<String>,
    pub quick_hash: Option<String>,
    pub full_hash: Option<String>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub alt: Option<f64>,
    pub pos_origin: Option<String>,
    pub meta: Vec<(String, String, String)>,
    pub tags: Vec<String>,
}

pub fn recording_detail(cat: &Catalog, id: i64) -> Result<RecordingDetail> {
    let mut d = cat.conn.query_row(
        "SELECT r.id, a.rel_path, r.site_id, r.device_id, r.deployment_id, r.sample_rate, r.channels, r.tz, a.quick_hash, a.full_hash,
                r.lat, r.lon, r.alt, r.pos_origin
         FROM recording r LEFT JOIN asset a ON a.id = r.asset_id WHERE r.id = ?1", [id], |r| Ok(RecordingDetail {
            id: r.get(0)?, path: r.get(1)?, site_id: r.get(2)?, device_id: r.get(3)?, deployment_id: r.get(4)?,
            sample_rate: r.get(5)?, channels: r.get(6)?, tz: r.get(7)?, quick_hash: r.get(8)?, full_hash: r.get(9)?,
            lat: r.get(10)?, lon: r.get(11)?, alt: r.get(12)?, pos_origin: r.get(13)?,
            meta: vec![], tags: vec![],
        }))?;
    let mut st = cat.conn.prepare("SELECT key, value, origin FROM meta WHERE recording_id = ?1 ORDER BY key")?;
    d.meta = st.query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<std::result::Result<_, _>>()?;
    let mut st = cat.conn.prepare("SELECT t.name FROM recording_tag x JOIN tag t ON t.id = x.tag_id WHERE x.recording_id = ?1 ORDER BY t.name")?;
    d.tags = st.query_map([id], |r| r.get(0))?.collect::<std::result::Result<_, _>>()?;
    Ok(d)
}

/// Metadata keys in use, with how many recordings have them (for the bulk editor's key list).
pub fn meta_keys(cat: &Catalog) -> Result<Vec<(String, i64)>> {
    let mut st = cat.conn.prepare("SELECT key, COUNT(*) FROM meta GROUP BY key ORDER BY key")?;
    let v = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<std::result::Result<_, _>>()?;
    Ok(v)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::{import_scanned, profile_spec::{MappingSpec, ProfileSpec}, query::{Filter, facets}, scan::ScannedFile};

    /// Two recorders at two sites, hourly files on 13, 14 and 20 March 2023 (gap of 5 days).
    fn ids_of(cat: &Catalog, sql: &str) -> Vec<i64> {
        cat.conn.prepare(sql).unwrap().query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
    }

    #[test]
    fn a_rejected_position_leaves_the_bulk_edit_undone() {
        let mut cat = fixture();
        let rec = ids_of(&cat, "SELECT id FROM recording ORDER BY id LIMIT 1")[0];
        let devs = ids_of(&cat, "SELECT id FROM device ORDER BY id");
        let before: i64 = cat.conn.query_row("SELECT device_id FROM recording WHERE id = ?1", [rec], |r| r.get(0)).unwrap();
        let other = *devs.iter().find(|&&d| d != before).unwrap();
        let e = BulkEdit { device_id: Some(Some(other)), position: Some(Some([95.0, 8.0])), ..Default::default() };
        assert!(bulk_edit(&mut cat, &Selection { ids: Some(vec![rec]), filter: None }, &e).is_err());
        let after: i64 = cat.conn.query_row("SELECT device_id FROM recording WHERE id = ?1", [rec], |r| r.get(0)).unwrap();
        assert_eq!(after, before);
    }

    #[test]
    fn moving_a_recording_drops_its_deployment() {
        let mut cat = fixture();
        derive_deployments(&mut cat, 3.0).unwrap();
        let rec = ids_of(&cat, "SELECT id FROM recording WHERE deployment_id IS NOT NULL ORDER BY id LIMIT 1")[0];
        let site: i64 = cat.conn.query_row("SELECT site_id FROM recording WHERE id = ?1", [rec], |r| r.get(0)).unwrap();
        let other = ids_of(&cat, "SELECT id FROM site").into_iter().find(|&s| s != site).unwrap();
        bulk_edit(&mut cat, &Selection { ids: Some(vec![rec]), filter: None }, &BulkEdit { site_id: Some(Some(other)), ..Default::default() }).unwrap();
        let dep: Option<i64> = cat.conn.query_row("SELECT deployment_id FROM recording WHERE id = ?1", [rec], |r| r.get(0)).unwrap();
        assert_eq!(dep, None);
        // An edit that does not move it keeps the deployment.
        let rec2 = ids_of(&cat, "SELECT id FROM recording WHERE deployment_id IS NOT NULL ORDER BY id LIMIT 1")[0];
        bulk_edit(&mut cat, &Selection { ids: Some(vec![rec2]), filter: None }, &BulkEdit { add_tags: vec!["x".into()], ..Default::default() }).unwrap();
        let dep2: Option<i64> = cat.conn.query_row("SELECT deployment_id FROM recording WHERE id = ?1", [rec2], |r| r.get(0)).unwrap();
        assert!(dep2.is_some());
    }

    #[test]
    fn a_merge_whose_reclocking_fails_is_not_committed() {
        let mut cat = fixture();
        let devs = ids_of(&cat, "SELECT id FROM device ORDER BY id");
        cat.conn.execute("INSERT INTO clock_period(device_id, from_wall_ms, clock) VALUES (?1, NULL, 'not a clock')", [devs[0]]).unwrap();
        assert!(merge(&mut cat, "device", &[devs[1]], devs[0]).is_err());
        assert_eq!(ids_of(&cat, "SELECT id FROM device ORDER BY id"), devs, "the merged recorder still exists");
    }

    pub(crate) fn fixture() -> Catalog {
        let mut cat = Catalog::open_in_memory().unwrap();
        let root = cat.add_root("r", "referenced", "m", "/x").unwrap();
        let mut files = Vec::new();
        for (site, dev) in [(1, 11), (2, 12)] {
            for day in [13, 14, 20] {
                for h in [20, 21, 22] {
                    files.push(ScannedFile { rel_path: format!("S{site}/R{dev}_202303{day}_{h}0000.wav"), size: 10, mtime_ms: 0 });
                }
            }
        }
        let spec = ProfileSpec {
            name: "t".into(), patterns: vec!["S{s}/R{d}_{t:%Y%m%d_%H%M%S}.wav".into()],
            mappings: vec![
                MappingSpec { field: "s".into(), role: "site".into(), format: Some("Site {}".into()), ..Default::default() },
                MappingSpec { field: "d".into(), role: "device".into(), ..Default::default() },
                MappingSpec { field: "t".into(), role: "start".into(), ..Default::default() },
            ],
            utc_offset_min: 60, ..Default::default()
        };
        import_scanned(&mut cat, root, &files, &spec.build().unwrap()).unwrap();
        cat.conn.execute("UPDATE recording SET duration_s = 3600", []).unwrap();
        cat
    }

    fn id(cat: &Catalog, table: &str, name: &str) -> i64 {
        cat.conn.query_row(&format!("SELECT id FROM {table} WHERE name = ?1"), [name], |r| r.get(0)).unwrap()
    }

    #[test]
    fn site_fields_are_validated_and_saved() {
        let cat = fixture();
        let s1 = id(&cat, "site", "Site 1");
        assert!(save_site(&cat, Some(s1), &SiteFields { name: " ".into(), ..Default::default() }).is_err());
        assert!(save_site(&cat, Some(s1), &SiteFields { name: "Site 2".into(), ..Default::default() }).is_err(), "duplicate name");
        assert!(save_site(&cat, Some(s1), &SiteFields { name: "Moor".into(), lat: Some(52.0), ..Default::default() }).is_err(), "lat without lon");
        assert!(save_site(&cat, Some(s1), &SiteFields { name: "Moor".into(), lat: Some(95.0), lon: Some(8.0), ..Default::default() }).is_err());
        let f = SiteFields { name: " Moor ".into(), lat: Some(52.1), lon: Some(8.2), habitat: Some("  ".into()), notes: Some("wet".into()), ..Default::default() };
        save_site(&cat, Some(s1), &f).unwrap();
        let got = site_fields(&cat, s1).unwrap();
        assert_eq!((got.name.as_str(), got.lat, got.habitat, got.notes.as_deref()), ("Moor", Some(52.1), None, Some("wet")));
        let new = save_site(&cat, None, &SiteFields { name: "Heide".into(), ..Default::default() }).unwrap();
        assert!(new > s1);
        assert!(delete_entity(&mut { cat }, "site", s1).is_err(), "still in use");
    }

    #[test]
    fn merging_recorders_moves_recordings_and_reclocks() {
        let mut cat = fixture();
        let (a, b) = (id(&cat, "device", "11"), id(&cat, "device", "12"));
        save_device(&cat, Some(a), &DeviceFields { name: "11".into(), model: Some("SM4".into()), ..Default::default() }).unwrap();
        save_device(&cat, Some(b), &DeviceFields { name: "12".into(), serial: Some("S-12".into()), ..Default::default() }).unwrap();
        clock::set_device_clocks(&mut cat, a, &[clock::ClockPeriod { from: None, clock: "UTC+02:00".into(), ..Default::default() }]).unwrap();
        let before: i64 = cat.conn.query_row("SELECT MIN(start_ms) FROM recording WHERE device_id = ?1", [b], |r| r.get(0)).unwrap();
        assert_eq!(merge(&mut cat, "device", &[b], a).unwrap(), 9);
        let f = device_fields(&cat, a).unwrap();
        assert_eq!((f.model.as_deref(), f.serial.as_deref()), (Some("SM4"), Some("S-12")));
        assert_eq!(crate::count(&cat, "SELECT COUNT(*) FROM device").unwrap(), 1);
        let after: i64 = cat.conn.query_row("SELECT MIN(start_ms) FROM recording r JOIN site s ON s.id = r.site_id WHERE s.name = 'Site 2'", [], |r| r.get(0)).unwrap();
        assert_eq!(before - after, 3_600_000, "moved recordings follow the target's clock (UTC+2 instead of +1)");
    }

    #[test]
    fn deployments_split_at_gaps_and_keep_notes() {
        let mut cat = fixture();
        let r = derive_deployments(&mut cat, 3.0).unwrap();
        assert_eq!((r.deployments, r.recordings), (4, 18), "13–14 and 20 March per recorder");
        let d = deployments(&cat).unwrap();
        assert_eq!(d[0].recordings, 6);
        set_deployment_notes(&cat, d[0].id, Some("battery swapped")).unwrap();
        let r = derive_deployments(&mut cat, 10.0).unwrap();
        assert_eq!((r.deployments, r.kept_notes), (2, 1));
        let d = deployments(&cat).unwrap();
        assert_eq!((d[0].recordings, d[0].notes.as_deref()), (9, Some("battery swapped")));
        assert_eq!(crate::count(&cat, "SELECT COUNT(*) FROM recording WHERE deployment_id IS NULL").unwrap(), 0);
    }

    #[test]
    fn bulk_edit_json_absent_keeps_null_clears() {
        let keep: BulkEdit = serde_json::from_str(r#"{"addTags":["x"]}"#).unwrap();
        assert_eq!((keep.site_id, keep.device_id), (None, None));
        let clear: BulkEdit = serde_json::from_str(r#"{"siteId":null,"deviceId":4,"meta":[["k",null],["j","v"]]}"#).unwrap();
        assert_eq!((clear.site_id, clear.device_id), (Some(None), Some(Some(4))));
        assert_eq!(clear.meta[1], ("j".to_string(), Some("v".to_string())));
        assert_eq!(clear.position, None);
        let pos: BulkEdit = serde_json::from_str(r#"{"position":[52.1,8.2]}"#).unwrap();
        assert_eq!(pos.position, Some(Some([52.1, 8.2])));
        let unpos: BulkEdit = serde_json::from_str(r#"{"position":null}"#).unwrap();
        assert_eq!(unpos.position, Some(None));
    }

    #[test]
    fn bulk_edit_by_filter() {
        let mut cat = fixture();
        let s1 = id(&cat, "site", "Site 1");
        let sel = Selection { filter: Some(Filter { site_ids: vec![s1], ..Default::default() }), ..Default::default() };
        let e = BulkEdit { add_tags: vec!["checked".into(), " ".into()], meta: vec![("habitat".into(), Some("reed".into()))], ..Default::default() };
        let r = bulk_edit(&mut cat, &sel, &e).unwrap();
        assert_eq!((r.recordings, r.tags_added, r.meta_set), (9, 9, 9));
        let t = tags(&cat).unwrap();
        assert_eq!((t.len(), t[0].recordings), (1, 9));
        let by_tag = Filter { tag_ids: vec![t[0].id], ..Default::default() };
        let fc = facets(&cat, &by_tag).unwrap();
        assert_eq!((fc.total, fc.tags.len()), (9, 1));
        // Move three recordings to site 2, remove the tag and the key again.
        let ids: Vec<i64> = crate::query::ids(&cat, &by_tag).unwrap().into_iter().take(3).collect();
        let s2 = id(&cat, "site", "Site 2");
        let e = BulkEdit { site_id: Some(Some(s2)), remove_tags: vec!["checked".into()], meta: vec![("habitat".into(), None)], ..Default::default() };
        let r = bulk_edit(&mut cat, &Selection { ids: Some(ids.clone()), filter: None }, &e).unwrap();
        assert_eq!((r.site_changed, r.tags_removed, r.meta_set), (3, 3, 3));
        let d = recording_detail(&cat, ids[0]).unwrap();
        assert_eq!((d.site_id, d.tags.len(), d.meta.iter().any(|m| m.0 == "habitat")), (Some(s2), 0, false));
        assert!(bulk_edit(&mut cat, &sel, &BulkEdit { site_id: Some(Some(999)), ..Default::default() }).is_err());
        let r = bulk_edit(&mut cat, &Selection { ids: Some(vec![ids[0]]), filter: None }, &BulkEdit { position: Some(Some([52.1, 8.2])), ..Default::default() }).unwrap();
        assert_eq!(r.positioned, 1);
        let d = recording_detail(&cat, ids[0]).unwrap();
        assert_eq!((d.lat, d.pos_origin.as_deref()), (Some(52.1), Some("manual")));
        assert!(bulk_edit(&mut cat, &sel, &BulkEdit { meta: vec![(" ".into(), None)], ..Default::default() }).is_err());
        // Unused tags disappear.
        bulk_edit(&mut cat, &Selection::default(), &BulkEdit { remove_tags: vec!["checked".into()], ..Default::default() }).unwrap();
        assert!(tags(&cat).unwrap().is_empty());
        assert_eq!(facets(&cat, &Filter { unassigned: true, ..Default::default() }).unwrap().total, 0);
    }
}
