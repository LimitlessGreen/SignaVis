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
    /// UTC ms, inclusive / exclusive.
    pub from_ms: Option<i64>,
    pub to_ms: Option<i64>,
    /// Local time of day, hours 0–23; `hour_from > hour_to` wraps over midnight (night).
    pub hour_from: Option<u8>,
    pub hour_to: Option<u8>,
    pub path_contains: Option<String>,
    pub has_labels: Option<bool>,
    pub detection: Option<DetectionFilter>,
    pub no_start: bool,
}

const LOCAL_HOUR: &str = "(((r.start_ms + COALESCE(r.local_offset_min, 0) * 60000) / 3600000) % 24)";
const LOCAL_DAY: &str = "date((r.start_ms + COALESCE(r.local_offset_min, 0) * 60000) / 1000, 'unixepoch')";

#[derive(Clone, Copy, PartialEq)]
enum Skip { None, Site, Device }

fn where_clause(f: &Filter, skip: Skip) -> (String, Vec<Box<dyn ToSql>>) {
    let mut w: Vec<String> = vec!["1".into()];
    let mut p: Vec<Box<dyn ToSql>> = Vec::new();
    let mut push = |cond: String, vals: Vec<Box<dyn ToSql>>, p: &mut Vec<Box<dyn ToSql>>| {
        // Number the `?` placeholders in order (a replaced `?N` must not be matched again).
        let mut parts = cond.split('?');
        let mut out = parts.next().unwrap_or("").to_string();
        let mut vals = vals.into_iter();
        for part in parts {
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
    if let Some(v) = f.from_ms { push("r.start_ms >= ?".into(), vec![Box::new(v)], &mut p); }
    if let Some(v) = f.to_ms { push("r.start_ms < ?".into(), vec![Box::new(v)], &mut p); }
    if let (Some(a), Some(b)) = (f.hour_from, f.hour_to) {
        let (a, b) = (a as i64, b as i64);
        let op = if a <= b { "AND" } else { "OR" };
        push(format!("({LOCAL_HOUR} >= ? {op} {LOCAL_HOUR} < ?)"), vec![Box::new(a), Box::new(b)], &mut p);
    }
    if let Some(s) = &f.path_contains {
        push("a.rel_path LIKE ? ESCAPE '\\'".into(),
            vec![Box::new(format!("%{}%", s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")))], &mut p);
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
    (w.join(" AND "), p)
}

const FROM: &str = "FROM recording r LEFT JOIN asset a ON a.id = r.asset_id";

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
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page { pub rows: Vec<Row>, pub next: Option<Cursor> }

pub fn list(cat: &Catalog, f: &Filter, sort: Sort, after: Option<&Cursor>, limit: usize) -> Result<Page> {
    let (mut w, mut p) = where_clause(f, Skip::None);
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
                (SELECT COUNT(*) FROM label l WHERE l.recording_id = r.id)
         {FROM} WHERE {w} ORDER BY {order} LIMIT {}", limit + 1);
    let mut st = cat.conn.prepare(&sql)?;
    let mut rows: Vec<Row> = st.query_map(params_from_iter(p.iter()), |r| Ok(Row {
        id: r.get(0)?, root_id: r.get(1)?, path: r.get(2)?, size: r.get(3)?, start_ms: r.get(4)?,
        local_offset_min: r.get(5)?, duration_s: r.get(6)?, site: r.get(7)?, device: r.get(8)?, labels: r.get(9)?,
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
    /// Counts under the filter without its own site selection (so other sites stay pickable).
    pub sites: Vec<FacetValue>,
    pub devices: Vec<FacetValue>,
}

fn facet(cat: &Catalog, f: &Filter, skip: Skip, table: &str, col: &str) -> Result<Vec<FacetValue>> {
    let (w, p) = where_clause(f, skip);
    let sql = format!("SELECT t.id, t.name, COUNT(*) {FROM} JOIN {table} t ON t.id = r.{col} WHERE {w} GROUP BY t.id ORDER BY t.name");
    let mut st = cat.conn.prepare(&sql)?;
    let v = st.query_map(params_from_iter(p.iter()), |r| Ok(FacetValue { id: r.get(0)?, name: r.get(1)?, count: r.get(2)? }))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(v)
}

pub fn facets(cat: &Catalog, f: &Filter) -> Result<Facets> {
    let (w, p) = where_clause(f, Skip::None);
    let sql = format!("SELECT COUNT(*), COALESCE(SUM(a.size), 0), SUM(r.duration_s), MIN(r.start_ms), MAX(r.start_ms),
        SUM(r.start_ms IS NULL) {FROM} WHERE {w}");
    let (total, bytes, seconds, first_ms, last_ms, no_start) = cat.conn.query_row(&sql, params_from_iter(p.iter()), |r| Ok((
        r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get::<_, Option<i64>>(5)?.unwrap_or(0))))?;
    let mut sites = facet(cat, f, Skip::Site, "site", "site_id")?;
    let mut devices = facet(cat, f, Skip::Device, "device", "device_id")?;
    // Natural order: "Standort 2" before "Standort 10".
    let nat = |a: &FacetValue, b: &FacetValue| natural_cmp(&a.name, &b.name);
    sites.sort_by(nat);
    devices.sort_by(nat);
    Ok(Facets { total, bytes, seconds, first_ms, last_ms, no_start, sites, devices })
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
            p.1.trim_start_matches('0').len().cmp(&q.1.trim_start_matches('0').len()).then(p.1.cmp(&q.1))
        } else { p.1.to_lowercase().cmp(&q.1.to_lowercase()) };
        if o.is_ne() { return o; }
    }
    x.len().cmp(&y.len())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeatCell { pub day: String, pub hour: i64, pub count: i64 }

/// Recordings per local day × hour (calendar heatmap).
pub fn heatmap(cat: &Catalog, f: &Filter) -> Result<Vec<HeatCell>> {
    let (w, p) = where_clause(f, Skip::None);
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
    fn heatmap_is_local_day_hour() {
        let cat = fixture();
        let h = heatmap(&cat, &Filter::default()).unwrap();
        assert_eq!(h.iter().map(|c| c.count).sum::<i64>(), 48);
        assert_eq!(h[0].day, "2023-03-13");
        assert_eq!(h[0].hour, 0);
    }
}
