//! Library queries: filter, keyset-paged listing, facets, calendar heatmap.

use crate::{Catalog, Result};
use rusqlite::{ToSql, params_from_iter};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DetectionFilter {
    pub run_id: Option<i64>,
    pub class: String,
    pub min_score: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Filter {
    pub root_id: Option<i64>,
    pub site_ids: Vec<i64>,
    pub device_ids: Vec<i64>,
    /// Recordings with any of these tags.
    pub tag_ids: Vec<i64>,
    /// Recordings without site or recorder (to find what still needs assigning).
    pub unassigned: bool,
    /// Area [south, west, north, east] on the recording's own position, else its site's.
    pub bbox: Option<[f64; 4]>,
    /// With (true) or without (false) any position (own or site).
    pub has_position: Option<bool>,
    /// UTC ms, inclusive / exclusive.
    pub from_ms: Option<i64>,
    pub to_ms: Option<i64>,
    /// Local calendar days "YYYY-MM-DD", both inclusive (the days statistics group by).
    pub local_day_from: Option<String>,
    pub local_day_to: Option<String>,
    /// Only recordings without a site.
    pub no_site: bool,
    /// Local time of day, hours 0–23; `hour_from > hour_to` wraps over midnight (night).
    pub hour_from: Option<u8>,
    pub hour_to: Option<u8>,
    pub path_contains: Option<String>,
    pub has_labels: Option<bool>,
    pub detection: Option<DetectionFilter>,
    pub no_start: bool,
    /// Asset status: ok / missing / changed.
    pub status: Option<String>,
    /// Only recordings in this dataset (static: members; dynamic: its saved filter).
    pub dataset_id: Option<i64>,
    /// Start relative to the sun at the recording's position (own, else the site's).
    pub sun: Option<crate::sun::SunWindow>,
    /// Review state: "new" (never opened), "open", "done", "todo" (not done).
    pub review: Option<String>,
}

/// Nesting limit for dynamic datasets that refer to other datasets (also stops cycles).
pub(crate) const MAX_DATASET_DEPTH: usize = 4;

// Local wall time in ms; divided with floor (SQLite truncates toward zero, wrong before 1970).
const LOCAL_HOUR: &str = "((((r.start_ms + COALESCE(r.local_offset_min, 0) * 60000) - (((r.start_ms + COALESCE(r.local_offset_min, 0) * 60000) % 3600000) + 3600000) % 3600000) / 3600000) % 24 + 24) % 24";
/// Effective position: own, else the site's.
const POS_LAT: &str = "COALESCE(r.lat, (SELECT lat FROM site WHERE id = r.site_id))";
const POS_LON: &str = "COALESCE(r.lon, (SELECT lon FROM site WHERE id = r.site_id))";
pub(crate) const LOCAL_DAY: &str = "date(((r.start_ms + COALESCE(r.local_offset_min, 0) * 60000) - (((r.start_ms + COALESCE(r.local_offset_min, 0) * 60000) % 1000) + 1000) % 1000) / 1000, 'unixepoch')";

#[derive(Clone, Copy, PartialEq)]
/// Filter part to leave out: a facet counts under the rest, so its own other values stay visible.
/// `Time` leaves out both period and time of day (the calendar shows them dimmed instead).
pub(crate) enum Skip { None, Site, Device, Tag, Dataset, Period, Hour, Time }

pub(crate) fn where_clause(cat: &Catalog, f: &Filter, skip: Skip) -> Result<(String, Vec<Box<dyn ToSql>>)> {
    where_depth(cat, f, skip, 0)
}

fn where_depth(cat: &Catalog, f: &Filter, skip: Skip, depth: usize) -> Result<(String, Vec<Box<dyn ToSql>>)> {
    let mut w: Vec<String> = vec!["1".into()];
    let mut p: Vec<Box<dyn ToSql>> = Vec::new();
    let mut push = |cond: String, vals: Vec<Box<dyn ToSql>>, p: &mut Vec<Box<dyn ToSql>>| {
        // Number the `?` placeholders in order (a replaced `?N` must not be matched again).
        // Conditions from a nested filter arrive numbered already: drop their numbers first.
        let mut parts = cond.split('?');
        let mut out = parts.next().unwrap_or("").to_string();
        let mut vals = vals.into_iter();
        for part in parts {
            let part = part.trim_start_matches(|c: char| c.is_ascii_digit());
            p.push(vals.next().expect("one value per placeholder"));
            out += &format!("?{}{part}", p.len());
        }
        w.push(out);
    };
    if let Some(id) = f.root_id { push("a.root_id = ?".into(), vec![Box::new(id)], &mut p); }
    if skip != Skip::Site && !f.site_ids.is_empty() {
        let q = vec!["?"; f.site_ids.len()].join(",");
        push(format!("r.site_id IN ({q})"), f.site_ids.iter().map(|v| Box::new(*v) as Box<dyn ToSql>).collect(), &mut p);
    }
    if skip != Skip::Device && !f.device_ids.is_empty() {
        let q = vec!["?"; f.device_ids.len()].join(",");
        push(format!("r.device_id IN ({q})"), f.device_ids.iter().map(|v| Box::new(*v) as Box<dyn ToSql>).collect(), &mut p);
    }
    if skip != Skip::Tag && !f.tag_ids.is_empty() {
        let q = vec!["?"; f.tag_ids.len()].join(",");
        push(format!("EXISTS (SELECT 1 FROM recording_tag x WHERE x.recording_id = r.id AND x.tag_id IN ({q}))"),
            f.tag_ids.iter().map(|v| Box::new(*v) as Box<dyn ToSql>).collect(), &mut p);
    }
    if let Some([s, wst, n, e]) = f.bbox {
        let lon_cond = if wst <= e { format!("{POS_LON} BETWEEN ? AND ?") } else { format!("({POS_LON} >= ? OR {POS_LON} <= ?)") };
        push(format!("({POS_LAT} BETWEEN ? AND ? AND {lon_cond})"),
            vec![Box::new(s), Box::new(n), Box::new(wst), Box::new(e)], &mut p);
    }
    match f.has_position {
        Some(true) => push(format!("{POS_LAT} IS NOT NULL"), vec![], &mut p),
        Some(false) => push(format!("{POS_LAT} IS NULL"), vec![], &mut p),
        None => {}
    }
    if f.unassigned { push("(r.site_id IS NULL OR r.device_id IS NULL)".into(), vec![], &mut p); }
    if f.no_site { push("r.site_id IS NULL".into(), vec![], &mut p); }
    if skip != Skip::Period && skip != Skip::Time {
        if let Some(d) = &f.local_day_from { push(format!("{LOCAL_DAY} >= ?"), vec![Box::new(d.clone())], &mut p); }
        if let Some(d) = &f.local_day_to { push(format!("{LOCAL_DAY} <= ?"), vec![Box::new(d.clone())], &mut p); }
        if let Some(v) = f.from_ms { push("r.start_ms >= ?".into(), vec![Box::new(v)], &mut p); }
        if let Some(v) = f.to_ms { push("r.start_ms < ?".into(), vec![Box::new(v)], &mut p); }
    }
    if let (Some(a), Some(b), true) = (f.hour_from, f.hour_to, skip != Skip::Hour && skip != Skip::Time) {
        let (a, b) = (a as i64, b as i64);
        let op = if a <= b { "AND" } else { "OR" };
        push(format!("({LOCAL_HOUR} >= ? {op} {LOCAL_HOUR} < ?)"), vec![Box::new(a), Box::new(b)], &mut p);
    }
    if let Some(s) = &f.path_contains {
        // Every word must occur somewhere in the path ("sk17 01_01"), in any order.
        for w in s.split_whitespace() {
            push("a.rel_path LIKE ? ESCAPE '\\'".into(),
                vec![Box::new(format!("%{}%", w.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")))], &mut p);
        }
    }
    match f.has_labels {
        Some(true) => push("EXISTS (SELECT 1 FROM label l WHERE l.recording_id = r.id)".into(), vec![], &mut p),
        Some(false) => push("NOT EXISTS (SELECT 1 FROM label l WHERE l.recording_id = r.id)".into(), vec![], &mut p),
        None => {}
    }
    if let Some(d) = &f.detection {
        let mut cond = "EXISTS (SELECT 1 FROM detection d WHERE d.recording_id = r.id AND d.class = ? AND d.score >= ?".to_string();
        let mut vals: Vec<Box<dyn ToSql>> = vec![Box::new(d.class.clone()), Box::new(d.min_score)];
        if let Some(run) = d.run_id { cond += " AND d.run_id = ?"; vals.push(Box::new(run)); }
        cond += ")";
        push(cond, vals, &mut p);
    }
    if f.no_start { push("r.start_ms IS NULL".into(), vec![], &mut p); }
    if let Some(st) = &f.status { push("a.status = ?".into(), vec![Box::new(st.clone())], &mut p); }
    match f.review.as_deref() {
        Some("new") => push("r.review IS NULL".into(), vec![], &mut p),
        Some("todo") => push("r.review IS NOT 'done'".into(), vec![], &mut p),
        Some(st @ ("open" | "done")) => push("r.review = ?".into(), vec![Box::new(st.to_string())], &mut p),
        Some(other) => return Err(format!("unknown review state {other}").into()),
        None => {}
    }
    if let Some(sw) = &f.sun {
        let (a, b) = (sw.from.event.as_str(), sw.to.event.as_str());
        push(format!("sun_in(r.start_ms, {POS_LAT}, {POS_LON}, ?, ?, ?, ?) = 1"),
            vec![Box::new(a), Box::new(sw.from.offset_min), Box::new(b), Box::new(sw.to.offset_min)], &mut p);
    }
    if let (Some(ds), true) = (f.dataset_id, skip != Skip::Dataset) {
        if depth >= MAX_DATASET_DEPTH { return Err("datasets nested too deeply (or refer to each other)".into()); }
        let (kind, fj): (String, Option<String>) = cat.conn.query_row(
            "SELECT kind, filter_json FROM dataset WHERE id = ?1", [ds], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|_| format!("unknown dataset {ds}"))?;
        if kind == "static" {
            push("EXISTS (SELECT 1 FROM dataset_member m WHERE m.dataset_id = ? AND m.recording_id = r.id)".into(),
                vec![Box::new(ds)], &mut p);
        } else {
            let inner: Filter = serde_json::from_str(fj.as_deref().unwrap_or("{}"))?;
            let (iw, ip) = where_depth(cat, &inner, Skip::None, depth + 1)?;
            push(format!("({iw})"), ip, &mut p);
        }
    }
    Ok((w.join(" AND "), p))
}

pub(crate) const FROM: &str = "FROM recording r LEFT JOIN asset a ON a.id = r.asset_id";

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Sort { #[default] Start, Path }

/// Keyset cursor: the sort key and id of the last row of the previous page.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cursor { pub key: serde_json::Value, pub id: i64 }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub id: i64,
    pub root_id: Option<i64>,
    pub path: Option<String>,
    pub size: Option<i64>,
    pub start_ms: Option<i64>,
    pub local_offset_min: Option<i64>,
    pub duration_s: Option<f64>,
    pub site: Option<String>,
    pub device: Option<String>,
    pub labels: i64,
    pub status: Option<String>,
    /// Review state: None (new), "open", "done".
    pub review: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page { pub rows: Vec<Row>, pub next: Option<Cursor> }

pub fn list(cat: &Catalog, f: &Filter, sort: Sort, after: Option<&Cursor>, limit: usize) -> Result<Page> {
    let (mut w, mut p) = where_clause(cat, f, Skip::None)?;
    // Index-friendly keyset: SQLite sorts NULL first; NULL keys page by id alone.
    let (key, order) = match sort {
        Sort::Start => ("r.start_ms", "r.start_ms, r.id"),
        Sort::Path => ("a.rel_path", "a.rel_path, r.id"),
    };
    if let Some(c) = after {
        let k: Option<Box<dyn ToSql>> = match sort {
            Sort::Start => c.key.as_i64().map(|v| Box::new(v) as Box<dyn ToSql>),
            Sort::Path => c.key.as_str().map(|v| Box::new(v.to_string()) as Box<dyn ToSql>),
        };
        p.push(Box::new(c.id));
        let id = p.len();
        match k {
            None => w += &format!(" AND (({key} IS NULL AND r.id > ?{id}) OR {key} IS NOT NULL)"),
            Some(k) => {
                p.push(k);
                let kk = p.len();
                w += &format!(" AND ({key} > ?{kk} OR ({key} = ?{kk} AND r.id > ?{id}))");
            }
        }
    }
    let sql = format!(
        "SELECT r.id, a.root_id, a.rel_path, a.size, r.start_ms, r.local_offset_min, r.duration_s,
                (SELECT name FROM site WHERE id = r.site_id), (SELECT name FROM device WHERE id = r.device_id),
                (SELECT COUNT(*) FROM label l WHERE l.recording_id = r.id), a.status, r.review
         {FROM} WHERE {w} ORDER BY {order} LIMIT {}", limit + 1);
    let mut st = cat.conn.prepare(&sql)?;
    let mut rows: Vec<Row> = st.query_map(params_from_iter(p.iter()), |r| Ok(Row {
        id: r.get(0)?, root_id: r.get(1)?, path: r.get(2)?, size: r.get(3)?, start_ms: r.get(4)?,
        local_offset_min: r.get(5)?, duration_s: r.get(6)?, site: r.get(7)?, device: r.get(8)?, labels: r.get(9)?,
        status: r.get(10)?, review: r.get(11)?,
    }))?.collect::<std::result::Result<_, _>>()?;
    let next = if rows.len() > limit {
        rows.truncate(limit);
        rows.last().map(|r| Cursor {
            key: match sort {
                Sort::Start => serde_json::json!(r.start_ms),
                Sort::Path => serde_json::json!(r.path),
            },
            id: r.id,
        })
    } else { None };
    Ok(Page { rows, next })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FacetValue { pub id: i64, pub name: String, pub count: i64 }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Facets {
    pub total: i64,
    pub bytes: i64,
    pub seconds: Option<f64>,
    pub first_ms: Option<i64>,
    pub last_ms: Option<i64>,
    pub no_start: i64,
    /// Reviewed recordings under the filter: opened (not done) and done.
    pub review_open: i64,
    pub review_done: i64,
    /// Counts under the filter without its own site selection (so other sites stay pickable).
    pub sites: Vec<FacetValue>,
    pub devices: Vec<FacetValue>,
    pub tags: Vec<FacetValue>,
    /// Recordings per local day, under the filter without its own period (for the date histogram).
    pub days: Vec<DayCount>,
    /// Recordings per local hour 0–23, under the filter without its own time of day.
    pub hours: Vec<i64>,
    /// Mean position [lat, lon] of the recordings with a position (own, else the site's); for sun times.
    pub center: Option<[f64; 2]>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayCount {
    pub day: String,
    pub count: i64,
    /// UTC offset of the recordings' local time that day (minutes; the largest when they differ).
    pub offset_min: Option<i64>,
}

fn facet(cat: &Catalog, f: &Filter, skip: Skip, table: &str, col: &str) -> Result<Vec<FacetValue>> {
    let (w, p) = where_clause(cat, f, skip)?;
    let sql = format!("SELECT t.id, t.name, COUNT(*) {FROM} JOIN {table} t ON t.id = r.{col} WHERE {w} GROUP BY t.id ORDER BY t.name");
    let mut st = cat.conn.prepare(&sql)?;
    let v = st.query_map(params_from_iter(p.iter()), |r| Ok(FacetValue { id: r.get(0)?, name: r.get(1)?, count: r.get(2)? }))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(v)
}

pub fn facets(cat: &Catalog, f: &Filter) -> Result<Facets> {
    let (w, p) = where_clause(cat, f, Skip::None)?;
    let sql = format!("SELECT COUNT(*), COALESCE(SUM(a.size), 0), SUM(r.duration_s), MIN(r.start_ms), MAX(r.start_ms),
        SUM(r.start_ms IS NULL), SUM(r.review = 'open'), SUM(r.review = 'done') {FROM} WHERE {w}");
    let (total, bytes, seconds, first_ms, last_ms, no_start, review_open, review_done) = cat.conn.query_row(&sql, params_from_iter(p.iter()), |r| Ok((
        r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get::<_, Option<i64>>(5)?.unwrap_or(0),
        r.get::<_, Option<i64>>(6)?.unwrap_or(0), r.get::<_, Option<i64>>(7)?.unwrap_or(0))))?;
    let mut sites = facet(cat, f, Skip::Site, "site", "site_id")?;
    let mut devices = facet(cat, f, Skip::Device, "device", "device_id")?;
    let mut tags = {
        let (w, p) = where_clause(cat, f, Skip::Tag)?;
        let sql = format!("SELECT t.id, t.name, COUNT(*) {FROM} JOIN recording_tag x ON x.recording_id = r.id JOIN tag t ON t.id = x.tag_id WHERE {w} GROUP BY t.id");
        let mut st = cat.conn.prepare(&sql)?;
        st.query_map(params_from_iter(p.iter()), |r| Ok(FacetValue { id: r.get(0)?, name: r.get(1)?, count: r.get(2)? }))?
            .collect::<std::result::Result<Vec<_>, _>>()?
    };
    // Natural order: "Standort 2" before "Standort 10".
    let nat = |a: &FacetValue, b: &FacetValue| natural_cmp(&a.name, &b.name);
    sites.sort_by(nat);
    devices.sort_by(nat);
    tags.sort_by(nat);
    let days = {
        let (w, p) = where_clause(cat, f, Skip::Period)?;
        let sql = format!("SELECT {LOCAL_DAY}, COUNT(*), MAX(r.local_offset_min) {FROM} WHERE {w} AND r.start_ms IS NOT NULL GROUP BY 1 ORDER BY 1");
        let mut st = cat.conn.prepare(&sql)?;
        st.query_map(params_from_iter(p.iter()), |r| Ok(DayCount { day: r.get(0)?, count: r.get(1)?, offset_min: r.get(2)? }))?
            .collect::<std::result::Result<Vec<_>, _>>()?
    };
    let mut hours = vec![0i64; 24];
    {
        let (w, p) = where_clause(cat, f, Skip::Hour)?;
        let sql = format!("SELECT {LOCAL_HOUR}, COUNT(*) {FROM} WHERE {w} AND r.start_ms IS NOT NULL GROUP BY 1");
        let mut st = cat.conn.prepare(&sql)?;
        for row in st.query_map(params_from_iter(p.iter()), |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))? {
            let (h, n) = row?;
            if (0..24).contains(&h) { hours[h as usize] = n; }
        }
    }
    let center = {
        let sql = format!("SELECT AVG({POS_LAT}), AVG({POS_LON}) {FROM} WHERE {w} AND {POS_LAT} IS NOT NULL");
        let (lat, lon): (Option<f64>, Option<f64>) = cat.conn.query_row(&sql, params_from_iter(p.iter()), |r| Ok((r.get(0)?, r.get(1)?)))?;
        lat.zip(lon).map(|(a, b)| [a, b])
    };
    Ok(Facets { total, bytes, seconds, first_ms, last_ms, no_start, review_open, review_done, sites, devices, tags, days, hours, center })
}

pub fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let split = |s: &str| -> Vec<(bool, String)> {
        let mut out: Vec<(bool, String)> = Vec::new();
        for c in s.chars() {
            let d = c.is_ascii_digit();
            match out.last_mut() { Some((ld, t)) if *ld == d => t.push(c), _ => out.push((d, c.to_string())) }
        }
        out
    };
    let (x, y) = (split(a), split(b));
    for (p, q) in x.iter().zip(&y) {
        let o = if p.0 && q.0 {
            // Numeric value first (length, then digits without leading zeros); padding only breaks ties.
            let (a, b) = (p.1.trim_start_matches('0'), q.1.trim_start_matches('0'));
            a.len().cmp(&b.len()).then(a.cmp(b)).then(p.1.cmp(&q.1))
        } else { p.1.to_lowercase().cmp(&q.1.to_lowercase()) };
        if o.is_ne() { return o; }
    }
    x.len().cmp(&y.len())
}

/// Number of recordings and their total duration (s) under the filter; cheaper than `facets`.
pub fn count(cat: &Catalog, f: &Filter) -> Result<(i64, Option<f64>)> {
    let (w, p) = where_clause(cat, f, Skip::None)?;
    Ok(cat.conn.query_row(&format!("SELECT COUNT(*), SUM(r.duration_s) {FROM} WHERE {w}"), params_from_iter(p.iter()), |r| Ok((r.get(0)?, r.get(1)?)))?)
}

/// All recording ids matching the filter (for bulk edits).
pub fn ids(cat: &Catalog, f: &Filter) -> Result<Vec<i64>> {
    let (w, p) = where_clause(cat, f, Skip::None)?;
    let mut st = cat.conn.prepare(&format!("SELECT r.id {FROM} WHERE {w} ORDER BY r.id"))?;
    let v = st.query_map(params_from_iter(p.iter()), |r| r.get(0))?.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(v)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeatCell { pub day: String, pub hour: i64, pub count: i64 }

/// Recordings per local day × hour (calendar heatmap).
/// Recordings per local day and hour under the filter without its period and time of day
/// (the calendar dims cells outside them, so the rest stays in view and clickable).
pub fn heatmap(cat: &Catalog, f: &Filter) -> Result<Vec<HeatCell>> {
    let (w, p) = where_clause(cat, f, Skip::Time)?;
    let sql = format!("SELECT {LOCAL_DAY}, {LOCAL_HOUR}, COUNT(*) {FROM} WHERE {w} AND r.start_ms IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2");
    let mut st = cat.conn.prepare(&sql)?;
    let v = st.query_map(params_from_iter(p.iter()), |r| Ok(HeatCell { day: r.get(0)?, hour: r.get(1)?, count: r.get(2)? }))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{import_scanned, profile_spec::{MappingSpec, ProfileSpec}, scan::ScannedFile};

    #[test]
    fn local_days_and_no_site_select_what_statistics_count() {
        let cat = fixture();
        // Recordings 2023-…; shift one to UTC−7 so its local day differs from its UTC day.
        cat.conn.execute("UPDATE recording SET local_offset_min = -420 WHERE id = 1", []).unwrap();
        let day: String = cat.conn.query_row(&format!("SELECT {LOCAL_DAY} FROM recording r WHERE r.id = 1"), [], |r| r.get(0)).unwrap();
        let f = Filter { local_day_from: Some(day.clone()), local_day_to: Some(day.clone()), ..Default::default() };
        assert!(ids(&cat, &f).unwrap().contains(&1));
        cat.conn.execute("UPDATE recording SET site_id = NULL WHERE id = 2", []).unwrap();
        let none = ids(&cat, &Filter { no_site: true, ..Default::default() }).unwrap();
        assert!(none.contains(&2));
        let with_site: i64 = cat.conn.query_row(&format!("SELECT COUNT(*) FROM recording WHERE site_id IS NOT NULL AND id IN ({})",
            none.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",")), [], |r| r.get(0)).unwrap();
        assert_eq!(with_site, 0);
    }

    #[test]
    fn natural_order_compares_values_before_padding() {
        use std::cmp::Ordering::*;
        assert_eq!(natural_cmp("Week_2", "Week_09"), Less);
        assert_eq!(natural_cmp("Week_10", "Week_9"), Greater);
        assert_eq!(natural_cmp("Week_02", "Week_2"), Less, "same value: padding breaks the tie");
    }

    #[test]
    fn local_hour_and_day_before_1970() {
        let c = Catalog::open_in_memory().unwrap();
        // 1969-12-31 23:30 local (UTC, offset 0) and one millisecond before 1970.
        for (ms, hour, day) in [(-1_800_000i64, 23i64, "1969-12-31"), (-1, 23, "1969-12-31"), (3_600_000, 1, "1970-01-01")] {
            let (h, d): (i64, String) = c.conn.query_row(
                &format!("SELECT {LOCAL_HOUR}, {LOCAL_DAY} FROM (SELECT ?1 AS start_ms, 0 AS local_offset_min) r"), [ms],
                |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
            assert_eq!((h, d.as_str()), (hour, day), "{ms}");
        }
    }

    fn fixture() -> Catalog {
        let mut cat = Catalog::open_in_memory().unwrap();
        let root = cat.add_root("r", "referenced", "m", "/x").unwrap();
        let mut files = Vec::new();
        for site in [2, 10] {
            for h in 0..24 {
                files.push(ScannedFile { rel_path: format!("S{site}/R{site}_20230313_{h:02}0000.wav"), size: 100, mtime_ms: 0 });
            }
        }
        files.push(ScannedFile { rel_path: "loose/x.wav".into(), size: 5, mtime_ms: 0 });
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
        cat
    }

    #[test]
    fn night_filter_uses_local_clock_and_wraps() {
        let cat = fixture();
        let f = Filter { hour_from: Some(20), hour_to: Some(4), ..Default::default() };
        // Local hours 20..23 and 0..3 → 8 per site.
        assert_eq!(facets(&cat, &f).unwrap().total, 16);
    }

    #[test]
    fn facets_natural_order_and_self_exclusion() {
        let cat = fixture();
        let all = facets(&cat, &Filter::default()).unwrap();
        assert_eq!(all.total, 49);
        assert_eq!(all.no_start, 1);
        let names: Vec<_> = all.sites.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["Site 2", "Site 10"]);
        let f = Filter { site_ids: vec![all.sites[0].id], ..Default::default() };
        let one = facets(&cat, &f).unwrap();
        assert_eq!(one.total, 24);
        assert_eq!(one.sites.len(), 2, "own facet ignores its selection");
        assert_eq!(one.devices.len(), 1);
    }

    #[test]
    fn day_and_hour_histograms_ignore_their_own_filter() {
        let cat = fixture();
        let all = facets(&cat, &Filter::default()).unwrap();
        let with_start = all.total - all.no_start;
        assert_eq!(all.days.iter().map(|d| d.count).sum::<i64>(), with_start);
        assert_eq!(all.hours.len(), 24);
        assert_eq!(all.hours.iter().sum::<i64>(), with_start);
        let d0 = all.days[0].day.clone();
        let busy = all.hours.iter().position(|&n| n > 0).unwrap() as u8;
        let f = Filter { local_day_from: Some(d0.clone()), local_day_to: Some(d0.clone()),
            hour_from: Some(busy), hour_to: Some(busy + 1), ..Default::default() };
        let one = facets(&cat, &f).unwrap();
        // Days still show every day (the period is their own filter), but only the chosen hour.
        assert_eq!(one.days.len(), all.days.len());
        assert!(one.days.iter().map(|d| d.count).sum::<i64>() <= all.hours[busy as usize]);
        // Hours still show every hour, but only of the chosen day.
        assert_eq!(one.hours.iter().sum::<i64>(), all.days[0].count);
        assert_eq!(one.total, one.hours[busy as usize]);
    }

    #[test]
    fn keyset_paging_visits_every_row_once() {
        let cat = fixture();
        for sort in [Sort::Start, Sort::Path] {
            let (mut seen, mut cur) = (Vec::new(), None);
            loop {
                let page = list(&cat, &Filter::default(), sort, cur.as_ref(), 10).unwrap();
                seen.extend(page.rows.iter().map(|r| r.id));
                match page.next { Some(c) => cur = Some(c), None => break }
            }
            let mut s = seen.clone();
            s.sort();
            s.dedup();
            assert_eq!((seen.len(), s.len()), (49, 49));
        }
    }

    #[test]
    fn path_filter_escapes_like_wildcards() {
        let cat = fixture();
        assert_eq!(facets(&cat, &Filter { path_contains: Some("loose".into()), ..Default::default() }).unwrap().total, 1);
        assert_eq!(facets(&cat, &Filter { path_contains: Some("%".into()), ..Default::default() }).unwrap().total, 0);
    }

    #[test]
    fn path_filter_words_all_match_in_any_order() {
        let cat = fixture();
        let n = |q: &str| facets(&cat, &Filter { path_contains: Some(q.into()), ..Default::default() }).unwrap().total;
        let one_site = n("S2/");
        assert_eq!(one_site, 24);
        assert_eq!(n("S2/ _050000"), 1, "both words");
        assert_eq!(n("_050000 S2/"), 1, "any order");
        assert_eq!(n("  "), 49, "blank = no filter");
        assert_eq!(n("S2/ loose"), 0);
    }

    #[test]
    fn heatmap_is_local_day_hour() {
        let cat = fixture();
        let h = heatmap(&cat, &Filter::default()).unwrap();
        assert_eq!(h.iter().map(|c| c.count).sum::<i64>(), 48);
        assert_eq!(h[0].day, "2023-03-13");
        assert_eq!(h[0].hour, 0);
        // Period and time of day do not narrow the calendar (it dims instead); other filters do.
        let f = Filter { local_day_from: Some("2023-03-14".into()), hour_from: Some(3), hour_to: Some(4), ..Default::default() };
        assert_eq!(heatmap(&cat, &f).unwrap().iter().map(|c| c.count).sum::<i64>(), 48);
        let f = Filter { path_contains: Some("loose".into()), ..Default::default() };
        assert!(heatmap(&cat, &f).unwrap().iter().map(|c| c.count).sum::<i64>() < 48);
    }

    #[test]
    fn facets_center_and_day_offsets() {
        let cat = fixture();
        assert!(facets(&cat, &Filter::default()).unwrap().center.is_none(), "fixture has no positions");
        cat.conn.execute("UPDATE recording SET lat = 52.0, lon = 8.0 WHERE id = 1", []).unwrap();
        cat.conn.execute("UPDATE recording SET lat = 54.0, lon = 10.0, local_offset_min = 120 WHERE id = 2", []).unwrap();
        let f = facets(&cat, &Filter::default()).unwrap();
        assert_eq!(f.center, Some([53.0, 9.0]));
        assert!(f.days.iter().any(|d| d.offset_min == Some(120)));
    }
}
