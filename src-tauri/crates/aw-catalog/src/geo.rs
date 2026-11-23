//! Positions: per recording (mobile recorders, GPS in the file header, phone apps), GPS tracks
//! matched to recordings by time, and what the library map shows.
//!
//! A recording's own position wins over its site's coordinates. Origins, strongest first:
//! `manual` > `header` (GUANO `Loc Position`, written by the recorder) > `track` (GPX by time).
//! A weaker source never overwrites a stronger one.

use crate::{Catalog, Result, entities::Selection, new_uid, now_ms, query};
use rusqlite::{OptionalExtension, params, params_from_iter};
use serde::{Deserialize, Serialize};

pub const ORIGINS: [&str; 3] = ["manual", "header", "track"];

fn rank(origin: Option<&str>) -> usize {
    origin.and_then(|o| ORIGINS.iter().position(|x| *x == o)).map_or(usize::MAX, |i| i)
}

/// SQL guard: may a write with `origin` replace the stored position? (?N = origin rank).
fn may_replace(origin: &str) -> String {
    let r = rank(Some(origin));
    let stronger: Vec<String> = ORIGINS.iter().take(r).map(|o| format!("'{o}'")).collect();
    if stronger.is_empty() { "1".into() } else { format!("(pos_origin IS NULL OR pos_origin NOT IN ({}))", stronger.join(",")) }
}

/// "52.1234 10.5678" (GUANO, space) or "52.1, 10.5" → (lat, lon).
pub fn parse_lat_lon(s: &str) -> Option<(f64, f64)> {
    let mut it = s.split(|c: char| c == ',' || c == ';' || c.is_whitespace()).filter(|x| !x.is_empty());
    let lat: f64 = it.next()?.parse().ok()?;
    let lon: f64 = it.next()?.parse().ok()?;
    if it.next().is_some() || !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) { return None; }
    Some((lat, lon))
}

/// Take positions from header metadata (`guano:Loc Position`, `guano:Loc Elevation`) into the
/// recording columns. Returns how many recordings got a position.
pub fn positions_from_header(cat: &mut Catalog) -> Result<usize> {
    let tx = cat.conn.transaction()?;
    let n = header_positions(&tx, None)?;
    tx.commit()?;
    Ok(n)
}

/// Header positions of these recordings (None = all), inside the caller's transaction.
pub(crate) fn header_positions(conn: &rusqlite::Connection, ids: Option<&[i64]>) -> Result<usize> {
    let only = ids.map(|v| format!(" AND m.recording_id IN ({})", v.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",")))
        .unwrap_or_default();
    let rows: Vec<(i64, String, Option<String>)> = {
        let mut st = conn.prepare(&format!(
            "SELECT m.recording_id, m.value, (SELECT value FROM meta e WHERE e.recording_id = m.recording_id AND e.key = 'guano:Loc Elevation')
             FROM meta m JOIN recording r ON r.id = m.recording_id
             WHERE m.key = 'guano:Loc Position' AND {}{only}", may_replace("header").replace("pos_origin", "r.pos_origin")))?;
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<std::result::Result<_, _>>()?
    };
    let mut n = 0;
    // A header position replaces a track position: the track no longer explains it.
    let mut up = conn.prepare("UPDATE recording SET lat = ?2, lon = ?3, alt = ?4, pos_accuracy_m = NULL, pos_origin = 'header', track_id = NULL WHERE id = ?1")?;
    for (id, pos, elev) in rows {
        let Some((lat, lon)) = parse_lat_lon(&pos) else { continue };
        let alt = elev.and_then(|e| e.trim().parse::<f64>().ok());
        n += up.execute(params![id, lat, lon, alt])?;
    }
    Ok(n)
}

// ── Tracks ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TrackPoint { pub t_ms: i64, pub lat: f64, pub lon: f64, pub alt: Option<f64> }

/// Points of all `<trkpt>` (and `<rtept>`) with a time, sorted by time, plus how many were
/// dropped: without a time (useless for matching) and with coordinates out of range.
pub fn parse_gpx(text: &str) -> Result<(Vec<TrackPoint>, usize, usize)> {
    let doc = roxmltree::Document::parse(text)?;
    let mut pts = Vec::new();
    let (mut untimed, mut invalid) = (0, 0);
    for n in doc.descendants().filter(|n| matches!(n.tag_name().name(), "trkpt" | "rtept")) {
        let (Some(lat), Some(lon)) = (n.attribute("lat").and_then(|v| v.parse::<f64>().ok()), n.attribute("lon").and_then(|v| v.parse::<f64>().ok()))
            else { invalid += 1; continue };
        if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) { invalid += 1; continue; }
        let child = |name: &str| n.children().find(|c| c.tag_name().name() == name).and_then(|c| c.text()).map(str::trim);
        let Some(t) = child("time").and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()) else { untimed += 1; continue };
        pts.push(TrackPoint { t_ms: t.timestamp_millis(), lat, lon, alt: child("ele").and_then(|e| e.parse().ok()) });
    }
    pts.sort_by_key(|p| p.t_ms);
    Ok((pts, untimed, invalid))
}

pub fn save_track(cat: &mut Catalog, name: &str, source: Option<&str>, device_id: Option<i64>, pts: &[TrackPoint]) -> Result<i64> {
    if pts.is_empty() { return Err("the track has no points with a time".into()); }
    let tx = cat.conn.transaction()?;
    tx.execute("INSERT INTO track(uid, name, source, device_id, start_ms, end_ms, n_points, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![new_uid(), name, source, device_id, pts[0].t_ms, pts[pts.len() - 1].t_ms, pts.len() as i64, now_ms()])?;
    let id = tx.last_insert_rowid();
    {
        let mut ins = tx.prepare("INSERT INTO track_point(track_id, t_ms, lat, lon, alt) VALUES (?1, ?2, ?3, ?4, ?5)")?;
        for p in pts { ins.execute(params![id, p.t_ms, p.lat, p.lon, p.alt])?; }
    }
    tx.commit()?;
    Ok(id)
}

pub fn track_points(cat: &Catalog, track_id: i64) -> Result<Vec<TrackPoint>> {
    let mut st = cat.conn.prepare("SELECT t_ms, lat, lon, alt FROM track_point WHERE track_id = ?1 ORDER BY t_ms")?;
    let v = st.query_map([track_id], |r| Ok(TrackPoint { t_ms: r.get(0)?, lat: r.get(1)?, lon: r.get(2)?, alt: r.get(3)? }))?
        .collect::<std::result::Result<_, _>>()?;
    Ok(v)
}

/// Longitude between `a` and `b` at fraction `f`, the short way (across ±180° if that is shorter).
fn lerp_lon(a: f64, b: f64, f: f64) -> f64 {
    let mut d = b - a;
    if d > 180.0 { d -= 360.0 } else if d < -180.0 { d += 360.0 }
    let x = a + f * d;
    if x > 180.0 { x - 360.0 } else if x < -180.0 { x + 360.0 } else { x }
}

/// Position at `t`: linear between the two points around it if they are at most `max_gap_ms`
/// apart, else the nearer point if it is within `max_gap_ms`.
pub fn position_at(pts: &[TrackPoint], t: i64, max_gap_ms: i64) -> Option<TrackPoint> {
    if pts.is_empty() { return None; }
    let i = pts.partition_point(|p| p.t_ms < t);
    let after = pts.get(i);
    let before = i.checked_sub(1).and_then(|j| pts.get(j));
    match (before, after) {
        (_, Some(a)) if a.t_ms == t => Some(*a),
        (Some(b), Some(a)) if a.t_ms - b.t_ms <= max_gap_ms => {
            let f = (t - b.t_ms) as f64 / (a.t_ms - b.t_ms) as f64;
            let alt = match (b.alt, a.alt) { (Some(x), Some(y)) => Some(x + f * (y - x)), (x, y) => x.or(y) };
            Some(TrackPoint { t_ms: t, lat: b.lat + f * (a.lat - b.lat), lon: lerp_lon(b.lon, a.lon, f), alt })
        }
        (b, a) => [b, a].into_iter().flatten().filter(|p| (p.t_ms - t).abs() <= max_gap_ms)
            .min_by_key(|p| (p.t_ms - t).abs()).copied(),
    }
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchReport {
    /// Recordings in the track's time span (of the selection).
    pub candidates: usize,
    pub positioned: usize,
    /// Kept their stronger position (manual / header).
    pub kept: usize,
    /// In the time span, but no track point near enough.
    pub too_far: usize,
}

/// Give recordings a position from a track, at the middle of each recording (start if its
/// duration is unknown). Only recordings of the selection whose time lies in the track's span.
pub fn match_track(cat: &mut Catalog, track_id: i64, sel: &Selection, max_gap_s: f64) -> Result<MatchReport> {
    let pts = track_points(cat, track_id)?;
    let (t0, t1) = match (pts.first(), pts.last()) { (Some(a), Some(b)) => (a.t_ms, b.t_ms), _ => return Ok(MatchReport::default()) };
    let gap = (max_gap_s * 1000.0) as i64;   // `as` saturates; the window bounds below too
    let (lo, hi) = (t0.saturating_sub(gap), t1.saturating_add(gap));
    let ids = crate::entities::selected_ids(cat, sel)?;
    let tx = cat.conn.transaction()?;
    let mut rep = MatchReport::default();
    {
        let mut get = tx.prepare("SELECT start_ms + CAST(COALESCE(duration_s, 0) * 500 AS INTEGER), pos_origin FROM recording WHERE id = ?1 AND start_ms IS NOT NULL")?;
        let mut up = tx.prepare("UPDATE recording SET lat = ?2, lon = ?3, alt = ?4, pos_accuracy_m = NULL, pos_origin = 'track', track_id = ?5 WHERE id = ?1")?;
        for id in ids {
            let Some((t, origin)) = get.query_row([id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?))).optional()? else { continue };
            if t < lo || t > hi { continue; }
            rep.candidates += 1;
            if rank(origin.as_deref()) < rank(Some("track")) { rep.kept += 1; continue; }
            match position_at(&pts, t, gap) {
                Some(p) => { up.execute(params![id, p.lat, p.lon, p.alt, track_id])?; rep.positioned += 1; }
                None => rep.too_far += 1,
            }
        }
    }
    tx.commit()?;
    Ok(rep)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackInfo {
    pub id: i64, pub name: String, pub device: Option<String>, pub start_ms: i64, pub end_ms: i64,
    pub n_points: i64, pub recordings: i64,
}

pub fn tracks(cat: &Catalog) -> Result<Vec<TrackInfo>> {
    let mut st = cat.conn.prepare(
        "SELECT t.id, t.name, d.name, t.start_ms, t.end_ms, t.n_points, (SELECT COUNT(*) FROM recording r WHERE r.track_id = t.id)
         FROM track t LEFT JOIN device d ON d.id = t.device_id ORDER BY t.start_ms")?;
    let v = st.query_map([], |r| Ok(TrackInfo { id: r.get(0)?, name: r.get(1)?, device: r.get(2)?, start_ms: r.get(3)?, end_ms: r.get(4)?,
        n_points: r.get(5)?, recordings: r.get(6)? }))?.collect::<std::result::Result<_, _>>()?;
    Ok(v)
}

/// Delete a track; recordings positioned from it lose that position.
pub fn delete_track(cat: &mut Catalog, track_id: i64) -> Result<()> {
    let tx = cat.conn.transaction()?;
    tx.execute("UPDATE recording SET lat = NULL, lon = NULL, alt = NULL, pos_origin = NULL, track_id = NULL WHERE track_id = ?1 AND pos_origin = 'track'", [track_id])?;
    tx.execute("UPDATE recording SET track_id = NULL WHERE track_id = ?1", [track_id])?;
    tx.execute("DELETE FROM track WHERE id = ?1", [track_id])?;
    tx.commit()?;
    Ok(())
}

/// Set (Some) or clear (None) the position of the selected recordings by hand.
pub fn set_positions(cat: &mut Catalog, sel: &Selection, pos: Option<(f64, f64)>) -> Result<usize> {
    if let Some((lat, lon)) = pos {
        if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) { return Err("coordinates out of range".into()); }
    }
    let ids = crate::entities::selected_ids(cat, sel)?;
    let tx = cat.conn.transaction()?;
    let n = set_positions_in(&tx, &ids, pos)?;
    tx.commit()?;
    Ok(n)
}

/// Positions of these recordings inside the caller's transaction (`pos` already validated).
pub(crate) fn set_positions_in(conn: &rusqlite::Connection, ids: &[i64], pos: Option<(f64, f64)>) -> Result<usize> {
    let mut n = 0;
    let mut up = conn.prepare("UPDATE recording SET lat = ?2, lon = ?3, alt = NULL, pos_accuracy_m = NULL, pos_origin = ?4, track_id = NULL WHERE id = ?1")?;
    for &id in ids { n += up.execute(params![id, pos.map(|p| p.0), pos.map(|p| p.1), pos.map(|_| "manual")])?; }
    Ok(n)
}

// ── Map ──────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapSite { pub id: i64, pub name: String, pub lat: f64, pub lon: f64, pub recordings: i64 }

/// Recordings with their own position, binned on a grid (cell size in degrees).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapCell { pub lat: f64, pub lon: f64, pub recordings: i64, pub first_ms: Option<i64>, pub last_ms: Option<i64> }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapData {
    /// Sites with coordinates, counting filtered recordings that have no own position.
    pub sites: Vec<MapSite>,
    pub cells: Vec<MapCell>,
    pub cell_deg: f64,
    /// Filtered recordings without any position (neither own nor site).
    pub without_position: i64,
    pub with_own_position: i64,
}

/// Most position cells the map gets in one answer.
const MAX_CELLS: i64 = 20_000;

pub fn map_data(cat: &Catalog, f: &query::Filter, cell_deg: f64) -> Result<MapData> { map_data_max(cat, f, cell_deg, MAX_CELLS) }

fn map_data_max(cat: &Catalog, f: &query::Filter, cell_deg: f64, max_cells: i64) -> Result<MapData> {
    let cell = if cell_deg > 0.0 { cell_deg } else { 0.001 };
    let (w, p) = query::where_clause(cat, f, query::Skip::None)?;
    let from = query::FROM;
    let mut st = cat.conn.prepare(&format!(
        "SELECT s.id, s.name, s.lat, s.lon, COUNT(*) {from} JOIN site s ON s.id = r.site_id
         WHERE {w} AND r.lat IS NULL AND s.lat IS NOT NULL GROUP BY s.id"))?;
    let mut sites: Vec<MapSite> = st.query_map(params_from_iter(p.iter()), |r| Ok(MapSite {
        id: r.get(0)?, name: r.get(1)?, lat: r.get(2)?, lon: r.get(3)?, recordings: r.get(4)? }))?
        .collect::<std::result::Result<_, _>>()?;
    sites.sort_by(|a, b| query::natural_cmp(&a.name, &b.name));
    // At most MAX_CELLS markers: a coarser grid until every recording with a position is in one.
    let mut cell = cell;
    let group = |c: f64| format!("GROUP BY CAST(r.lat / {c} + 1e7 AS INTEGER), CAST(r.lon / {c} + 1e7 AS INTEGER)");
    for _ in 0..40 {
        let n: i64 = cat.conn.query_row(&format!("SELECT COUNT(*) FROM (SELECT 1 {from} WHERE {w} AND r.lat IS NOT NULL {})", group(cell)),
            params_from_iter(p.iter()), |r| r.get(0))?;
        if n <= max_cells { break; }
        cell *= 2.0;
    }
    let mut st = cat.conn.prepare(&format!(
        "SELECT AVG(r.lat), AVG(r.lon), COUNT(*), MIN(r.start_ms), MAX(r.start_ms) {from}
         WHERE {w} AND r.lat IS NOT NULL {}", group(cell)))?;
    let cells: Vec<MapCell> = st.query_map(params_from_iter(p.iter()), |r| Ok(MapCell {
        lat: r.get(0)?, lon: r.get(1)?, recordings: r.get(2)?, first_ms: r.get(3)?, last_ms: r.get(4)? }))?
        .collect::<std::result::Result<_, _>>()?;
    let (without_position, with_own_position): (i64, i64) = cat.conn.query_row(&format!(
        "SELECT COALESCE(SUM(r.lat IS NULL AND (r.site_id IS NULL OR (SELECT lat FROM site WHERE id = r.site_id) IS NULL)), 0),
                COALESCE(SUM(r.lat IS NOT NULL), 0) {from} WHERE {w}"), params_from_iter(p.iter()), |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(MapData { sites, cells, cell_deg: cell, without_position, with_own_position })
}

/// Track line for the map, thinned to at most `max_points` (first and last point always in, for 2 or more).
pub fn track_line(cat: &Catalog, track_id: i64, max_points: usize) -> Result<Vec<[f64; 2]>> {
    let pts = track_points(cat, track_id)?;
    Ok(thin(&pts, max_points).map(|p| [p.lat, p.lon]).collect())
}

fn thin(pts: &[TrackPoint], max: usize) -> impl Iterator<Item = &TrackPoint> {
    let n = pts.len();
    let m = max.min(n);
    (0..m).map(move |i| if m == n { &pts[i] } else if m == 1 { &pts[0] } else { &pts[i * (n - 1) / (m - 1)] })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::tests::fixture;
    use crate::query::{Filter, facets};

    const GPX: &str = r#"<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
      <trk><trkseg>
        <trkpt lat="52.0" lon="8.0"><ele>100</ele><time>2023-03-13T19:00:00Z</time></trkpt>
        <trkpt lat="52.1" lon="8.2"><ele>110</ele><time>2023-03-13T21:00:00Z</time></trkpt>
        <trkpt lat="53.0" lon="9.0"><time>2023-03-14T09:00:00Z</time></trkpt>
        <trkpt lat="50.0" lon="7.0"/>
      </trkseg></trk></gpx>"#;

    #[test]
    fn header_gps_applies_to_its_batch_and_replaces_a_track_position() {
        use crate::header::{AudioInfo, store_infos};
        let mut cat = fixture();
        let ids: Vec<i64> = cat.conn.prepare("SELECT id FROM recording ORDER BY id LIMIT 2").unwrap()
            .query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
        // The second recording already has a GUANO position in its metadata but is not in this batch.
        cat.conn.execute("INSERT INTO meta(recording_id, key, value, origin) VALUES (?1, 'guano:Loc Position', '50 7', 'header')", [ids[1]]).unwrap();
        cat.conn.execute("UPDATE recording SET lat = 1, lon = 1, pos_origin = 'track', track_id = 9 WHERE id = ?1", [ids[0]]).unwrap();
        let info = AudioInfo { sample_rate: Some(48000), meta: vec![("guano:Loc Position".into(), "52.5 13.4".into())], ..Default::default() };
        store_infos(&mut cat, &[(ids[0], Ok(info))]).unwrap();
        let (lat, origin, track): (f64, String, Option<i64>) = cat.conn.query_row(
            "SELECT lat, pos_origin, track_id FROM recording WHERE id = ?1", [ids[0]], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!((lat, origin.as_str(), track), (52.5, "header", None));
        let other: Option<f64> = cat.conn.query_row("SELECT lat FROM recording WHERE id = ?1", [ids[1]], |r| r.get(0)).unwrap();
        assert_eq!(other, None, "only the batch read now");
    }

    #[test]
    fn gpx_points_sorted_untimed_dropped() {
        let (p, untimed, invalid) = parse_gpx(GPX).unwrap();
        assert_eq!(invalid, 0);
        assert_eq!((p.len(), untimed), (3, 1));
        assert_eq!(p[0].alt, Some(100.0));
        assert!(parse_gpx("<gpx><trk>").is_err());
    }

    #[test]
    fn position_interpolates_within_gap_only() {
        let (p, _, _) = parse_gpx(GPX).unwrap();
        let t = |h: u32| chrono::NaiveDate::from_ymd_opt(2023, 3, 13).unwrap().and_hms_opt(h, 0, 0).unwrap().and_utc().timestamp_millis();
        let mid = position_at(&p, t(20), 3 * 3_600_000).unwrap();
        assert!((mid.lat - 52.05).abs() < 1e-9 && (mid.lon - 8.1).abs() < 1e-9 && mid.alt == Some(105.0));
        // 21:00 → 09:00 is 12 h apart: with a 1 h gap only the near end counts.
        assert_eq!(position_at(&p, t(21) + 1_800_000, 3_600_000).unwrap().lat, 52.1);
        assert!(position_at(&p, t(23), 3_600_000).is_none());
        assert!(position_at(&p, t(17), 3_600_000).is_none(), "before the track");
    }

    #[test]
    fn lat_lon_text() {
        assert_eq!(parse_lat_lon("52.1234 10.5678"), Some((52.1234, 10.5678)));
        assert_eq!(parse_lat_lon(" -33.9, 18.4 "), Some((-33.9, 18.4)));
        assert_eq!(parse_lat_lon("95 10"), None);
        assert_eq!(parse_lat_lon("52 10 3"), None);
    }

    #[test]
    fn track_positions_respect_stronger_origins_and_map_counts() {
        let mut cat = fixture();
        // Recordings start 20:00–22:00 local (UTC+1) → 19:00–21:00 UTC on 13 March, 1 h long → middle 19:30–21:30.
        let (pts, _, _) = parse_gpx(GPX).unwrap();
        let tr = save_track(&mut cat, "walk", Some("walk.gpx"), None, &pts).unwrap();
        // One recording has a manual position, one a header position.
        let ids = crate::query::ids(&cat, &Filter::default()).unwrap();
        set_positions(&mut cat, &Selection { ids: Some(vec![ids[0]]), filter: None }, Some((1.0, 2.0))).unwrap();
        cat.conn.execute("INSERT INTO meta(recording_id, key, value, origin) VALUES (?1, 'guano:Loc Position', '48.5 11.25', 'header')", [ids[1]]).unwrap();
        assert_eq!(positions_from_header(&mut cat).unwrap(), 1);
        let r = match_track(&mut cat, tr, &Selection::default(), 3.0 * 3600.0).unwrap();
        // Day 13 of both sites (6 recordings) lies in the track; 14 March 20:00 UTC+1 is 11 h after the last point.
        assert_eq!((r.candidates, r.kept, r.positioned, r.too_far), (6, 2, 4, 0));
        let (lat, origin): (f64, String) = cat.conn.query_row("SELECT lat, pos_origin FROM recording WHERE id = ?1", [ids[1]], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((lat, origin.as_str()), (48.5, "header"));
        // A header position must not replace a manual one.
        cat.conn.execute("INSERT INTO meta(recording_id, key, value, origin) VALUES (?1, 'guano:Loc Position', '40 10', 'header')", [ids[0]]).unwrap();
        assert_eq!(positions_from_header(&mut cat).unwrap(), 1, "only the header recording itself is rewritten");
        let lat0: f64 = cat.conn.query_row("SELECT lat FROM recording WHERE id = ?1", [ids[0]], |r| r.get(0)).unwrap();
        assert_eq!(lat0, 1.0);

        // Map: give site 1 coordinates; its recordings without own position count there.
        let s1: i64 = cat.conn.query_row("SELECT id FROM site WHERE name = 'Site 1'", [], |r| r.get(0)).unwrap();
        cat.conn.execute("UPDATE site SET lat = 52.5, lon = 13.4 WHERE id = ?1", [s1]).unwrap();
        let m = map_data(&cat, &Filter::default(), 0.5).unwrap();
        assert_eq!(m.with_own_position, 6);
        assert_eq!(m.sites.len(), 1);
        assert_eq!(m.sites[0].recordings + m.without_position + m.with_own_position, 18);
        assert_eq!(m.cells.iter().map(|c| c.recordings).sum::<i64>(), 6);
        // Area filter uses the own position first, then the site's.
        let berlin = Filter { bbox: Some([52.0, 13.0, 53.0, 14.0]), ..Default::default() };
        assert_eq!(facets(&cat, &berlin).unwrap().total, m.sites[0].recordings);
        let no_pos = Filter { has_position: Some(false), ..Default::default() };
        assert_eq!(facets(&cat, &no_pos).unwrap().total, m.without_position);

        delete_track(&mut cat, tr).unwrap();
        assert_eq!(crate::count(&cat, "SELECT COUNT(*) FROM recording WHERE pos_origin = 'track'").unwrap(), 0);
        assert_eq!(crate::count(&cat, "SELECT COUNT(*) FROM recording WHERE lat IS NOT NULL").unwrap(), 2, "manual and header stay");
    }

    #[test]
    fn header_reading_takes_the_gps_position() {
        let mut cat = fixture();
        let id: i64 = cat.conn.query_row("SELECT MIN(id) FROM recording", [], |r| r.get(0)).unwrap();
        let info = crate::header::AudioInfo {
            sample_rate: Some(48000), channels: Some(1), duration_s: Some(60.0),
            meta: vec![("guano:Loc Position".into(), "47.5 9.75".into()), ("guano:Loc Elevation".into(), "410".into())],
            ..Default::default()
        };
        crate::header::store_infos(&mut cat, &[(id, Ok(info))]).unwrap();
        let (lat, lon, alt, o): (f64, f64, f64, String) = cat.conn.query_row(
            "SELECT lat, lon, alt, pos_origin FROM recording WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap();
        assert_eq!((lat, lon, alt, o.as_str()), (47.5, 9.75, 410.0, "header"));
    }

    #[test]
    fn track_line_thins_and_keeps_ends() {
        let mut cat = fixture();
        let pts: Vec<TrackPoint> = (0..1001).map(|i| TrackPoint { t_ms: i * 1000, lat: i as f64 * 0.001, lon: 0.0, alt: None }).collect();
        let tr = save_track(&mut cat, "long", None, None, &pts).unwrap();
        let line = track_line(&cat, tr, 100).unwrap();
        assert_eq!(line.len(), 100, "the budget holds, endpoints included");
        assert_eq!(line[0][0], 0.0);
        assert!((line.last().unwrap()[0] - 1.0).abs() < 1e-9);
        assert_eq!(track_line(&cat, tr, 1).unwrap().len(), 1);
        assert!(track_line(&cat, tr, 0).unwrap().is_empty());
        assert_eq!(track_line(&cat, tr, 5000).unwrap().len(), 1001);
    }

    #[test]
    fn longitude_interpolates_across_the_antimeridian() {
        assert!((lerp_lon(179.9, -179.9, 0.5).abs() - 180.0).abs() < 1e-9);
        assert!((lerp_lon(10.0, 20.0, 0.5) - 15.0).abs() < 1e-9);
        assert!((lerp_lon(-179.0, 179.0, 0.25) - (-179.5)).abs() < 1e-9);
    }

    #[test]
    fn gpx_points_out_of_range_are_rejected() {
        let g = r#"<gpx><trk><trkseg><trkpt lat="95" lon="10"><time>2023-03-13T19:00:00Z</time></trkpt>
            <trkpt lat="52" lon="10"><time>2023-03-13T19:01:00Z</time></trkpt></trkseg></trk></gpx>"#;
        let (p, untimed, invalid) = parse_gpx(g).unwrap();
        assert_eq!((p.len(), untimed, invalid), (1, 0, 1));
    }

    #[test]
    fn a_huge_gap_does_not_overflow() {
        let mut cat = fixture();
        let pts = vec![TrackPoint { t_ms: 0, lat: 1.0, lon: 1.0, alt: None }];
        let tr = save_track(&mut cat, "t", None, None, &pts).unwrap();
        match_track(&mut cat, tr, &Selection::default(), 1e30).unwrap();
    }

    #[test]
    fn map_cells_coarsen_instead_of_dropping() {
        let cat = fixture();
        cat.conn.execute("UPDATE recording SET lat = 50 + id * 0.01, lon = 8", []).unwrap();
        let d = map_data_max(&cat, &Filter::default(), 0.001, 3).unwrap();
        assert!(d.cells.len() <= 3 && d.cell_deg > 0.001, "{} cells at {}", d.cells.len(), d.cell_deg);
        assert_eq!(d.cells.iter().map(|c| c.recordings).sum::<i64>(), d.with_own_position, "every recording is in a cell");
    }
}
